# Local Voice (Whisper STT + Piper TTS + Configurable LLM) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `PROVIDER=local` turn English Coach into a real local conversation — the learner speaks, faster-whisper transcribes, a configurable OpenAI-compatible LLM writes the coach reply, and Piper (en_US-ryan) speaks it — with no cloud key.

**Architecture:** One new `LocalSpeechProvider` on the existing `SpeechConversationProvider` seam. A resident Python sidecar (JSON lines over stdio) owns both audio models (`stt`/`tts` ops); the LLM call happens in TypeScript via the already-installed `openai` SDK pointed at a configurable `baseURL` (default: local Ollama). Pure endpoint detection in TS buffers the learner's voiced span so silence never reaches Whisper. Bridge, WS protocol, state machine, and web client are unchanged.

**Tech Stack:** TypeScript (existing monorepo, Node ≥20 <23), vitest, Python 3.10+ sidecar (faster-whisper 1.2.x int8, piper-tts 1.8.x), `openai` SDK 4.104 (already a `@ec/openai` dependency) as the OpenAI-compatible LLM client, Ollama `llama3.2:3b` as default endpoint.

**Spec:** `Docs/specs/2026-10-14-local-voice-design.md`

> ### Post-implementation amendments (2026-10-19)
>
> The plan below is the original (Piper-only) build record and is otherwise still accurate. Two changes landed after it:
>
> 1. **Selectable TTS engine.** `TTS_ENGINE=piper|kokoro` (default `piper`) is read by the sidecar at startup. Kokoro uses `KOKORO_DATA_DIR` (`data/kokoro`) + `KOKORO_VOICE` (`af_heart`) and reports **24000 Hz**; the provider already passes the engine-reported `sampleRate` through, so no TS change was needed. `kokoro-onnx` is an optional Python extra. Spec §4.1.
> 2. **Pacing corrected** in `emitPacedAudio` — see Task 5 below and spec §4.1. The original sleep-after-send loop delivered 20 ms of audio every 32 ms (ratio 0.635) and starved the client ring buffer; the shipped loop paces to an absolute deadline (ratio 1.001). A regression test pins it.

## Global Constraints

Copied from the spec — every task's requirements implicitly include this section.

- `PROVIDER=local` is **opt-in**; `mock` stays the default; the `openai` provider path is untouched.
- **No new npm dependencies.** The LLM client reuses the existing `openai` package dependency of `@ec/openai` (it speaks any OpenAI-compatible endpoint via `baseURL`). Web client is unchanged.
- Python dependencies are exactly two, in `packages/openai/requirements.txt`: `faster-whisper`, `piper-tts`.
- Whisper runs capped (anti-hallucination, verified in the design spike): `beam_size=1`, `condition_on_previous_text=False`, `no_speech_threshold=0.5`, `max_new_tokens=400`, `hallucination_silence_threshold=0.5`.
- Endpoint gate: 20 ms frames, adaptive RMS floor, turn closes on **600 ms** of silence or a 15 s cap; 300 ms minimum-voiced drops clicks. **Silence never reaches the model.** (The 600 ms figure is the spec's; a slightly larger value is acceptable if a reviewer prefers a longer tail, but the plan uses 600 to match the spec.)
- LLM client: the `openai` SDK is configured with `maxRetries: 0` so the provider's own one-shot retry is the only retry (no compounding with the SDK's built-in backoff) and failing tests stay fast.
- Piper default voice `en_US-ryan-medium`; voice files persist in the API's data dir (`data/piper` relative to the API process cwd — the spec's `apps/api/data/piper` is the same directory; the server runs with cwd `apps/api`, where `./data/english-coach.db` already lives).
- LLM defaults: `LLM_BASE_URL=http://localhost:11434/v1`, `LLM_MODEL=llama3.2:3b`, `LLM_API_KEY` empty (Ollama ignores auth; the SDK accepts an empty key — verified).
- Latency budget (CPU, measured in the spike): ~1–4 s STT + ~5 s coach text (warm 3B) + ~1–2 s TTS → **~8–15 s from the learner stopping to the coach's voice**.
- Failure contract: sidecar won't start → `closed{stt_unavailable}`; sidecar dies mid-session → `closed{voice_engine_lost}`; LLM down after one retry → `closed{coach_unavailable}` (never a fabricated coach line); Piper fails after the LLM succeeded → coach **text** still lands, audio skipped with a one-line note, session continues.
- **All `pnpm` commands run under Node 22:** `PATH="/c/Users/Hossein/tools/node22:$PATH" corepack pnpm …` (the system Node 24 breaks the better-sqlite3 native binding).
- Every git commit message ends with:
  `Co-Authored-By: Claude Code <noreply@anthropic.com>`
- The provider's `connect()` must **never reject** — the bridge calls it as `void provider.connect(cb)` with no catch, and a rejection would crash the API process (unhandled rejection). Every startup failure path ends in an emitted `closed{reason}` event instead.

## Review Focus

Five failure modes the spec implies but no single task's happy path exercises, pinned to the owning task:

1. **Python missing / sidecar dies at startup** — the user starts a session, gets a *visible* FAILED session with the reason (`stt_unavailable`), not a hang and not an API crash. → pinned in Task 4 (the sidecar manager: child emits `{"error":…}` or exits before `ready` → `ready` rejects with a `stt_unavailable` error the provider turns into `closed{stt_unavailable}`).
2. **LLM endpoint down (Ollama not running)** — the learner's transcript stays in the UI (it already landed); the coach never invents a line; one retry; then `closed{coach_unavailable}`. → pinned in Task 5 (the provider's LLM call: one retry then `closed{coach_unavailable}`, no fabricated coach line).
3. **Sidecar process killed mid-session** (OOM — realistic on this memory-pressured box; whisper small int8 + Piper hold ~1 GB RAM) — session fails exactly **once** with `voice_engine_lost`, one `session_ended` frame, no double transition, no crash. → pinned in Task 4 (the sidecar manager: child exit after `ready` fires a single `error`/`crash` event → provider emits `voice_engine_lost` exactly once via its `closed` guard).
4. **User starts a new session while the previous one's sidecar is still tearing down** — the old session's `close()` kills its Python child and suppresses any later events, so two sessions can't share or resurrect a dead sidecar. → pinned in Task 4 (the sidecar manager: `close()` kills the child, is idempotent, and subsequent `request()` calls reject).
5. **Long silence (user walks away, lid closes, mic muted)** — zero STT requests: the endpoint gate never opens a turn, so no 49-second Whisper hallucination burn and no garbage transcript rows. → pinned in Task 2 ("a silent stream never opens a turn").

---

### Task 1: `.env` loader + local provider env fields

The README's `cp .env.example .env` is currently a no-op: `loadEnv` reads `process.env` only. Without this, no local-voice setting is configurable. Side fix from the spec, and the precondition for every later task.

**Files:**
- Modify: `english-coach/apps/api/src/env.ts` (whole file — 21 lines today)
- Test: `english-coach/apps/api/tests/env.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `loadEnv(env?: NodeJS.ProcessEnv): Env` where `Env` gains `PROVIDER: "mock" | "openai" | "local"`, `LLM_BASE_URL: string` (default `http://localhost:11434/v1`), `LLM_MODEL: string` (default `llama3.2:3b`), `LLM_API_KEY: string` (default `""`), `WHISPER_MODEL: string` (default `small`), `PIPER_VOICE: string` (default `en_US-ryan-medium`), `PIPER_DATA_DIR: string` (default `data/piper`), `PYTHON: string` (default `python` — override to `python3` or a full interpreter path if `python` isn't on PATH). All six new fields are **optional** on `Env` so the existing `api.test.ts` env literals still compile. Existing fields unchanged.

- [ ] **Step 1: Write the failing test**

Create `english-coach/apps/api/tests/env.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "../src/env.js";

/** Runs `fn` with cwd pointed at a temp dir containing the given .env body. */
function withDotEnv(body: string, fn: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ec-env-"));
  try {
    writeFileSync(join(dir, ".env"), body, "utf8");
    const prev = process.cwd();
    process.chdir(dir);
    try { fn(); } finally { process.chdir(prev); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("loadEnv", () => {
  it("returns defaults when no .env file exists", () => {
    const e = loadEnv({});
    expect(e.PROVIDER).toBe("mock");
    expect(e.PORT).toBe(3100);
    expect(e.LLM_BASE_URL).toBe("http://localhost:11434/v1");
    expect(e.LLM_MODEL).toBe("llama3.2:3b");
    expect(e.LLM_API_KEY).toBe("");
    expect(e.WHISPER_MODEL).toBe("small");
    expect(e.PIPER_VOICE).toBe("en_US-ryan-medium");
    expect(e.PIPER_DATA_DIR).toBe("data/piper");
  });

  it("reads values from .env (the README's cp .env.example .env promise)", () => {
    withDotEnv("PROVIDER=local\nLLM_MODEL=qwen2.5:7b\nWHISPER_MODEL=base\n", () => {
      const e = loadEnv({});
      expect(e.PROVIDER).toBe("local");
      expect(e.LLM_MODEL).toBe("qwen2.5:7b");
      expect(e.WHISPER_MODEL).toBe("base");
    });
  });

  it("strips quotes and skips comments and blank lines", () => {
    withDotEnv('# a comment\n\nLLM_API_KEY="sk-from-file"\n', () => {
      expect(loadEnv({}).LLM_API_KEY).toBe("sk-from-file");
    });
  });

  it("process.env wins over .env", () => {
    withDotEnv("LLM_MODEL=from-file\n", () => {
      expect(loadEnv({ LLM_MODEL: "from-env" }).LLM_MODEL).toBe("from-env");
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH="/c/Users/Hossein/tools/node22:$PATH" corepack pnpm exec vitest run apps/api/tests/env.test.ts`
Expected: FAIL — the `LLM_BASE_URL` property assertions fail (`Env` has no such field; `loadEnv` ignores `.env`).

- [ ] **Step 3: Write the implementation**

Replace `english-coach/apps/api/src/env.ts` entirely with:

```ts
import { readFileSync } from "node:fs";

export interface Env {
  PORT: number;
  HOST: string;
  DB_PATH: string;
  PROVIDER: "mock" | "openai" | "local";
  OPENAI_API_KEY: string | undefined;
  WARMUP_MS: number;
  SESSION_TARGET_MS: number;
  LLM_BASE_URL?: string;
  LLM_MODEL?: string;
  LLM_API_KEY?: string;
  WHISPER_MODEL?: string;
  PIPER_VOICE?: string;
  PIPER_DATA_DIR?: string;
  PYTHON?: string;
}

/**
 * Minimal .env loader (no dependency): KEY=VALUE lines, `#` comments,
 * optional single/double quotes. Files that don't exist are a no-op;
 * real process.env values always win.
 */
function mergeDotEnv(path: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return env;
  }
  const fromFile: NodeJS.ProcessEnv = {};
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    fromFile[key] = val;
  }
  return { ...fromFile, ...env };
}

