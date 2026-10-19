# Local Voice: Whisper STT + Selectable TTS (Piper/Kokoro) + Configurable LLM Coach

**Date:** 2026-10-14
**Status:** Implemented (v3 — `TTS_ENGINE` selectable: Piper *or* Kokoro; pacing corrected, §4.1)
**Path:** Architectural (new provider, new Python sidecar process, provider-seam change)

## 1. Purpose

Make the English Coach a real local conversation: the learner **speaks**; Whisper
transcribes the turn; a configurable LLM writes the coach's reply; a local TTS
engine (Piper by default, Kokoro optional) speaks it aloud; text and voice both
appear in the session. No API key required; the LLM endpoint is configurable and
defaults to the user's local Ollama.

### Intent (agreed)
- **STT:** faster-whisper, `small` model, **int8** (CPU, quantized).
- **TTS:** the coach replies with audio, not just text. Two engines behind
  `TTS_ENGINE`: **Piper** (default, `en_US-ryan-medium`, 22050 Hz) and **Kokoro**
  (`af_heart`, 24000 Hz) — see §4.1.
- **LLM:** any **OpenAI-compatible** endpoint — `LLM_BASE_URL` + `LLM_MODEL` (+
  optional key). Defaults: Ollama at `http://localhost:11434/v1`, model
  `llama3.2:3b`. Point it at another local server or real OpenAI later with no code
  change.

### Out of scope (this change)
- End-of-session **analysis / learning-plan** generation — those keep the existing
  mock provider. (The "full local loop" is a named follow-up, §9.)
- No `tool_call` events from the coach (3B models are unreliable at function-calling;
  a wrong call corrupts learning state). The coach corrects in plain speech/text.

## 2. Why the current setup can't do this

- No speech-to-text or TTS exists anywhere. In `mock` mode the "You" turns are a
  hardcoded script and learner mic audio is discarded (`sendAudio` is a no-op).
- `OpenAISpeechProvider` does STT + coach speech but needs a key and an unverified
  realtime model ID.
- The app never reads a `.env` file (`env.ts` reads `process.env` only; no dotenv),
  so the README's `cp .env.example .env` is a no-op. Fixed as a side item (§6).

## 3. What's on the machine / what must be installed (verified)

| Item | State |
|---|---|
| Python 3.14 | installed |
| Ollama, `llama3.2:3b` (2 GB) | running; **5.6 s** warm chat reply (15.9 s cold, 10.8 s of that one-time model load) |
| ffmpeg | present |
| NVIDIA GPU | none → CPU inference |
| `faster-whisper 1.2.1` (+ ctranslate2 4.8.3) | **not installed; pip dry-run confirms cp314 wheels resolve** |
| `piper-tts 1.8.0` (+ onnxruntime) | **not installed; pip dry-run confirms cp314 wheels resolve** |

So the setup step is `pip install faster-whisper piper-tts` (documented in README +
a `requirements.txt` in the openai package), then two one-time model downloads:
`Systran/faster-whisper-small` (~240 MB) and one Piper voice (default
`en_US-ryan-medium`, ~60 MB, auto-downloaded on first TTS use).

**Reference numbers** (measured, this CPU): transformers-whisper-tiny on 1 s of
silence ran 49 s *because it hallucinated until its token cap*; the same input capped
at 16 tokens took 1.9 s. Whisper therefore always runs with a token cap, and silence
never reaches the model (endpoint gate, §5). faster-whisper small int8 is expected to
transcribe a normal 3-5 s utterance in roughly 1-4 s — **confirmed in the spike step
of the plan, not assumed in code.**

## 4. Architecture

Reuse the existing `SpeechConversationProvider` seam; the bridge, WebSocket protocol,
state machine, and web client are **unchanged**. One new provider,
`LocalSpeechProvider`, plus one resident Python **sidecar** that owns both audio
models. The LLM call happens in TypeScript (a plain `fetch` to the OpenAI-compatible
`/chat/completions` — no SDK needed).

```
mic → [browser, existing] → WS (existing) → Bridge (existing) → LocalSpeechProvider [NEW]
  1. Endpoint detection (pure TS): 20 ms frames in; adaptive RMS noise floor;
     the learner's turn closes on 600 ms of silence or a 15 s cap.
  2. Buffered voiced span (PCM16 16 kHz) → sidecar {"op":"stt"} →
     faster-whisper small int8 → {"text"}                        (~1-4 s)
  3. Emit transcript { speaker: "learner", text }                 → existing bridge path → UI
  4. LLM: POST {LLM_BASE_URL}/chat/completions, system prompt =
     the rendered conversation prompt the bridge already sends via sendInstruction()
     (+ warmup/intervention instructions), history = the transcript so far
     → coach text                                                 (~5 s on 3B warm)
  5. Emit transcript { speaker: "coach", text }                  → UI shows text first
  6. Sidecar {"op":"tts", text} → Piper (22050 Hz) or Kokoro (24000 Hz) →
     emit audio frames (base64, sampleRate = the engine's real rate, ~20 ms chunks) → existing player
```

