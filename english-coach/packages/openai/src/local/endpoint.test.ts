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