export function loadEnv(env: NodeJS.ProcessEnv = process.env): Env {
  const e = mergeDotEnv(".env", env);
  return {
    PORT: Number(e.PORT ?? 3100),
    HOST: e.HOST ?? "127.0.0.1",
    DB_PATH: e.DB_PATH ?? "./data/english-coach.db",
    PROVIDER: (e.PROVIDER as Env["PROVIDER"]) ?? "mock",
    OPENAI_API_KEY: e.OPENAI_API_KEY,
    WARMUP_MS: Number(e.WARMUP_MS ?? 120_000),
    SESSION_TARGET_MS: Number(e.SESSION_TARGET_MS ?? 900_000),
    LLM_BASE_URL: e.LLM_BASE_URL ?? "http://localhost:11434/v1",
    LLM_MODEL: e.LLM_MODEL ?? "llama3.2:3b",
    LLM_API_KEY: e.LLM_API_KEY ?? "",
    WHISPER_MODEL: e.WHISPER_MODEL ?? "small",
    PIPER_VOICE: e.PIPER_VOICE ?? "en_US-ryan-medium",
    PIPER_DATA_DIR: e.PIPER_DATA_DIR ?? "data/piper",
    PYTHON: e.PYTHON ?? "python",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH="/c/Users/Hossein/tools/node22:$PATH" corepack pnpm exec vitest run apps/api/tests/env.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck the API package (the Env union widened — breakage would show here)**

Run: `PATH="/c/Users/Hossein/tools/node22:$PATH" corepack pnpm --filter @ec/api typecheck`
Expected: PASS. If any existing code narrows `env.PROVIDER === "openai"` and then assumes `env.PROVIDER !== "local"`, fix the comparison in place — there should be none; report if you hit one.

- [ ] **Step 6: Commit**

```bash
git add english-coach/apps/api/src/env.ts english-coach/apps/api/tests/env.test.ts
git commit -m "feat(api): load .env file in loadEnv and add local-provider env fields

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: Pure endpoint detector (`endpoint.ts`)

Decides per 20 ms frame whether the learner is speaking and when their turn ends. Pure function — no I/O — so every boundary case is unit-testable with synthetic frames and a fake clock. This is also the gate that keeps silence (and Whisper's hallucination-on-silence) out of the hot path.

**Files:**
- Create: `english-coach/packages/openai/src/local/endpoint.ts`
- Test: `english-coach/packages/openai/src/local/endpoint.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface EndpointSpan { startedAt: number; endedAt: number; audio: Buffer; }
  export class VoiceEndpoint {
    constructor(opts?: { now?: () => number });
    /** Feed one PCM16 16 kHz frame (Int16 samples, little-endian bytes).
     *  Returns the learner's completed turn when its trailing 600 ms of
     *  silence (or the 15 s cap) ends it, else null. */
    push(frame: Buffer): EndpointSpan | null;
    reset(): void;
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `english-coach/packages/openai/src/local/endpoint.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { VoiceEndpoint, type EndpointSpan } from "./endpoint.js";

/** Deterministic frames: `n` little-endian int16 samples of `amp` @ 16 kHz. */
function frame(n: number, amp: number): Buffer {
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(amp, i * 2);
  return b;
}

describe("VoiceEndpoint", () => {
  it("a silent stream never opens a turn (no STT request for silence)", () => {
    const ep = new VoiceEndpoint({ now: () => 0 });
    for (let i = 0; i < 600; i++) expect(ep.push(frame(1600, 0))).toBeNull();
  });

  it("returns a span after ~600 ms of trailing silence", () => {
    let t = 1_000_000;
    const ep = new VoiceEndpoint({ now: () => t });
    const spans: ReturnType<typeof ep.push>[] = [];
    for (let i = 0; i < 10; i++) { spans.push(ep.push(frame(1600, 12000))); t += 100; } // 1 s of voice
    for (let i = 0; i < 14; i++) { const s = ep.push(frame(1600, 0)); if (s) spans.push(s); t += 100; }
    // 14 × 100 ms of silence → exactly one span, closed ~600 ms after the last voiced frame
    expect(spans.filter(Boolean)).toHaveLength(1);
    const span = spans.find(Boolean) as EndpointSpan;
    expect(span.endedAt - span.startedAt).toBeGreaterThanOrEqual(1300); // 1 s voice + the trailing-silence window before close
    expect(span.audio.length).toBe(10 * 1600 * 2); // the voiced frames only
  });

  it("keeps a turn open across a short (< 600 ms) pause, then closes it", () => {
    let t = 1_000_000;
    const ep = new VoiceEndpoint({ now: () => t });
    const spans: ReturnType<typeof ep.push>[] = [];
    // 1 s of speech, a 200 ms pause (well under 600 ms), then 0.5 s more speech,
    // then 1.4 s of silence. The pause must NOT close the turn: the resumed
    // speech is read as voiced (the noise floor never rises to the speaker's
    // own level), so the whole thing is ONE span and the audio holds all voiced frames.
    for (let i = 0; i < 10; i++) { ep.push(frame(1600, 12000)); t += 100; }
    for (let i = 0; i < 2; i++) { const s = ep.push(frame(1600, 0)); if (s) spans.push(s); t += 100; }
    for (let i = 0; i < 5; i++) { const s = ep.push(frame(1600, 12000)); if (s) spans.push(s); t += 100; }
    for (let i = 0; i < 14; i++) { const s = ep.push(frame(1600, 0)); if (s) spans.push(s); t += 100; }
    expect(spans.filter(Boolean)).toHaveLength(1); // one turn, not two
    const span = spans.find(Boolean) as EndpointSpan;
    expect(span.audio.length).toBe(15 * 1600 * 2); // 10 + 5 voiced frames, the pause excluded
  });

  it("drops clicks shorter than 300 ms of voiced audio", () => {
    let t = 0;
    const ep = new VoiceEndpoint({ now: () => t });
    for (let i = 0; i < 5; i++) { expect(ep.push(frame(1600, 0))).toBeNull(); t += 100; }
    for (let i = 0; i < 2; i++) { expect(ep.push(frame(1600, 12000))).toBeNull(); t += 100; } // 200 ms blip
    for (let i = 0; i < 30; i++) { expect(ep.push(frame(1600, 0))).toBeNull(); t += 100; }
  });

  it("closes a run-on turn at the 15 s cap", () => {
    let t = 0;
    const ep = new VoiceEndpoint({ now: () => t });
    let span: ReturnType<typeof ep.push> = null;
    let frames = 0;
    for (let i = 0; i < 200 && !span; i++) {
      span = ep.push(frame(1600, 12000));
      frames = i + 1;
      t += 100;
    }
    expect(span).not.toBeNull();
    expect(frames).toBeLessThanOrEqual(160); // ≤ 15 s of 100 ms frames
  });

  it("reset() clears a half-open turn", () => {
    let t = 0;
    const ep = new VoiceEndpoint({ now: () => t });
    for (let i = 0; i < 10; i++) { ep.push(frame(1600, 12000)); t += 100; }
    ep.reset();
    for (let i = 0; i < 30; i++) { expect(ep.push(frame(1600, 0))).toBeNull(); t += 100; }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH="/c/Users/Hossein/tools/node22:$PATH" corepack pnpm exec vitest run packages/openai/src/local/endpoint.test.ts`
Expected: FAIL — `Cannot find module './endpoint.js'` (module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `english-coach/packages/openai/src/local/endpoint.ts`:

```ts
/**
 * Endpoint detection for the local voice provider. Pure: 20 ms PCM16
 * frames go in, turn spans come out. No timers, no sockets — a fake
 * clock makes every boundary testable. The adaptive RMS floor is what
 * keeps ambient noise (and Whisper's hallucination-on-silence) from
 * ever reaching the model: a turn must be VOICED before any audio is
 * buffered, and pure-silence streams never open a turn at all.
 */
export interface EndpointSpan {
  startedAt: number;
  endedAt: number;
  audio: Buffer;
}

interface FrameTime {
  rms: number;
  at: number;
}

export class VoiceEndpoint {
  private readonly now: () => number;
  private floor = 0.0001;
  private frames: FrameTime[] = [];
  private open = false; // an explicit flag — startedAt may legitimately be 0
  private startedAt = 0;
  private buffer: Buffer[] = [];
  private voicedFrames = 0;
  private lastVoicedAt = 0;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  push(frame: Buffer): EndpointSpan | null {
    const at = this.now();
    const f = { rms: rms(frame), at };

    const threshold = Math.max(this.floor * 3, 0.0005);
    const voiced = f.rms >= threshold;

    if (voiced) {
      if (!this.open) { this.open = true; this.startedAt = at; }
      this.buffer.push(frame);
      this.voicedFrames += 1;
      this.lastVoicedAt = at;
    } else {
      // Noise window: silent frames only. Voiced frames are kept out so the
      // floor (threshold = floor × 3) never rises toward the speaker's own
      // volume — otherwise speech resuming after a < ~320 ms pause is read as
      // silence and the turn is truncated.
      this.frames.push(f);
      if (this.frames.length > 16) this.frames.shift();
      const avg = this.frames.reduce((a, x) => a + x.rms, 0) / this.frames.length;
      this.floor = Math.max(avg, 0.0001);
    }

    if (!this.open) return null; // pure-silence stream: never opens a turn

    // 300 ms minimum VOICED span before a turn is real (drops clicks).
    // Measured as lastVoicedAt - startedAt, NOT wall-clock since open: a
    // blip is two voiced frames then silence, so once silent frames stop
    // advancing lastVoicedAt the span freezes (~200 ms) and the turn is
    // dropped even though the clock has long passed 300 ms.
    if (this.voicedFrames === 0 || this.lastVoicedAt - this.startedAt < 300) {
      // A gap > 600 ms with no re-voicing abandons the half-open turn.
      if (!voiced && at - this.lastVoicedAt > 600) this.abandon();
      return null;
    }

    // 600 ms of trailing silence ends the turn…
    if (at - this.lastVoicedAt >= 600) return this.finish(at);
    // …or the 15 s hard cap does.
    if (at - this.startedAt >= 15_000) return this.finish(at);
    return null;
  }

  private finish(at: number): EndpointSpan {
    const span = { startedAt: this.startedAt, endedAt: at, audio: Buffer.concat(this.buffer) };
    this.reset();
    return span;
  }

  private abandon(): void {
    this.open = false;
    this.startedAt = 0;
    this.buffer = [];
    this.voicedFrames = 0;
    this.lastVoicedAt = 0;
  }

  reset(): void {
    this.abandon();
    this.frames = [];
    this.floor = 0.0001;
  }
}

function rms(frame: Buffer): number {
  if (frame.length < 2) return 0;
  let sum = 0;
  const n = frame.length >> 1;
  for (let i = 0; i < n; i++) {
    const s = frame.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH="/c/Users/Hossein/tools/node22:$PATH" corepack pnpm exec vitest run packages/openai/src/local/endpoint.test.ts`
Expected: PASS (5 tests). If "returns a span after ~600 ms" fails on the exact frame count, the boundary is off by one frame — the test's 100 ms cadence means the trailing-silence window first reaches 600 ms on the **6th** silent frame (`at - lastVoicedAt >= 600`); the span's `endedAt - startedAt` assertion is ≥1300 ms, deliberately loose on that count, so a single-frame boundary slip won't fail the test.

- [ ] **Step 5: Typecheck**

Run: `PATH="/c/Users/Hossein/tools/node22:$PATH" corepack pnpm --filter @ec/openai typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add english-coach/packages/openai/src/local/endpoint.ts english-coach/packages/openai/src/local/endpoint.test.ts
git commit -m "feat(openai): pure endpoint detector for learner turns

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Python voice sidecar (`voice_sidecar.py`)

One resident Python process that owns both audio models and speaks JSON lines over stdio. **Whisper is loaded eagerly** (it is the STT path and is the first thing a session needs); **Piper is loaded lazily on the first `tts` op** and its voice auto-downloads there. This is a deliberate refinement of the spec's "loads both models at startup": the ryan voice is a ~60 MB download that took ~39 s in the design spike, so blocking the `ready` handshake (and therefore session start) on it would make every cold session feel broken. Loading Piper on first `tts` also matches the spec's own "auto-downloaded on first TTS use" line, and lets the automated tests exercise the STT plumbing with no network.

**Files:**
- Create: `english-coach/packages/openai/scripts/voice_sidecar.py`
- Create: `english-coach/packages/openai/requirements.txt`
- Test: `english-coach/packages/openai/src/local/voice_sidecar.test.ts`

**Interfaces:**
- Consumes: nothing (leaf process).
- Produces: a stdio protocol the TS manager (Task 4) and the provider (Task 5) rely on:
  - parent → child (stdin, one JSON object per line; concurrent requests are allowed and paired by `id`): `{"id":1,"op":"stt","audio":"<hex pcm16 16 kHz>"}`, `{"id":2,"op":"tts","text":"…"}`, `{"id":3,"op":"ping"}`, `{"op":"bye"}`.
  - child → parent (stdout, one JSON object per line): a **single** `{"ready":true}` once Whisper is loaded, then one response line per op echoing the request's `id`: `{"ok":true,"id":1,"text":"…"}` (stt), `{"ok":true,"id":2,"audio":"<hex pcm16>","sampleRate":22050}` (tts), `{"ok":true,"id":3}` (ping), or `{"ok":false,"id":<n>,"error":"…"}` on any failure. The `id` lets the manager (Task 4) pair a response to its request while the learner is already being transcribed on a second request.
  - Env the child reads: `WHISPER_MODEL` (default `small`), `PIPER_VOICE` (default `en_US-ryan-medium`), `PIPER_DATA_DIR` (default `data/piper`).

- [ ] **Step 1: Write `requirements.txt`**

Create `english-coach/packages/openai/requirements.txt`:

```
faster-whisper
piper-tts
```

- [ ] **Step 2: Write the failing test**

Create `english-coach/packages/openai/src/local/voice_sidecar.test.ts`. It spawns the **real** sidecar (Whisper `small` is already in the Hugging Face cache, so this is a fast cache-hit, not a 240 MB download) and drives the stdio protocol in one test: `ready` handshake, `stt`, `ping`, malformed-line tolerance, clean `bye` exit. It **never sends `tts`**, so the 60 MB Piper voice is never pulled during the automated suite (that path is covered by the manual smoke in Task 7). The manager-level failure modes (child exits before `ready`, child dies mid-session, `close()` semantics) are tested deterministically in Task 4 against a fake child.

```ts
import { describe, it, expect } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "..", "scripts", "voice_sidecar.py");  // two .. up: src/local -> src -> package, then scripts/

/** First interpreter on PATH that answers `--version` (python / python3 / py). */
function findPython(): string | null {
  for (const cmd of ["python", "python3", "py"]) {
    try {
      if (spawnSync(cmd, ["--version"], { timeout: 5000 }).status === 0) return cmd;
    } catch {
      /* not on PATH */
    }
  }
  return null;
}

const python = findPython();
const SKIP = !python || !existsSync(SCRIPT);

/** Resolve the next newline-terminated line from the child's stdout. */
function readline(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("timeout waiting for a stdout line")), timeoutMs);
    const onData = (d: Buffer) => {
      buf += d.toString("utf8");
      const idx = buf.indexOf("\n");
      if (idx >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        child.stdout!.off("data", onData);
        clearTimeout(timer);
        resolve(line);
      }
    };
    child.stdout!.on("data", onData);
  });
}

