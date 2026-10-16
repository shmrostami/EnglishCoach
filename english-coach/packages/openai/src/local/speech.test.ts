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