- **Sidecar protocol:** one resident Python process, JSON lines over stdio. It loads
  both models at startup (~1-3 s) and stays warm. Ops: `stt` (hex PCM16 in, text out),
  `tts` (text in, hex PCM16 + sample rate out). A sidecar crash closes the session
  with a visible reason (§7).
- **Why split it this way:** the coach's *text* arrives as soon as the LLM finishes
  (step 5); Piper's audio (step 6) streams after, so the learner reads while the
  coach talks. The TS side already holds the prompt/history state; Python does only
  what only Python can do here (the audio models).
- The bridge's existing `sendInstruction()` calls feed the LLM system prompt. The
  state machine is untouched: the coach's reply is a transcript event, not a state
  change.

## 4.1 TTS engine selection and audio pacing (added 2026-10-19)

**Engine switch.** `TTS_ENGINE` selects the engine at sidecar level (read once at
startup, like the other env vars):

| Engine | Model | Rate | Voice env | Sample rate |
|---|---|---|---|---|
| `piper` (default) | Piper ONNX, auto-downloaded on first TTS | 22050 Hz | `PIPER_VOICE` (`en_US-ryan-medium`) | engine-reported |
| `kokoro` | `kokoro-v1.0.onnx` + `voices-v1.0.bin` in `KOKORO_DATA_DIR` | 24000 Hz | `KOKORO_VOICE` (`af_heart`) | engine-reported |

Kokoro is loaded lazily at the first `tts` op, same as Piper. Its two model files
are **not** auto-downloaded — a missing file raises a `tts` error naming the two
files, rather than a silent fallback to Piper (the engine the learner did not ask
for). The sidecar converts Kokoro's float32 output to PCM16 and reports the real
`sampleRate` (24000); the TS provider never hardcodes a rate, so adding an engine
is a sidecar-only change.

The web player already resamples any source rate to the device rate in JS
(band-limited windowed sinc, `apps/web/src/audio/pcm.ts`), so neither engine needs
a client change.

**Pacing — the underrun bug (fixed 2026-10-19).** `emitPacedAudio` originally slept
`frameMs` *after* each send. That makes the send period `frameMs + per-frame cost`
(JSON encode + WS write), measured at **32 ms for 20 ms of audio** — a realtime ratio
of **0.635**. The playback ring buffer holds only ~170 ms (8192 floats), so it starved
continuously and the worklet zero-filled: heard as crackle/noise over audio that was
itself clean. Kokoro's higher rate made it worse (more samples per frame).

The fix is **absolute-deadline pacing**: frame *n* is due at `start + (n+1)*frameMs`,
and the loop sleeps the remaining time rather than a fixed quantum, so per-frame cost
is absorbed instead of accumulated. Measured after: ratio **1.001**, p50 interval
15.9 ms. The pacer uses real `Date.now()`, **not** the injectable endpoint clock —
tests freeze that one, which would turn the sleeps into ever-growing waits.

**General rule:** audio pushed to a bounded ring buffer must arrive at a realtime
ratio ≥ 1. The ratio is the thing to measure when a voice sounds noisy, before
suspecting the model, the engine, or the resampler.

## 5. Endpoint detection

Continuous PCM16 frames from the browser are buffered in TS; a pure function decides
per frame whether the learner is speaking (RMS above an adaptive floor) and closes
the turn after 600 ms below floor (or 15 s hard cap). A 300 ms minimum-voiced rule
drops clicks. **Only the voiced span is sent to Whisper** — pure silence never
reaches the model, which is what keeps the measured 49 s hallucination case out of
the hot path.

## 6. Components

### New files
- `packages/openai/src/local/speech.ts` — `LocalSpeechProvider` implementing
  `SpeechConversationProvider`: owns the sidecar lifecycle, the LLM client, and
  emits `transcript` / `audio` / `closed` events.
- `packages/openai/src/local/endpoint.ts` — pure endpoint-detection logic
  (frames in → turn boundaries + buffered span out). No I/O, unit-testable.
- `packages/openai/src/local/sidecar.ts` — TS manager for the Python sidecar
  (spawn, one JSON request/response per op, timeout, restart-on-crash).
- `packages/openai/scripts/voice_sidecar.py` — Python: loads faster-whisper
  (small, int8) eagerly + the TTS engine lazily; serves `stt`/`tts` JSON-line ops.
  Whisper runs with a hard `max_new_tokens` cap (the verified anti-hallucination
  measure). TTS engine is `TTS_ENGINE` (piper | kokoro, §4.1).
- `packages/openai/requirements.txt` — `faster-whisper`, `piper-tts`
  (`kokoro-onnx` is an optional extra, needed only for `TTS_ENGINE=kokoro`).

### Touched files
- `packages/openai/src/index.ts` — `selectSpeechProvider` accepts `"local"`.
- `apps/api/src/env.ts` + `server.ts` — `PROVIDER: "mock" | "openai" | "local"`;
  new env vars (all overridable, all in `.env.example`):
  - `LLM_BASE_URL` (default `http://localhost:11434/v1`)
  - `LLM_MODEL` (default `llama3.2:3b`)
  - `LLM_API_KEY` (default empty; Ollama ignores it)
  - `WHISPER_MODEL` (default `small`)
  - `TTS_ENGINE` (default `piper`; or `kokoro`)
  - `PIPER_VOICE` (default `en_US-ryan-medium`)
  - `PIPER_DATA_DIR` (default `apps/api/data/piper` — voice files persist)
  - `KOKORO_VOICE` (default `af_heart`), `KOKORO_DATA_DIR` (default `data/kokoro`)