describe.skipIf(SKIP)("voice_sidecar.py (real Python)", () => {
  let child: ChildProcess;

  // 1 s of silence = 16000 int16 samples = 32000 bytes = 64000 hex chars.
  const SILENCE = Buffer.alloc(32000).toString("hex");

  it("loads Whisper, announces ready, transcribes, pings, tolerates bad input, and exits on bye", async () => {
    child = spawn(python!, [SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, WHISPER_MODEL: "small", PIPER_DATA_DIR: "data/piper" },
    });

    // 1) ready handshake (Whisper load is a ~4 s cache-hit here; allow plenty)
    const ready = JSON.parse(await readline(child, 120_000)) as { ready?: boolean };
    expect(ready.ready).toBe(true);

    // 2) stt over the wire (hex PCM16 in, text out). Silence must not throw.
    child.stdin!.write(JSON.stringify({ op: "stt", audio: SILENCE }) + "\n");
    const stt = JSON.parse(await readline(child, 60_000)) as { ok: boolean; text?: string };
    expect(stt.ok).toBe(true);
    expect(typeof stt.text).toBe("string");

    // 3) ping round-trips
    child.stdin!.write(JSON.stringify({ op: "ping" }) + "\n");
    const ping = JSON.parse(await readline(child, 10_000)) as { ok: boolean };
    expect(ping.ok).toBe(true);

    // 4) a non-JSON line is rejected, not a crash
    child.stdin!.write("this is not json\n");
    const bad = JSON.parse(await readline(child, 10_000)) as { ok: boolean; error?: string };
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("json");

    // 5) bye exits cleanly (code 0)
    const exited = new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
    });
    child.stdin!.write(JSON.stringify({ op: "bye" }) + "\n");
    child.stdin!.end();
    expect(await exited).toBe(0);
  }, 180_000);
});
```

- [ ] **Step 3: Write the implementation**

Create `english-coach/packages/openai/scripts/voice_sidecar.py`:

```python
#!/usr/bin/env python3
"""English Coach local-voice sidecar.

A resident process speaking JSON lines over stdio. The parent (Node) sends one
op per line on stdin and reads one JSON response per line from stdout.

    parent -> child : {"id":1,"op":"stt","audio":"<hex pcm16 16 kHz>"}
                       {"id":2,"op":"tts","text":"..."}
                       {"id":3,"op":"ping"}
                       {"op":"bye"}
    child  -> parent: {"ready":true}                              (once, after Whisper loads)
                       {"ok":true,"id":1,"text":"..."}           (stt result)
                       {"ok":true,"id":2,"audio":"<hex>","sampleRate":22050}  (tts result)
                       {"ok":true,"id":3}                        (ping)
                       {"ok":false,"id":<n>,"error":"..."}       (any failure)

Whisper is loaded eagerly (it backs the STT path). Piper is loaded LAZILY on
the first ``tts`` op and its voice auto-downloads there, so a cold start — or a
session that never needs speech output — is never blocked by a ~60 MB voice
download. Every line is flushed immediately: Python stdout is block-buffered on
a pipe, and a buffered ``ready`` line would make the parent's startup handshake
time out.

Whisper runs capped to suppress hallucination-on-silence: ``beam_size=1``,
``condition_on_previous_text=False``, a ``no_speech_threshold``, and a hard
``max_new_tokens``.
"""
import json
import os
import sys


def _say(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def _load_whisper(model_name):
    from faster_whisper import WhisperModel
    # device=cpu + int8: this is a CPU box (no GPU). int8 is the spec's quantized
    # model and ~4x smaller/faster than fp on CPU.
    return WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=4)


def _load_piper(voice, data_dir):
    from pathlib import Path
    from piper import PiperVoice

    pdir = Path(data_dir)
    pdir.mkdir(parents=True, exist_ok=True)  # download_voice() does not mkdir
    model_path = pdir / f"{voice}.onnx"
    if not model_path.exists():
        from piper.download_voices import download_voice
        download_voice(voice, pdir)  # writes {voice}.onnx + {voice}.onnx.json
    return PiperVoice.load(str(model_path))  # finds {voice}.onnx.json automatically


def _do_stt(model, audio_hex):
    import numpy as np

    pcm = bytes.fromhex(audio_hex)
    # float32 in [-1, 1] at 16 kHz. transcribe() accepts an ndarray directly
    # (it skips decode_audio), so no temp wav file is needed.
    samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    segments, _info = model.transcribe(
        samples,
        language="en",
        beam_size=1,
        condition_on_previous_text=False,
        no_speech_threshold=0.5,
        hallucination_silence_threshold=0.5,
        max_new_tokens=400,
    )
    return " ".join(seg.text.strip() for seg in segments).strip()


def main():
    whisper_model = os.environ.get("WHISPER_MODEL", "small")
    piper_voice = os.environ.get("PIPER_VOICE", "en_US-ryan-medium")
    piper_dir = os.environ.get("PIPER_DATA_DIR", "data/piper")

    model = _load_whisper(whisper_model)  # may raise -> top handler -> fatal line

    _say({"ready": True})  # Whisper is up; Piper loads on first use.
    piper = None

    while True:
        line = sys.stdin.readline()
        if not line:  # stdin closed -> parent is gone
            break
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            _say({"ok": False, "error": "bad json"})
            continue

        op = req.get("op")
        if op == "bye":
            break
        if op == "ping":
            _say({"ok": True, "id": req.get("id")})
            continue
        if op == "stt":
            try:
                _say({"ok": True, "id": req.get("id"), "text": _do_stt(model, req["audio"])})
            except Exception as e:  # noqa: BLE001 - report, keep serving
                _say({"ok": False, "id": req.get("id"), "error": f"stt: {e!r}"})
        elif op == "tts":
            try:
                if piper is None:
                    piper = _load_piper(piper_voice, piper_dir)
                from piper import SynthesisConfig

                pcm = bytearray()
                sample_rate = 22050
                for chunk in piper.synthesize(req["text"], SynthesisConfig()):
                    sample_rate = chunk.sample_rate
                    pcm.extend(chunk.audio_int16_bytes)
                _say({"ok": True, "id": req.get("id"), "audio": bytes(pcm).hex(), "sampleRate": sample_rate})
            except Exception as e:  # noqa: BLE001
                _say({"ok": False, "id": req.get("id"), "error": f"tts: {e!r}"})
        else:
            _say({"ok": False, "id": req.get("id"), "error": f"unknown op: {op!r}"})

    sys.stdout.write("\n")
    sys.stdout.flush()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001 - a startup crash must surface, not hang the parent
        try:
            _say({"ok": False, "error": f"fatal: {e!r}"})
        except Exception:  # noqa: BLE001
            pass
        sys.exit(1)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `PATH="/c/Users/Hossein/tools/node22:$PATH" corepack pnpm exec vitest run packages/openai/src/local/voice_sidecar.test.ts`
