import { describe, it, expect, afterAll, beforeAll } from "vitest";
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

/**
 * One stub LLM per test. A single shared server let a request from a previous
 * test land in the next one (the provider keeps its HTTP call alive until it
 * answers), which broke the call counts of both neighbours.
 */
interface StubLlm {
  port: number;
  calls: number;
  /** The next request gets a 500 (the retry test's lever). */
  failFirst: boolean;
  close: () => void;
}

async function startLlm(): Promise<StubLlm> {
  const stub: StubLlm = { port: 0, calls: 0, failFirst: false, close: () => {} };
  // A 500 response is REQUIRED for the retry test: the SDK only treats a
  // non-2xx status as a failure — a 200 with an empty choices array resolves
  // as a (empty) success, so the provider's retry would never fire.
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      stub.calls += 1;
      if (stub.failFirst) {
        stub.failFirst = false; // the failure is one-shot
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "model overloaded" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Sure — let's talk about that." } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  stub.port = (server.address() as AddressInfo).port;
  stub.close = () => server.close();
  return stub;
}

/**
 * A port nothing listens on. It is taken from BELOW the OS ephemeral range
 * (Windows hands out 49152+), so no later outbound connection can be assigned
 * it — an ephemeral port that is closed and released can be re-bound by the
 * next stub server, which would make the "LLM is down" test pass by accident.
 */
async function freeLowPort(): Promise<number> {
  for (let port = 20_000; port < 20_100; port++) {
    const server = createServer();
    const free = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (!free) { server.close(); continue; }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }
  throw new Error("no free low port found");
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ec-speech-"));
  script = join(dir, "fake_sidecar.mjs");
  writeFileSync(script, FAKE, "utf8");
  scriptFail = join(dir, "fake_sidecar_fail.mjs");
  writeFileSync(scriptFail, FAKE_FAIL, "utf8");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let t = 1_000_000;
function makeProvider(llmBaseURL: string, scriptPath: string = script, over: Partial<LocalProviderOptions> = {}): {
  p: LocalSpeechProvider;
  sidecar: VoiceSidecar;
  events: ProviderEvent[];
  feedFrames: (voicedCount: number, silentCount: number) => void;
} {
  const sidecar = new VoiceSidecar({ python: process.execPath, script: scriptPath });
  const events: ProviderEvent[] = [];
  const p = new LocalSpeechProvider({
    llmBaseURL,
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for a condition instead of a fixed number of milliseconds. The whole
 * pipeline is spawn → sidecar handshake → STT → LLM → TTS; under a loaded
 * machine a hardcoded 400 ms was not enough for any of it, and the failures
 * looked like logic bugs.
 */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** Wait until a counter stops moving — i.e. the audio stream ended. */
async function waitQuiet(count: () => number, quietMs = 300, timeoutMs = 30_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = count();
  let stableSince = Date.now();
  for (;;) {
    await sleep(25);
    const now = count();
    if (now !== last) { last = now; stableSince = Date.now(); }
    else if (Date.now() - stableSince >= quietMs) return now;
    if (Date.now() > deadline) throw new Error("timed out waiting for the stream to end");
  }
}

const learners = (events: ProviderEvent[]) =>
  events.filter((e): e is Extract<ProviderEvent, { t: "transcript" }> => e.t === "transcript" && e.turn.speaker === "learner");
const coaches = (events: ProviderEvent[]) =>
  events.filter((e): e is Extract<ProviderEvent, { t: "transcript" }> => e.t === "transcript" && e.turn.speaker === "coach");
const audioFrames = (events: ProviderEvent[]) =>
  events.filter((e): e is Extract<ProviderEvent, { t: "audio" }> => e.t === "audio");

describe("LocalSpeechProvider", () => {
  it("connect() resolves with 'connected' once the sidecar is ready (and never rejects)", async () => {
    const llm = await startLlm();
    const { p, sidecar, events } = makeProvider(`http://127.0.0.1:${llm.port}/v1`);
    await p.connect((e) => events.push(e));
    expect(events.filter((e) => e.t === "connected")).toHaveLength(1);
    p.close();
    sidecar.close();
    llm.close();
  });

  it("transcribes a learner turn and replies through the LLM: learner text, coach text, then audio (text BEFORE audio)", async () => {
    const llm = await startLlm();
    const { p, sidecar, events, feedFrames } = makeProvider(`http://127.0.0.1:${llm.port}/v1`);
    await p.connect((e) => events.push(e)); // the handshake, not a guess at its duration
    feedFrames(10, 8); // 1 s voice + 0.8 s silence → endpoint closes the turn
    await waitFor(() => coaches(events).length > 0, "the coach's reply");
    await waitFor(() => audioFrames(events).length > 0, "the first audio frame");

    const learner = learners(events);
    const coach = coaches(events);
    const audio = audioFrames(events);
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
    llm.close();
  }, 30_000);

  it("LLM down (both attempts) → closed{coach_unavailable}, the learner's words still landed, nothing invented (Review Focus 2)", async () => {
    // Point the provider at a port nothing listens on (Ollama-not-running surface).
    // A LOW port, not an ephemeral one: the ephemeral range is handed out again
    // to the next outbound connection, so a closed ephemeral port can be
    // re-bound by a later stub and make this test "succeed" by accident.
    const deadPort = await freeLowPort();
    const { p, sidecar, events, feedFrames } = makeProvider(`http://127.0.0.1:${deadPort}/v1`);
    await p.connect((e) => events.push(e));
    feedFrames(10, 8);
    await waitFor(() => events.some((e) => e.t === "closed"), "the closed event");

    const closed = events.find((e) => e.t === "closed");
    expect(closed).toMatchObject({ t: "closed", reason: "coach_unavailable" });
    expect(learners(events)).toHaveLength(1); // the learner's words still landed
    expect(coaches(events)).toHaveLength(0); // nothing invented
    p.close();
    sidecar.close();
  }, 30_000);

  it("LLM succeeds only on the retry (one retry is exactly one extra call)", async () => {
    const llm = await startLlm();
    llm.failFirst = true; // attempt 1 → 500, attempt 2 → 200
    const { p, sidecar, events, feedFrames } = makeProvider(`http://127.0.0.1:${llm.port}/v1`);
    await p.connect((e) => events.push(e));
    feedFrames(10, 8);
    await waitFor(() => coaches(events).length > 0, "the coach's reply");
    const coach = coaches(events);
    expect(coach).toHaveLength(1);
    expect(coach[0].turn.text).toBe("Sure — let's talk about that."); // the retry's reply
    expect(llm.calls).toBe(2); // 500 then 200 — exactly one retry, no third call
    expect(events.some((e) => e.t === "closed")).toBe(false);
    p.close();
    sidecar.close();
    llm.close();
  }, 30_000);

  it("paces audio at realtime: frames must not take longer than the audio they carry", async () => {
    // Regression: sleep-after-send made the period frameMs + per-frame cost
    // (32 ms measured for 20 ms frames), so the client's ~170 ms ring buffer
    // starved continuously — heard as crackle/noise over clean TTS audio.
    // frameMs is 5 here purely to keep the test fast; the ratio is what matters.
    const llm = await startLlm();
    const { p, sidecar, events, feedFrames } = makeProvider(`http://127.0.0.1:${llm.port}/v1`, script, { frameMs: 5 });
    const stamps: number[] = [];
    await p.connect((e) => {
      events.push(e);
      if (e.t === "audio") stamps.push(Date.now());
    });
    feedFrames(10, 8);
    // The fake answers with 2 s of audio; at frameMs=5 that is 400 frames and
    // 2 s of wall clock. Wait for the stream to END instead of guessing.
    const frames = await waitQuiet(() => stamps.length);
    expect(frames).toBeGreaterThan(100); // it actually streamed
    // Realtime ratio over the span the frames cover: audio time carried vs
    // wall time elapsed. Sleep-after-send gave ~0.63 (20 ms of audio every
    // 32 ms); deadline pacing keeps this at or above 1.
    const span = (stamps[stamps.length - 1] - stamps[0]) / 1000;
    const audioSeconds = (stamps.length * 5) / 1000;
    expect(audioSeconds / span).toBeGreaterThan(0.9);
    p.close();
    sidecar.close();
    llm.close();
  }, 40_000);

  it("Piper failing after the LLM succeeded: coach text lands, no audio, session keeps going (no closed event)", async () => {
    const llm = await startLlm();
    const { p, sidecar, events, feedFrames } = makeProvider(`http://127.0.0.1:${llm.port}/v1`, scriptFail); // tts-always-fails fake; the LLM is still the working stub
    await p.connect((e) => events.push(e));
    feedFrames(10, 8);
    await waitFor(() => coaches(events).length > 0, "the coach's reply");
    expect(coaches(events).length).toBeGreaterThan(0); // text landed
    expect(audioFrames(events)).toHaveLength(0); // no audio
    expect(events.some((e) => e.t === "closed")).toBe(false); // session continues
    p.close();
    sidecar.close();
    llm.close();
  }, 30_000);
});