- **Side fix (latent bug):** add a tiny `.env` loader (~8 lines, stdlib, no new
  dependency) so `env.ts` actually reads a `.env` when present — closes the
  README/`cp .env.example .env` gap and is what makes all the above configurable.
  **The path is cwd-relative** (it resolves `".env"` from the API's working
  directory, `apps/api`), so the documented copy target is `apps/api/.env`; a
  root-level `.env` is silently ignored. Making it import.meta-relative is a
  known follow-up (`local-voice-followups`).
- `README.md` — the local path: setup (`pip install -r`, model/voice first-run
  downloads, `PROVIDER=local`), config table, what it does and doesn't do.

## 7. Failure handling

| Failure | Behavior |
|---|---|
| Python deps missing / sidecar won't start | Provider `closed { reason: "stt_unavailable", detail: "pip install faster-whisper piper-tts" }` → session FAILED, reason visible in UI. |
| Sidecar crashes mid-session | `closed { reason: "voice_engine_lost" }` → FAILED (existing path). |
| LLM endpoint down / times out (>30 s) | Learner transcript already landed; one retry; then `closed { reason: "coach_unavailable" }` → FAILED. Never a fabricated coach line. |
| TTS fails after the LLM succeeded | Coach **text** is emitted; audio is skipped with a one-line note; session continues. (Piper's voice download failing, or Kokoro's model files missing.) |
| Noise / clicks | 300 ms min-voiced + adaptive RMS; empty transcriptions dropped silently. |
| First run | Downloads Whisper-small (~240 MB) + Piper voice (~60 MB) once. |

**Known limitation:** Whisper-small (multilingual) handles English well but may
mis-transcribe Farsi slips; Piper's default voice and Kokoro's `af_heart` are both
American English. All overridable via env. Documented in README.

**Latency budget (CPU, this machine):** turn close → +1-4 s learner transcript →
+~5 s coach text (warm 3B; your `gemma4`/`gpt-oss` would be slower) → +~1-2 s coach
audio. **Expect roughly 8-11 s from you stopping to the coach's voice starting.**

## 8. Testing

- **Unit (endpoint.ts):** synthetic frame sequences (silence → voice → silence) →
  correct turn boundaries; pure-silence never produces an STT request.
- **Unit (sidecar.ts):** fake child process (a script that answers the JSON-line
  ops) → request/response pairing, timeout → error, crash → restart/closed.
- **Integration (speech.ts):** provider against the fake sidecar + a stub
  OpenAI-compatible HTTP server → asserts: learner transcript, then coach
  transcript, then audio frames; LLM failure → `closed{coach_unavailable}`;
  Piper failure → transcript without audio, session continues; **audio arrival
  ratio ≥ 0.9** (the pacing regression — this test fails against the old
  sleep-after-send implementation, measured 0.665).
- **Spike (plan step 1, throwaway):** real `pip install`, load faster-whisper
  small int8 + Piper, transcribe a generated utterance, synthesize a line —
  record real latencies; confirms §4's budget or triggers the model-size fallback
  (`base` instead of `small`).
- **Manual smoke:** real mic → all three → one live turn in the UI.
- **Regression:** full `pnpm test` stays green; `mock` and `openai` paths untouched.

## 9. Follow-ups (not in this change)
- Local **analysis + learning plan** via the configurable LLM (replaces the mock's
  canned `SessionAnalysis`) — the "full local loop".
- **`tool_call`** support once a reliable local function-calling model is chosen.
- Better coach voices (e.g. a higher-quality voice for the coach) — **done
  2026-10-19** via `TTS_ENGINE=kokoro` (`KOKORO_VOICE`, default `af_heart`);
  further voices are a `KOKORO_VOICE` value, no code change.

## 10. Decisions (v1 items, disposition)
1. `PROVIDER=local` is opt-in; `mock` stays the default. — **unchanged, assumed OK.**
2. ~~Coach pinned to `llama3.2:3b`~~ → now `LLM_MODEL` env, default `llama3.2:3b`,
   any OpenAI-compatible endpoint. — **per your call.**
3. `.env` loader as a side fix. — **kept; confirm or split.**

**New decisions to confirm:**
4. Piper default voice `en_US-ryan-medium` (neutral American English, ~60 MB).
   Want a different voice? — **resolved 2026-10-19:** Kokoro (`af_heart`) was
   added as a second engine behind `TTS_ENGINE` rather than replacing Piper, so
   both remain one env var apart.
5. Success bar: with `PROVIDER=local`, speak one sentence → your words appear in the
   transcript, the coach's reply text appears, and the coach's voice plays — within
   ~15 s, no key, no cloud. Is that the goal?