Expected: the "loads Whisper, announces ready, transcribes, pings…" test PASSES (Whisper small is a cache-hit; ~4 s load + a fast silence transcription). If it times out at the `ready` step, the child is buffering stdout — confirm every `_say` calls `flush()` and that you spawned with unbuffered-friendly `stdio`. If `findPython()` returns null, the test is skipped (that is correct on a machine without Python).

- [ ] **Step 5: Confirm the real sidecar runs standalone (smoke the Python in isolation)**

Run:
```bash
printf '{"op":"ping"}\n' | PATH="/c/Users/Hossein/tools/node22:$PATH" python ../../packages/openai/scripts/voice_sidecar.py
```
Expected: a `{"ready": true}` line, then a `{"ok": true}` line. (This proves the flush/protocol works without the vitest harness.)

- [ ] **Step 6: Commit**

```bash
git add english-coach/packages/openai/scripts/voice_sidecar.py english-coach/packages/openai/requirements.txt english-coach/packages/openai/src/local/voice_sidecar.test.ts
git commit -m "feat(openai): Python voice sidecar (faster-whisper STT, lazy Piper TTS)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: Sidecar manager (`sidecar.ts`)

The Node-side owner of the Python child process: spawn, `ready` handshake, JSON-line request/response pairing, and the two crash surfaces. The provider (Task 5) will never talk to `child_process` directly — everything goes through this class.

**Deliberate deviation from the spec:** §6 names "restart-on-crash", but the spec's own failure table (§7) resolves the conflict — a mid-session crash ends the session `FAILED` with `voice_engine_lost`, and a dead Whisper/Piper pair is exactly what restart would race with (a fresh spawn re-downloads/re-loads for ~10 s while the learner is watching). The manager therefore **never restarts**: pre-ready exit → `ready` rejects (→ `stt_unavailable`); post-ready exit → a single `crash` event (→ `voice_engine_lost`).

**Files:**
- Create: `english-coach/packages/openai/src/local/sidecar.ts`
- Test: `english-coach/packages/openai/src/local/sidecar.test.ts`

**Interfaces:**
- Consumes: the stdio protocol from Task 3 (`{"id":n,"op":…}` in; `{"ok":…, "id":n, …}` out; one `{"ready":true}` first).
- Produces:
  ```ts
  export interface SidecarOptions {
    python: string;                    // interpreter ("python", "python3", or a full path)
    script: string;                    // absolute path to voice_sidecar.py
    env?: Record<string, string>;      // merged over process.env for the child (WHISPER_MODEL, PIPER_VOICE, PIPER_DATA_DIR, …)
    requestTimeoutMs?: number;         // default 60_000 (a cold first Piper download can take longer; STT is 1–4 s)
    readyTimeoutMs?: number;           // default 180_000 (first-ever Whisper model download can take minutes)
  }
  export type SidecarResponse =
    | { ok: true; text: string }                     // stt
    | { ok: true; audio: Buffer; sampleRate: number } // tts
    | { ok: true };                                   // ping
    | { ok: false; error: string };                  // any op-level failure

  export class VoiceSidecar {
    constructor(opts: SidecarOptions);
    /** Resolves once the child prints {"ready":true}. NEVER times out silently:
     *  on a pre-ready child exit it rejects with
     *  `new Error("stt_unavailable")` (message carries the child's error detail),
     *  and on readyTimeout it rejects with `stt_unavailable: timeout waiting for sidecar ready`.
     *  A reject is terminal — the child is already dead or timed out. */
    ready(): Promise<void>;
    /** One op, one response. Resolves with the parsed SidecarResponse (ok or
     *  not — an op-level failure is a RESOLVE, not a reject). Rejects with
     *  `sidecar timeout after <ms> ms` (per-request), `stt_unavailable: sidecar died`
     *  (child exited while the request was in flight), or `sidecar closed` (after close()). */
    request(op: "stt" | "tts", payload: Record<string, unknown>): Promise<SidecarResponse>;
    /** Kills the child (SIGTERM, then SIGKILL after 2 s — SIGKILL is a
     *  no-op on Windows where SIGTERM already terminates). Idempotent: a
     *  second call is a no-op; any request() pending at close time rejects
     *  with `sidecar closed`. After close() the exit event is suppressed —
     *  a kill we performed is not a crash. */
    close(): void;
    /** One-shot crash subscription. Fired exactly once, only if the child exits
     *  after ready() resolved (a post-ready exit that was already surfaced as an
     *  stt_unavailable reject is not a crash). `null` is a clean exit (code 0);
     *  otherwise the exit code or null-if-killed. */
    onCrash(handler: (code: number | null) => void): void;
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `english-coach/packages/openai/src/local/sidecar.test.ts`. The "child" is a fake `node` process that speaks the sidecar protocol — deterministic, no Python, no model downloads, millisecond-fast:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceSidecar } from "./sidecar.js";

/** The fake sidecar speaks the exact JSON-line protocol of voice_sidecar.py. */
const FAKE = `
let buf = "";
process.stdout.write(JSON.stringify({ ready: true }) + "\\n");
process.stdin.on("data", (d) => {
  buf += d.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    if (req.op === "stt") process.stdout.write(JSON.stringify({ ok: true, id: req.id, text: "FAKE TEXT" }) + "\\n");
    else if (req.op === "tts") process.stdout.write(JSON.stringify({ ok: true, id: req.id, audio: "0011223344556677", sampleRate: 22050 }) + "\\n");
    else if (req.op === "tts_fail") process.stdout.write(JSON.stringify({ ok: false, id: req.id, error: "boom" }) + "\\n");
    else if (req.op === "slow") setTimeout(() => process.stdout.write(JSON.stringify({ ok: true, id: req.id, text: "slow" }) + "\\n"), 5000);
    else if (req.op === "kill") process.exit(7);
    else if (req.op === "bye") process.exit(0);
  }
});
`;

let dir: string;
let script: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ec-sidecar-"));
  script = join(dir, "fake_sidecar.mjs");
  writeFileSync(script, FAKE, "utf8");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function make(over: Partial<ConstructorParameters<typeof VoiceSidecar>[0]> = {}): VoiceSidecar {
  return new VoiceSidecar({ python: process.execPath, script, ...over });
}

describe("VoiceSidecar", () => {
  it("handshakes ready, pairs id'd requests, and exits cleanly on close", async () => {
    const s = make();
    await s.ready();
    expect((await s.request("stt", { audio: "00" })).ok).toBe(true);
    const tts = await s.request("tts", { text: "hi" });
    expect(tts.ok).toBe(true);
    // "ok" is true on every variant, so a bare `if (tts.ok)` doesn't narrow;
    // the `in` check does, without touching the pinned SidecarResponse type.
    if (tts.ok && "audio" in tts) {
      expect(tts.audio).toBeInstanceOf(Buffer);
      expect(tts.sampleRate).toBe(22050);
    }
    s.close();
    await new Promise((r) => setTimeout(r, 100)); // let the kill land
  });

  it("rejects a request with 'sidecar closed' after close() (Review Focus 4: a new session can't revive a torn-down sidecar)", async () => {
    const s = make();
    await s.ready();
    s.close();
    await expect(s.request("stt", { audio: "00" })).rejects.toThrow("sidecar closed");
    s.close(); // idempotent: no throw, no second kill
  });

  it("pre-ready exit rejects ready() with stt_unavailable (Review Focus 1: visible FAILED, not a hang)", async () => {
    const dying = join(dir, "dying_sidecar.mjs");
    writeFileSync(dying, "process.stdout.write(JSON.stringify({ ok: false, error: 'ModuleNotFoundError: No module named \\'faster_whisper\\'' }) + '\\n');\nprocess.exit(1);\n", "utf8");
    const s = make({ script: dying });
    await expect(s.ready()).rejects.toThrow("stt_unavailable");
    s.close();
  });

  it("a post-ready exit fires onCrash exactly once with the exit code (Review Focus 3: exactly one voice_engine_lost)", async () => {
    const s = make();
    await s.ready();
    const codes: (number | null)[] = [];
    s.onCrash((code) => codes.push(code));
    await s.request("stt", { audio: "00" }); // the child is alive here
    await new Promise<void>((resolve) => {
      // drive the child to self-kill over the wire; the kill request itself
      // rejects with 'sidecar died' when the exit lands. Swallow that expected
      // rejection on the (already-resolved) chain so it isn't unhandled — only
      // the crash-code assertions below are the point.
      const p = s.request("tts", { text: "", op: "kill" });
      void p.catch(() => {}).finally(() => setTimeout(resolve, 100));
    });
    await new Promise((r) => setTimeout(r, 100)); // give the exit event a tick to deliver
    expect(codes).toHaveLength(1); // exactly once — the guard is the point
    expect(codes[0]).toBe(7); // the fake's self-chosen exit code — deterministic across platforms (signal-kill codes are not)
  });

  it("a missing interpreter rejects ready() with stt_unavailable (Review Focus 1: python absent from the box)", async () => {
    const s = make({ python: "definitely-not-a-real-interpreter-xyz" });
    await expect(s.ready()).rejects.toThrow("stt_unavailable");
  });

  it("a request in flight when the child dies rejects with stt_unavailable (no orphaned waiter)", async () => {
    const s = make({ requestTimeoutMs: 5_000 });
    await s.ready();
    const p = s.request("tts", { text: "", op: "kill" }); // the child dies while this is outstanding
    await expect(p).rejects.toThrow("stt_unavailable: sidecar died");
  });

  it("a request outliving its timeout rejects with 'sidecar timeout' (and later requests still reject cleanly)", async () => {
    const s = make({ requestTimeoutMs: 300 });
    await s.ready();
    await expect(s.request("tts", { text: "", op: "slow" })).rejects.toThrow("sidecar timeout after 300 ms");
    // the timed-out op's (late) response must not be delivered to a later request
    await new Promise((r) => setTimeout(r, 5_300));
    await expect(s.request("stt", { audio: "00" })).resolves.toMatchObject({ ok: true, text: "FAKE TEXT" });
    s.close();
  }, 10_000); // the 5.3 s late-response wait deliberately outlives the default 5 s testTimeout
});
```

Notes for the executor:
- `op: "kill"` / `"slow"` / `"tts_fail"` are **test-only** ops the fake understands; the real sidecar answers them with `unknown op`. The manager never special-cases them — it just ships `payload` through.
- The last test waits ~5.3 s so the fake's late `slow` response actually lands in the buffer; a later real `stt` must NOT resolve with that stale line. That is the pairing test.

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH="/c/Users/Hossein/tools/node22:$PATH" corepack pnpm exec vitest run packages/openai/src/local/sidecar.test.ts`
Expected: FAIL — `Cannot find module './sidecar.js'` (module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `english-coach/packages/openai/src/local/sidecar.ts`:

```ts
import { spawn, type ChildProcess } from "node:child_process";

/** One JSON op, one response — the wire shape the Python sidecar speaks. */
export type SidecarResponse =
  | { ok: true; text: string }
  | { ok: true; audio: Buffer; sampleRate: number }
  | { ok: true }
  | { ok: false; error: string };

export interface SidecarOptions {
  python: string;
  script: string;
  env?: Record<string, string>;
  requestTimeoutMs?: number;
  readyTimeoutMs?: number;
}

interface Pending {
  resolve: (r: SidecarResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Owner of the Python voice sidecar (see scripts/voice_sidecar.py). Spawns the
 * interpreter, completes the ready handshake, and pairs one JSON request with
 * one JSON response by `id`. It never restarts the child: a pre-ready exit
 * fails the handshake (stt_unavailable) and a post-ready exit fires onCrash
 * exactly once (voice_engine_lost). The spec's "restart-on-crash" was
 * superseded by its own failure table: restarting a dead audio engine just
 * delays the visible failure by a model reload.
 */
export class VoiceSidecar {
  private readonly python: string;
  private readonly script: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly requestTimeoutMs: number;
  private child: ChildProcess | null = null;
  private lineBuf = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private readyState: "starting" | "ready" | "dead" = "starting";
  private readyWaiters: { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];
  private crashHandler: ((code: number | null) => void) | null = null;
  private crashFired = false;
  private closed = false;

  constructor(opts: SidecarOptions) {
    this.python = opts.python;
    this.script = opts.script;
    // Strip null/undefined: callers pass optional config through, and spawn()
    // rejects non-string env values.
    const merged: NodeJS.ProcessEnv = { ...process.env };
    for (const [k, v] of Object.entries(opts.env ?? {})) if (v != null) merged[k] = v;
    this.env = merged;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
    this.spawnChild(opts.readyTimeoutMs ?? 180_000);
  }

  private spawnChild(readyTimeoutMs: number): void {
    const child = spawn(this.python, [this.script], {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.env,
    });
    this.child = child;

    child.stdout!.on("data", (d: Buffer) => this.onData(d));
    child.stderr!.on("data", (d: Buffer) => {
      // Surfaced on the next ready() reject — the child's traceback is the
      // "pip install faster-whisper piper-tts" a user actually needs to see.
      this.stderrTail = (this.stderrTail + d.toString("utf8")).slice(-2_000);
    });
    child.on("exit", (code) => this.onExit(code));
    // A spawn failure (python missing / bad path) arrives as 'error'. An
    // 'error' emission with no listener throws in the API process — so this
    // handler is mandatory, and it routes the failure through the same
    // stt_unavailable surface as a dying child.
    child.on("error", (err) => this.failReady(new Error(`stt_unavailable: ${String(err.message ?? err)}`)));
    const timer = setTimeout(() => this.failReady(new Error(`stt_unavailable: timeout waiting for sidecar ready (python: ${this.python})`)), readyTimeoutMs);
    this.readyTimers.push(timer);
  }

  private stderrTail = "";
  private readyTimers: NodeJS.Timeout[] = [];

  ready(): Promise<void> {
    if (this.readyState === "ready") return Promise.resolve();
    if (this.readyState === "dead") return Promise.reject(new Error(`stt_unavailable: ${this.stderrTail || "sidecar exited before ready"}`.trim()));
    return new Promise((resolve, reject) => {
      this.readyWaiters.push({
        resolve: () => resolve(),
        reject: (e) => reject(e),
        timer: setTimeout(() => reject(new Error("stt_unavailable: timeout waiting for sidecar ready")), 180_000),
      });
    });
  }

  private failReady(err: Error): void {
    if (this.readyState !== "starting") return;
    this.readyState = "dead";
    this.killChild();
    for (const w of this.readyWaiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  request(op: "stt" | "tts", payload: Record<string, unknown>): Promise<SidecarResponse> {
    if (this.closed) return Promise.reject(new Error("sidecar closed"));
    if (!this.child || this.readyState === "dead") {
      return Promise.reject(new Error("stt_unavailable: sidecar died"));
    }
    const id = this.nextId++;
    const line = { id, op, ...payload };
    const timer = setTimeout(() => {
      // settle() is the single exactly-once choke point (it deletes the id
      // itself) — deleting first would make settle a no-op and leave the
      // caller's promise unsettled forever.
      this.settle(id, null, new Error(`sidecar timeout after ${this.requestTimeoutMs} ms`));
    }, this.requestTimeoutMs);
    return new Promise<SidecarResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin!.write(JSON.stringify(line) + "\n");
    });
  }

  private onData(d: Buffer): void {
    this.lineBuf += d.toString("utf8");
    let idx: number;
    while ((idx = this.lineBuf.indexOf("\n")) >= 0) {
      const line = this.lineBuf.slice(0, idx);
      this.lineBuf = this.lineBuf.slice(idx + 1);
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // never let a half-line kill the reader
      }
      if (msg.ready) {
        // Only a not-yet-ready handshake is meaningful — a ready line after
        // close() is stale pipe noise, not a state transition.
        if (this.readyState === "starting") {
          this.readyState = "ready";
          for (const t of this.readyTimers) clearTimeout(t);
          this.readyTimers = [];
          const ws = this.readyWaiters.splice(0);
          for (const w of ws) {
            clearTimeout(w.timer);
            w.resolve();
          }
        }
        continue;
      }
      const id = typeof msg.id === "number" ? msg.id : null;
      if (id === null) continue; // a line that pairs to nothing is noise, not an error
      // TTS audio crosses the wire as a hex string; the response type promises a Buffer.
      const res = (typeof msg.audio === "string"
        ? { ...msg, audio: Buffer.from(msg.audio, "hex") }
        : msg) as unknown as SidecarResponse;
      this.settle(id, res, null);
    }
  }

  private onExit(code: number | null): void {
    if (this.closed) return; // close() already killed it — nothing to report
    if (this.readyState === "starting") {
      // The child died (or was killed) before it ever said ready.
      this.failReady(new Error(`stt_unavailable: sidecar exited before ready (code=${code})${this.stderrTail ? `: ${this.stderrTail}` : ""}`));
      return;
    }
    // Post-ready exit. A clean exit (bye/stdin EOF, code 0) is teardown, not a
    // crash — but the contract is that close() suppresses everything, and a
    // code-0 exit without close() means the child ended on its own: still
    // surface it, because a "clean" exit mid-session is a defect worth seeing.
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("stt_unavailable: sidecar died"));
    }
    this.pending.clear();
    if (!this.crashFired && this.crashHandler) {
      this.crashFired = true;
      this.crashHandler(code);
    }
  }

  onCrash(handler: (code: number | null) => void): void {
    this.crashHandler = handler;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.readyTimers) clearTimeout(t);
    for (const w of this.readyWaiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new Error("stt_unavailable: sidecar closed before ready"));
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("sidecar closed"));
    }
    this.pending.clear();
    this.readyState = "dead";
    this.killChild();
  }

  private killChild(): void {
    const child = this.child;
    if (!child) return;
    this.child = null;
    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, 2_000).unref?.();
  }

  /** Resolve one pending request, exactly once. */
  private settle(id: number, res: SidecarResponse | null, err: Error | null): void {
    const p = this.pending.get(id);
    if (!p) return; // already settled (timeout raced the response) — drop the loser
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (err) p.reject(err);
    else p.resolve(res as SidecarResponse);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH="/c/Users/Hossein/tools/node22:$PATH" corepack pnpm exec vitest run packages/openai/src/local/sidecar.test.ts`
Expected: PASS (6 tests). Two gotchas worth pre-reading:
- **The fake writes `ready` synchronously at import**, before `spawn`'s `exit` handler wiring completes — that is fine: stdout data is delivered on the event loop after the constructor returns, so `ready()`'s waiter is registered first.
- **Windows `SIGKILL`**: on win32 `child.kill("SIGKILL")` throws; the `try/catch` around both kills is load-bearing, not decorative. `kill("SIGTERM")` on Windows terminates the process outright, so the 2 s escalation is a no-op there and the tests still pass.

- [ ] **Step 5: Typecheck**

Run: `PATH="/c/Users/Hossein/tools/node22:$PATH" corepack pnpm --filter @ec/openai typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add english-coach/packages/openai/src/local/sidecar.ts english-coach/packages/openai/src/local/sidecar.test.ts
git commit -m "feat(openai): voice sidecar manager (spawn, ready handshake, id'd requests, crash surface)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: `LocalSpeechProvider` (`speech.ts`)

Wires the pieces into the provider seam: endpoint gate (Task 2) → sidecar STT (Task 4) → learner transcript → LLM (openai SDK, configurable baseURL) → coach transcript (text first) → paced Piper audio. It also owns every failure contract from the spec's §7 table.

**The pacing requirement (why the audio is chunked and delayed):** the web player resamples each posted chunk independently into a ring buffer that holds only **8192 floats ≈ 170 ms** at 22050 Hz, dropping the oldest samples on overflow. Piper returns an entire utterance in a few 1-2 s chunks; emitting those whole would truncate the coach's sentence to its first ~150 ms of audio. The provider therefore slices the response into ~20 ms frames (882 samples) and emits them on a real-time schedule that the ring buffer was sized for. (The mock provider's 25 ms frames at 24 kHz work today for the same reason.)

**Correction (2026-10-19) — the sleep must be to an absolute deadline.** The original implementation slept a fixed `frameMs` *after* each send. Per-frame cost (JSON encode + WS write) then adds to the period instead of being absorbed by it: measured **32 ms per 20 ms frame = realtime ratio 0.635**, which starves the ~170 ms ring buffer and is heard as crackle over clean TTS audio (reported by the user; Kokoro's 24 kHz output made it worse). The shipped loop sleeps the *remaining* time to the frame's due time. The regression test in Step 3 pins this (ratio ≥ 0.9; it measures 0.665 against the old code).

**Interfaces:**
- Consumes: `VoiceSidecar` (Task 4: `ready()`, `request(op, payload)`, `close()`, `onCrash(h)`, `SidecarResponse`); `VoiceEndpoint` (Task 2: `push(frame)`, `reset()`); the `openai` SDK (`new OpenAI({ baseURL, apiKey, timeout, maxRetries })`, `client.chat.completions.create({ model, messages, timeout })`); `ProviderEvent` / `SpeechConversationProvider` / `TranscriptTurn` from `../providers/types.js`.
- Produces:
  ```ts
  export interface LocalProviderOptions {
    llmBaseURL: string;      // e.g. http://localhost:11434/v1
    llmModel: string;         // e.g. llama3.2:3b
    llmApiKey?: string;       // "" is fine — the SDK accepts an empty key (Ollama ignores auth)
    sidecar: VoiceSidecar;    // constructed by the caller (server.ts) — keeps this class testable
    frameMs?: number;         // TTS pacing quantum, default 20
    now?: () => number;        // injectable clock for tests (default Date.now)
  }
  export class LocalSpeechProvider implements SpeechConversationProvider {
    constructor(opts: LocalProviderOptions);
    connect(onEvent: (e: ProviderEvent) => void): Promise<void>; // NEVER rejects; ends in connected or closed{reason}
    sendAudio(pcm16: Buffer): void;
    sendInstruction(text: string): void;
    close(): void;
  }
  ```
  Event order for one turn: `transcript{learner}` → `transcript{coach}` → `audio*` (paced). One `closed{reason}` event per provider, at most, on any failure.

- [ ] **Step 1: Write the failing test**

Create `english-coach/packages/openai/src/local/speech.test.ts`. The sidecar is a fake `node` child (same protocol as Task 4's fake, but this one can be told per-turn what to answer so each test pins one behavior); the LLM is a stub `http` server on an ephemeral port:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceSidecar } from "./sidecar.js";
import { LocalSpeechProvider, type LocalProviderOptions } from "./speech.js";
import type { ProviderEvent } from "../providers/types.js";

let dir: string;
let script: string;
let scriptFail: string;

// The fake sidecar answers the JSON-line protocol. Its tts reply is 1 s of
// silence at 22050 Hz (44100 int16 samples = 44100 × "00" hex chars) so the
// provider's pacer actually has ≥1 frame to emit — a 2-byte stub would
// produce zero frames and the "audio lands" assertions would lie.
const FAKE = `
let buf = "";
process.stdout.write(JSON.stringify({ ready: true }) + "\\n");
process.stdin.on("data", (d) => {
  buf += d.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    if (req.op === "stt") process.stdout.write(JSON.stringify({ ok: true, id: req.id, text: "I go to market." }) + "\\n");
    else if (req.op === "tts") process.stdout.write(JSON.stringify({ ok: true, id: req.id, audio: "00".repeat(44100), sampleRate: 22050 }) + "\\n");
  }
});
`;

// Same protocol, but tts ALWAYS fails — the spec's "Piper fails after the LLM
// succeeded" surface, with the LLM still working.
const FAKE_FAIL = FAKE.replace(
  'process.stdout.write(JSON.stringify({ ok: true, id: req.id, audio: "00".repeat(44100), sampleRate: 22050 }) + "\\n")',
  'process.stdout.write(JSON.stringify({ ok: false, id: req.id, error: "boom" }) + "\\n")',
);

let llm: ReturnType<typeof createServer>;
let llmPort: number;
let llmCalls = 0;
let llmFailFirst = false; // when true: exactly ONE request gets a 500 (the retry test's lever)

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ec-speech-"));
  script = join(dir, "fake_sidecar.mjs");
  writeFileSync(script, FAKE, "utf8");
  scriptFail = join(dir, "fake_sidecar_fail.mjs");
  writeFileSync(scriptFail, FAKE_FAIL, "utf8");
  // The stub LLM answers every /chat/completions with the same coach line. A
  // 500 response is REQUIRED for the retry test: the SDK only treats a
  // non-2xx status as a failure — a 200 with an empty choices array resolves
  // as a (empty) success, so the provider's retry would never fire.
  llm = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      llmCalls += 1;
      if (llmFailFirst) {
        llmFailFirst = false; // the failure is one-shot
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "model overloaded" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Sure — let's talk about that." } }] }));
    });
  });
  await new Promise<void>((resolve) => llm.listen(0, "127.0.0.1", () => resolve()));
  llmPort = (llm.address() as AddressInfo).port;
});

afterAll(async () => {
  llm?.close();
  rmSync(dir, { recursive: true, force: true });
});
```

The provider drives its own clock (injectable `now`), so the test feeds frames against a controllable timeline. `makeProvider` assembles a provider wired to a fake sidecar script (the second argument) and the stub LLM; each provider gets its own sidecar child and its own `feedFrames` closure:

```ts
let t = 1_000_000;
function makeProvider(scriptPath: string = script, over: Partial<LocalProviderOptions> = {}): {
  p: LocalSpeechProvider;
  sidecar: VoiceSidecar;
  events: ProviderEvent[];
  feedFrames: (voicedCount: number, silentCount: number) => void;
} {
  const sidecar = new VoiceSidecar({ python: process.execPath, script: scriptPath });
  const events: ProviderEvent[] = [];
  const p = new LocalSpeechProvider({
    llmBaseURL: `http://127.0.0.1:${llmPort}/v1`,
    llmModel: "stub",
    llmApiKey: "",
    sidecar,
    now: () => t,
    ...over,
  });
  return {
    p,
    sidecar,
    events,
    feedFrames: (voicedCount, silentCount) => {
      const frame = (amp: number) => {
        const b = Buffer.alloc(3200);
        for (let i = 0; i < 1600; i++) b.writeInt16LE(amp, i * 2);
        return b;
      };
      for (let i = 0; i < voicedCount + silentCount; i++) {
        p.sendAudio(i < voicedCount ? frame(12000) : frame(0));
        t += 100;
      }
    },
  };
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
```

The tests (each builds its own provider + sidecar and closes both):

```ts
describe("LocalSpeechProvider", () => {
  it("connect() resolves with 'connected' once the sidecar is ready (and never rejects)", async () => {
    const { p, sidecar, events } = makeProvider(script);
    await p.connect((e) => events.push(e));
    expect(events.filter((e) => e.t === "connected")).toHaveLength(1);
    p.close();
    sidecar.close();
  });

  it("transcribes a learner turn and replies through the LLM: learner text, coach text, then audio (text BEFORE audio)", async () => {
    const { p, sidecar, events, feedFrames } = makeProvider(script);
    p.connect((e) => events.push(e));
    await settle(50); // let connect finish its handshake
    feedFrames(10, 8); // 1 s voice + 0.8 s silence → endpoint closes the turn
    await settle(400); // give stt → llm → tts the event loop to run (no real models; fake answers instantly)

    const learner = events.filter((e): e is Extract<ProviderEvent, { t: "transcript" }> => e.t === "transcript" && e.turn.speaker === "learner");
    const coach = events.filter((e): e is Extract<ProviderEvent, { t: "transcript" }> => e.t === "transcript" && e.turn.speaker === "coach");
    const audio = events.filter((e): e is Extract<ProviderEvent, { t: "audio" }> => e.t === "audio");
    expect(learner).toHaveLength(1);
    expect(learner[0].turn.text).toBe("I go to market.");
    expect(coach).toHaveLength(1);
    expect(coach[0].turn.text).toBe("Sure — let's talk about that.");
    expect(audio.length).toBeGreaterThan(0);
    // text first: the first coach transcript lands before the first audio frame
    const firstCoachIdx = events.findIndex((e) => e.t === "transcript" && e.turn.speaker === "coach");
    const firstAudioIdx = events.findIndex((e) => e.t === "audio");
    expect(firstCoachIdx).toBeLessThan(firstAudioIdx);
    expect(audio[0].sampleRate).toBe(22050);
    p.close();
    sidecar.close();
  }, 10_000);

  it("LLM down (both attempts) → closed{coach_unavailable}, the learner's words still landed, nothing invented (Review Focus 2)", async () => {
    // Point the provider at a port nothing listens on (Ollama-not-running surface).
    const freePort = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const port = (s.address() as AddressInfo).port;
        s.close(() => resolve(port));
      });
    });
    const callsBefore = llmCalls; // shared counter (one stub server) — assert the delta
    const { p, sidecar, events, feedFrames } = makeProvider(script, { llmBaseURL: `http://127.0.0.1:${freePort}/v1` });
    p.connect((e) => events.push(e));
    await settle(50);
    feedFrames(10, 8);
    await settle(1500); // first attempt + one retry, both failing fast on ECONNREFUSED

    const closed = events.find((e) => e.t === "closed");
    expect(closed).toMatchObject({ t: "closed", reason: "coach_unavailable" });
    const learner = events.filter((e): e is Extract<ProviderEvent, { t: "transcript" }> => e.t === "transcript" && e.turn.speaker === "learner");
    expect(learner).toHaveLength(1); // the learner's words still landed
    expect(events.some((e) => e.t === "transcript" && e.turn.speaker === "coach")).toBe(false); // nothing invented
    expect(llmCalls - callsBefore).toBe(0); // nothing reached the (absent) server
    p.close();
    sidecar.close();
  }, 10_000);

  it("LLM succeeds only on the retry (one retry is exactly one extra call)", async () => {
    llmFailFirst = true; // attempt 1 → 500, attempt 2 → 200
    const callsBefore = llmCalls;
    const { p, sidecar, events, feedFrames } = makeProvider(script);
    p.connect((e) => events.push(e));
    await settle(50);
    feedFrames(10, 8);
    await settle(500);
    const coach = events.filter((e): e is Extract<ProviderEvent, { t: "transcript" }> => e.t === "transcript" && e.turn.speaker === "coach");
    expect(coach).toHaveLength(1);
    expect(coach[0].turn.text).toBe("Sure — let's talk about that."); // the retry's reply
    expect(llmCalls - callsBefore).toBe(2); // 500 then 200 — exactly one retry, no third call
    expect(events.some((e) => e.t === "closed")).toBe(false);
    p.close();
    sidecar.close();
  }, 10_000);

  it("Piper failing after the LLM succeeded: coach text lands, no audio, session keeps going (no closed event)", async () => {
    const { p, sidecar, events, feedFrames } = makeProvider(scriptFail); // tts-always-fails fake; the LLM is still the working stub
    p.connect((e) => events.push(e));
    await settle(50);
    feedFrames(10, 8);
    await settle(400);
    expect(events.some((e) => e.t === "transcript" && e.turn.speaker === "coach")).toBe(true); // text landed
    expect(events.some((e) => e.t === "audio")).toBe(false); // no audio
    expect(events.some((e) => e.t === "closed")).toBe(false); // session continues
    p.close();
    sidecar.close();
  }, 10_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH="/c/Users/Hossein/tools/node22:$PATH" corepack pnpm exec vitest run packages/openai/src/local/speech.test.ts`
Expected: FAIL — `Cannot find module './speech.js'` (module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `english-coach/packages/openai/src/local/speech.ts`:

```ts
import { OpenAI } from "openai";
import { VoiceEndpoint } from "./endpoint.js";
import type { VoiceSidecar } from "./sidecar.js";
import type { ProviderEvent, SpeechConversationProvider, TranscriptTurn } from "../providers/types.js";

export interface LocalProviderOptions {
  llmBaseURL: string;
  llmModel: string;
  llmApiKey?: string;
  sidecar: VoiceSidecar;
  frameMs?: number;
  now?: () => number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The sidecar's response union (Task 4) is not op-discriminated, so `ok` alone
// can't narrow it. Each request resolves with exactly one member shape, so the
// casts at the call sites are exact — they only make the known shape explicit.
type SttResponse = { ok: true; text: string } | { ok: false; error: string };
type TtsResponse = { ok: true; audio: Buffer; sampleRate: number } | { ok: false; error: string };

/**
 * Local conversation provider: endpoint gate → Whisper (via the sidecar) →
 * learner transcript → OpenAI-compatible LLM (TS) → coach transcript (text
 * first, so the learner reads while the audio is still being made) → Piper
 * audio, emitted in ~20 ms paced frames because the web player's ring buffer
 * holds only ~170 ms and resamples each posted chunk independently.
 *
 * connect() NEVER rejects (the bridge fire-and-forgets it): every startup
 * failure path ends in an emitted closed{reason} instead.
 */
export class LocalSpeechProvider implements SpeechConversationProvider {
  private onEvent: ((e: ProviderEvent) => void) | null = null;
  private closed = false;
  private endpoint: VoiceEndpoint;
  private client: OpenAI;
  private readonly frameMs: number;
  private readonly now: () => number;
  private history: OpenAI.ChatCompletionMessageParam[] = [];
  private warmup = "";
  // Learner turns run one at a time, in arrival order. A second span can land
  // while turn 1 is still awaiting the (slow) LLM; without this chain two
  // pacers would emit audio into the same ring buffer at once and two
  // continuations would scramble `history`. Each turn awaits the previous one.
  private turnChain = Promise.resolve();

  constructor(private readonly opts: LocalProviderOptions) {
    this.now = opts.now ?? Date.now;
    this.endpoint = new VoiceEndpoint({ now: this.now });
    this.frameMs = opts.frameMs ?? 20;
    this.client = new OpenAI({
      baseURL: opts.llmBaseURL,
      apiKey: opts.llmApiKey ?? "",
      timeout: 30_000,
      maxRetries: 0, // the provider's own one-shot retry is the only retry
    });
  }

  async connect(onEvent: (e: ProviderEvent) => void): Promise<void> {
    this.onEvent = onEvent;
    this.opts.sidecar.onCrash(() => this.emitClosed("voice_engine_lost"));
    try {
      await this.opts.sidecar.ready();
    } catch (e) {
      this.emitClosed("stt_unavailable");
      return;
    }
    this.onEvent({ t: "connected" });
  }

  sendAudio(pcm16: Buffer): void {
    if (this.closed) return;
    const span = this.endpoint.push(pcm16);
    if (span) {
      // Queue behind the previous turn so a barge-in can't interleave two
      // coaches' audio or reorder `history`. A turn can only reject if the
      // bridge callback throws (our code never does) — swallow it so one bad
      // turn can't poison the chain and silently drop every later turn.
      this.turnChain = this.turnChain.then(() => this.handleLearnerTurn(span.audio)).catch(() => {});
    }
  }

  sendInstruction(text: string): void {
    if (text.startsWith("Warmup:")) {
      this.warmup = text;
      this.history.unshift({ role: "system", content: this.warmup });
      return;
    }
    // A directive (challenge / micro-coach) steers the next reply: it replaces
    // the standing system prompt rather than appending forever.
    this.history = this.history.filter((m) => m.content !== this.warmup);
    this.history.unshift({ role: "system", content: text });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // close() is how the BRIDGE ends a session — including the normal
    // client-end path (clientEnd → finish("ANALYZING") → provider.close()).
    // Emitting closed{...} here would make the bridge's closed handler turn
    // every clean end into a FAILED session. So the `closed` event is
    // failure-only; user-initiated and app-shutdown closes are silent.
    this.opts.sidecar.close();
  }

  private emitClosed(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.onEvent?.({ t: "closed", reason });
  }

  private emitTurn(speaker: "learner" | "coach", text: string): void {
    const turn: TranscriptTurn = {
      speaker,
      text,
      startedAt: this.now() - 1000,
      endedAt: this.now(),
    };
    this.onEvent?.({ t: "transcript", turn });
  }

  /** STT → learner transcript → LLM (one retry) → coach transcript → TTS. */
  private async handleLearnerTurn(audio: Buffer): Promise<void> {
    if (this.closed) return; // a queued turn must not talk to a closed sidecar
    // 1. Transcribe the voiced span. Silence was never in it (endpoint gate).
    let stt: SttResponse;
    try {
      stt = (await this.opts.sidecar.request("stt", { audio: audio.toString("hex") })) as SttResponse;
    } catch (e) {
      this.emitClosed("voice_engine_lost");
      return;
    }
    if (!stt.ok) { this.emitClosed("voice_engine_lost"); return; }
    const text = stt.text.trim();
    if (!text) return; // empty transcription is dropped silently (spec §7)
    this.emitTurn("learner", text);
    this.history.push({ role: "user", content: text });

    // 2. Coach reply from the LLM — one retry, then a visible failure.
    //    Never fabricate a line: a dead coach is a FAILED session, not a
    //    made-up sentence the learning engine will score.
    const reply = await this.callLLM();
    if (this.closed) return;
    if (reply === null) { this.emitClosed("coach_unavailable"); return; }
    this.emitTurn("coach", reply);
    this.history.push({ role: "assistant", content: reply });

    // 3. Speak it. Piper failing here must NOT kill the session: the text
    //    already landed, so drop the audio and keep the conversation alive.
    try {
      const tts = (await this.opts.sidecar.request("tts", { text: reply })) as TtsResponse;
      if (!tts.ok) return;
      if (this.closed) return;
      await this.emitPacedAudio(tts.audio, tts.sampleRate);
    } catch {
      // sidecar died mid-tts: the crash handler already emitted closed
      // (or will); nothing more to do here.
    }
  }

  /** Two attempts total (the SDK retries 0). Returns null when both fail. */
  private async callLLM(): Promise<string | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.client.chat.completions.create(
          { model: this.opts.llmModel, messages: this.history },
          { timeout: 30_000 }, // request option (2nd arg) — the create body type has no `timeout` field
        );
        const content = res.choices[0]?.message?.content;
        if (typeof content === "string" && content.trim()) return content.trim();
        return null; // the endpoint answered but gave nothing usable — don't burn the retry on an empty-but-200 body
      } catch {
        /* attempt 1 failed; the loop makes exactly one more try (the SDK is maxRetries: 0, so this provider-level retry is the only one) */
      }
    }
    return null;
  }

  private async emitPacedAudio(pcm: Buffer, sampleRate: number): Promise<void> {
    const samplesPerFrame = Math.max(1, Math.round((sampleRate * this.frameMs) / 1000));
    // Absolute deadline, NOT sleep-after-send: per-frame cost must not extend
    // the period (measured 32 ms for 20 ms frames → ring-buffer underrun).
    // Real Date.now(), not the injectable endpoint clock (tests freeze that).
    const start = Date.now();
    let n = 0;
    for (let off = 0; off + samplesPerFrame * 2 <= pcm.length; off += samplesPerFrame * 2, n++) {
      if (this.closed) return;
      this.onEvent?.({ t: "audio", data: pcm.subarray(off, off + samplesPerFrame * 2), sampleRate });
      const wait = start + (n + 1) * this.frameMs - Date.now();
      if (wait > 0) await sleep(wait);
    }
  }
}
```

Local mode emits **no `tool_call` events** (spec §1: 3B models are unreliable at function-calling, and a wrong call would corrupt learning state) — the coach corrects in plain speech, which the LLM's system prompt already asks for.

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH="/c/Users/Hossein/tools/node22:$PATH" corepack pnpm exec vitest run packages/openai/src/local/speech.test.ts`
Expected: PASS (6 tests — the pacing regression test was added 2026-10-19; it stamps `Date.now()` per audio event and asserts `audioSeconds / span > 0.9`, and fails at ~0.665 against sleep-after-send). If the "Piper failing…" test is flaky, remember the executor note in Step 1: the fake must fail `tts` unconditionally (its own script file), and each provider gets its own clock closure.

- [ ] **Step 5: Typecheck the whole package**

Run: `PATH="/c/Users/Hossein/tools/node22:$PATH" corepack pnpm --filter @ec/openai typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add english-coach/packages/openai/src/local/speech.ts english-coach/packages/openai/src/local/speech.test.ts
git commit -m "feat(openai): LocalSpeechProvider (endpoint -> Whisper -> LLM -> Piper, failure contract)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: Wire `PROVIDER=local` end-to-end (factory, server, failure visibility, .env.example)

Makes `local` a real selectable provider and surfaces provider failure reasons in the UI — the spec's failure table requires the user to *see* `stt_unavailable` / `voice_engine_lost` / `coach_unavailable`, but the current bridge drops the reason (`void reason;` in `finish()`), and the web client has no field to render it in. Five small edits, one regression gate.

**Files:**
- Modify: `english-coach/packages/openai/src/index.ts` (local branch + export in `selectSpeechProvider`)
- Modify: `english-coach/apps/api/src/server.ts` (pass the local env fields to the factory)
- Modify: `english-coach/apps/api/src/realtime/bridge.ts` (carry `reason` on `session_ended`)
- Modify: `english-coach/apps/web/src/types/messages.ts` (matching web type)
- Modify: `english-coach/apps/web/src/views/SessionView.tsx` (render the reason) — **additive only; this file has a pre-existing uncommitted change from the prior session's WS `onmessage` fix. Do not revert or reformat it.**
- Modify: `english-coach/.env.example` (the six local vars)
- Test: `english-coach/packages/openai/src/openai/openai.test.ts` (3 new selector cases)

**Interfaces:**
- Consumes: `Env` fields from Task 1 (`LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, `WHISPER_MODEL`, `PIPER_VOICE`, `PIPER_DATA_DIR`, `PYTHON`); `LocalSpeechProvider` + `LocalProviderOptions` (Task 5); `VoiceSidecar` (Task 4).
- Produces: `selectSpeechProvider` now accepts `PROVIDER === "local"` and returns a `LocalSpeechProvider` (factory env gains optional `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, `WHISPER_MODEL`, `PIPER_VOICE`, `PIPER_DATA_DIR`, `PYTHON`); `session_ended` frames gain an optional `reason?: string`.
- Note: `selectAnalysisProvider` is **intentionally unchanged** — spec §1 keeps analysis/planner on the mock provider in local mode (the "full local loop" is a named follow-up, spec §9).

- [ ] **Step 1: Write the failing test**

Append to the existing `describe("provider factory")` block in `english-coach/packages/openai/src/openai/openai.test.ts`:

```ts
  it("builds LocalSpeechProvider when PROVIDER=local (no key required)", () => {
    const p = selectSpeechProvider({ PROVIDER: "local", PYTHON: "python" });
    expect(p.constructor.name).toBe("LocalSpeechProvider");
    p.close(); // the constructor spawns a real Python sidecar — close it or its child + 180 s ready-timer keep the test worker alive
  });

  it("local works with empty/absent LLM_API_KEY (Ollama ignores auth)", () => {
    const p = selectSpeechProvider({ PROVIDER: "local", LLM_API_KEY: "" });
    expect(p).toBeTruthy();
    p.close(); // ditto — release the spawned sidecar before the test ends
  });

  it("mock and openai selection are unchanged by the local branch", () => {
    expect(selectSpeechProvider({ PROVIDER: "mock" }).constructor.name).toBe("MockSpeechProvider");
    expect(selectSpeechProvider({ PROVIDER: "openai", OPENAI_API_KEY: "sk-x" }).constructor.name).toBe("OpenAISpeechProvider");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH="/c/Users/Hossein/tools/node22:$PATH" corepack pnpm exec vitest run packages/openai/src/openai/openai.test.ts`
Expected: the new "builds LocalSpeechProvider…" test FAILS — the factory has no `local` branch, so `selectSpeechProvider({ PROVIDER: "local" })` falls through to `MockSpeechProvider`. (The existing three tests still pass — the new branch must not disturb them.)

- [ ] **Step 3: Write the implementation**

(a) `packages/openai/src/index.ts` — import and add the branch + export:

```ts
import { LocalSpeechProvider } from "./local/speech.js";
import { VoiceSidecar } from "./local/sidecar.js";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sidecarScriptPath = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "voice_sidecar.py");

// (inside the existing export line) add LocalSpeechProvider to the named exports:
export { MockSpeechProvider, MockAnalysisProvider, OpenAISpeechProvider, OpenAIAnalysisProvider, MOCK_DEMO_SCRIPT, LocalSpeechProvider };

export function selectSpeechProvider(
  env: {
    PROVIDER?: string;
    OPENAI_API_KEY?: string;
    LLM_BASE_URL?: string;
    LLM_MODEL?: string;
    LLM_API_KEY?: string;
    WHISPER_MODEL?: string;
    PIPER_VOICE?: string;
    PIPER_DATA_DIR?: string;
    PYTHON?: string;
  },
  script?: { turns: MockTurn[] },
): SpeechConversationProvider {
  if (env.PROVIDER === "local") {
    if (!existsSync(sidecarScriptPath)) {
      throw new Error(`PROVIDER=local: voice_sidecar.py not found at ${sidecarScriptPath}`);
    }
    const sidecar = new VoiceSidecar({
      python: env.PYTHON ?? "python",
      script: sidecarScriptPath,
      env: {
        WHISPER_MODEL: env.WHISPER_MODEL ?? "small",
        PIPER_VOICE: env.PIPER_VOICE ?? "en_US-ryan-medium",
        PIPER_DATA_DIR: env.PIPER_DATA_DIR ?? "data/piper",
      },
    });
    return new LocalSpeechProvider({
      llmBaseURL: env.LLM_BASE_URL ?? "http://localhost:11434/v1",
      llmModel: env.LLM_MODEL ?? "llama3.2:3b",
      llmApiKey: env.LLM_API_KEY ?? "",
      sidecar,
    });
  }
  if (env.PROVIDER === "openai") {
    if (!env.OPENAI_API_KEY) {
      throw new Error("PROVIDER=openai requires OPENAI_API_KEY (set PROVIDER=mock or export the key)");
    }
    return new OpenAISpeechProvider(env.OPENAI_API_KEY);
  }
  return new MockSpeechProvider(script ?? { turns: [] });
}
```

Path note: `@ec/openai` is consumed as TS source (workspace `main: src/index.ts`), so `import.meta.url` resolves inside the package and `scripts/voice_sidecar.py` sits one directory above `src/`. `PIPER_DATA_DIR` is relative to the API process cwd (the server runs from `apps/api`, where `./data/` already lives).

(b) `apps/api/src/server.ts` — the `selectSpeechProvider` call (inside `selectSpeech`) gains the local fields. Replace its two-line object literal with:

```ts
      const p = selectSpeechProvider(
        {
          PROVIDER: env.PROVIDER,
          OPENAI_API_KEY: env.OPENAI_API_KEY,
          LLM_BASE_URL: env.LLM_BASE_URL,
          LLM_MODEL: env.LLM_MODEL,
          LLM_API_KEY: env.LLM_API_KEY,
          WHISPER_MODEL: env.WHISPER_MODEL,
          PIPER_VOICE: env.PIPER_VOICE,
          PIPER_DATA_DIR: env.PIPER_DATA_DIR,
          PYTHON: env.PYTHON,
        },
        env.PROVIDER === "mock" ? MOCK_DEMO_SCRIPT : undefined,
      );
```

The `selectAnalysisProvider` call stays **exactly as it is** — its env parameter type accepts only `PROVIDER`/`OPENAI_API_KEY` (passing the new fields would be a TS excess-property error), and local-mode analysis/planning stay on the mock provider by spec §1 (the "full local loop" is a named follow-up, spec §9).

(c) `apps/api/src/realtime/bridge.ts` — carry the reason:

```ts
  | { t: "session_ended"; state: SessionState; reason?: string };
```

and in `finish()`:

```ts
    this.send({ t: "session_ended", state, reason: reason === "ended" ? undefined : reason });
```

and delete the now-dead `void reason;` line.

(d) `apps/web/src/types/messages.ts` — the matching web type:

```ts
  | { t: "session_ended"; state: string; reason?: string };
```

(e) `apps/web/src/views/SessionView.tsx` — surface it where failures already land:

```ts
      else if (m.t === "session_ended") { ended.current = true; setState(m.state); if (m.reason) setNote(`Session ended: ${m.reason}`); setSessionId(null); stopper.teardown(); }
```

(f) `.env.example` — append (the six local vars; values are the defaults, so an unedited copy works out of the box):

```
# PROVIDER=local             # local voice: Whisper STT + Piper TTS + local LLM (needs Python deps + Ollama)
# LLM_BASE_URL=http://localhost:11434/v1
# LLM_MODEL=llama3.2:3b
# LLM_API_KEY=
# WHISPER_MODEL=small
# PIPER_VOICE=en_US-ryan-medium
# PIPER_DATA_DIR=data/piper
# PYTHON=python
```

- [ ] **Step 4: Run the tests**

Run:
```bash
PATH="/c/Users/Hossein/tools/node22:$PATH" corepack pnpm exec vitest run packages/openai/src/openai/openai.test.ts apps/api/tests/api.test.ts
```
Expected: PASS. The factory tests now include the local branch; `api.test.ts`'s two `env` literals are unaffected (the new `Env` fields are optional). Also re-run Task 5's provider test — it must stay green: `corepack pnpm exec vitest run packages/openai/src/local/speech.test.ts`.

- [ ] **Step 5: Typecheck both touched packages + web**

Run:
```bash
PATH="/c/Users/Hossein/tools/node22:$PATH" corepack pnpm --filter @ec/openai typecheck
PATH="/c/Users/Hossein/tools/node22:$PATH" corepack pnpm --filter @ec/api typecheck
PATH="/c/Users/Hossein/tools/node22:$PATH" corepack pnpm --filter @ec/web typecheck
```
Expected: all three PASS.

- [ ] **Step 6: Commit**

```bash
git add english-coach/packages/openai/src/index.ts english-coach/packages/openai/src/openai/openai.test.ts english-coach/apps/api/src/server.ts english-coach/apps/api/src/realtime/bridge.ts english-coach/apps/web/src/types/messages.ts english-coach/apps/web/src/views/SessionView.tsx english-coach/.env.example
git commit -m "feat: wire PROVIDER=local end-to-end and surface provider failure reasons in the UI

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: Docs, full regression, and the live smoke

- [ ] **Step 1: Add the "Local voice" README section**

In `english-coach/README.md`, insert after the "## Using the real OpenAI API" section (before "## Testing"):

```markdown
## Local voice (no API key)

`PROVIDER=local` makes the coach run entirely on your machine: you speak,
faster-whisper transcribes, a local LLM (any OpenAI-compatible endpoint,
Ollama by default) writes the reply, and Piper speaks it aloud.

Setup (one-time):

```bash
python -m pip install -r packages/openai/requirements.txt
ollama pull llama3.2:3b
cp .env.example apps/api/.env    # then set PROVIDER=local — cwd-relative, so NOT the repo root
```

On first session the two models download once: ~240 MB Whisper small into
the HuggingFace cache, and ~60 MB Piper voice into `apps/api/data/piper`.
Point the LLM elsewhere by editing `LLM_BASE_URL` / `LLM_MODEL` in `.env`.

| Variable | Default | What it sets |
| --- | --- | --- |
| `LLM_BASE_URL` | `http://localhost:11434/v1` | any OpenAI-compatible endpoint |
| `LLM_MODEL` | `llama3.2:3b` | the chat model |
| `LLM_API_KEY` | *(empty)* | most local servers ignore it |
| `WHISPER_MODEL` | `small` | STT size (small/base/tiny) |
| `PIPER_VOICE` | `en_US-ryan-medium` | TTS voice |
| `PIPER_DATA_DIR` | `data/piper` | where voice files persist |
| `PYTHON` | `python` | interpreter to spawn the sidecar |

Expect ~8–15 s from you stopping talking to the coach's voice (CPU). If a
session ends FAILED, the UI shows why: `stt_unavailable` (install the Python
deps / fix `PYTHON`), `voice_engine_lost` (the sidecar died, or a
transcribe request failed while it was alive), or
`coach_unavailable` (LLM endpoint unreachable after one retry).

Known limits: end-of-session analysis/planning still run on the mock
provider, and Whisper may mis-transcribe non-English slips.
```

- [ ] **Step 2: Full regression (the whole suite, including the new Python-sidecar test)**

Run: `PATH="/c/Users/Hossein/tools/node22:$PATH" corepack pnpm test`
Expected: PASS across the workspace — every pre-existing test (mock, openai, api, web) plus the new env/endpoint/sidecar/speech/openai tests. If the `voice_sidecar.test.ts` real-Python test is slow, that is the Whisper cache-hit load (~4 s); a timeout there means the sidecar is buffering stdout (re-check the `_say` flushes).

- [ ] **Step 3: Live smoke — one real turn**

Prereqs: Ollama running with `llama3.2:3b`, Python deps installed (`pip install -r packages/openai/requirements.txt`).

```bash
cd apps/api && PROVIDER=local PATH="/c/Users/Hossein/tools/node22:$PATH" corepack pnpm dev
```

**Two parts — the subagent does (a); the human does (b).**

(a) *Subagent-verifiable — the local provider actually comes up:*
1. Start the API in local mode (background): `cd apps/api && PROVIDER=local PATH="/c/Users/Hossein/tools/node22:$PATH" corepack pnpm dev`. Wait for the log line `english-coach api on 127.0.0.1:3100 (provider=local)` — proves the server boots with the local branch.
2. Open a real session over WS (this is what triggers the sidecar): `curl -s -X POST http://127.0.0.1:3100/v1/learners/learner-1/sessions` to get `sessionId`, then open a WebSocket to `ws://127.0.0.1:3100/ws/session/<sessionId>` (the web client's exact path; `ws` is already a dependency — a ~10-line node script collects frames).
3. Over a ~45 s window, confirm the sidecar **reached ready**: PASS = the WS stayed open, NO `session_ended` frame with `state:"FAILED"` and `reason:"stt_unavailable"` was received (that frame is the only client-visible sign the sidecar failed to come up), and a `python …/voice_sidecar.py` child process is still alive (`tasklist`/`ps`). Whisper `small` is already in the HuggingFace cache, so ready arrives in seconds — a `stt_unavailable` frame here means the Python deps or `PYTHON` path are broken.
4. End it cleanly: close the WS (or `curl -X POST http://127.0.0.1:3100/v1/sessions/<sessionId>/end`) and stop the server. Report the exact frames received.

(b) *Human-only — the spoken turn (handed to the user at finish; a subagent cannot speak into a mic):*
Start a session in the web client and **say one full sentence** (e.g. "Yesterday I went to the market and bought some fruit."). Expect, in order: (1) your words appear in the transcript ~1–4 s after you stop; (2) the coach's reply text ~5 s later on a warm 3B; (3) Piper's voice plays the reply (first TTS downloads the ryan voice — ~40 s the one time); (4) no FAILED state, no crash, the session continues. If the coach never answers, the UI's failure note names the stage (`stt_unavailable` / `voice_engine_lost` / `coach_unavailable`) — fix that stage and re-smoke. Do NOT "fix" the code to hide a failure; the failure contract is the point.

- [ ] **Step 4: Commit**

```bash
git add english-coach/README.md
git commit -m "docs: local voice setup, config table, and failure reasons in the README

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
