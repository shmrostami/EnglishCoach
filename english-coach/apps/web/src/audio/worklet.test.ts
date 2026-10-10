// Regression: the worklet's ring-buffer compaction used to write past the
// ring (RangeError at worklet.js:17). `write` is an absolute index into the
// ring, so `ring.set(chunk, write)` overflows whenever write + chunk.length
// > ring.length — which the old inUse-based trigger (`write - read +
// chunk.length > ring.length`) missed exactly when read had advanced past 0.
// That state is the normal case for streamed 16 kHz TTS resampled to
// ctx.sampleRate: the worklet drains a bit, then the next chunk arrives.
//
// The worklet module falls back to stub globals outside the worklet scope,
// so the ring-buffer logic is unit-testable here on the main thread.
import { describe, it, expect } from "vitest";
import { createPlaybackProcessor } from "./worklet.js";

const RING = 8192;

interface P {
  ring: Float32Array;
  read: number;
  write: number;
  port: { onmessage: ((ev: { data: Float32Array }) => void) | null };
  process(_inputs: unknown, outputs: [Float32Array[]]): boolean;
}

function makeProcessor(): P {
  return createPlaybackProcessor() as unknown as P;
}
function feed(p: P, chunk: Float32Array) {
  p.port.onmessage?.({ data: chunk });
}
function drain(p: P, n: number): Float32Array {
  const out = new Float32Array(n);
  p.process(null, [[out]]);
  return out;
}

describe("worklet ring buffer", () => {
  it("accepts a sequence of chunks that overflows the ring", () => {
    const p = makeProcessor();
    // ~105 chunks of 1764 floats (~186k total) ≫ the 8192 ring, no draining
    // in between: the old formula threw a RangeError on the 6th chunk.
    for (let i = 0; i < 105; i++) feed(p, new Float32Array(1764).fill(1));
    expect(p.read).toBe(0);
    expect(p.write).toBe(RING);
  });

  it("compacts when the reader has advanced and the chunk still fits the live tail", () => {
    const p = makeProcessor();
    feed(p, new Float32Array(5000).fill(1)); // write = 5000
    drain(p, 1000); // read = 1000, inUse = 4000
    // 4000 (live) + 5000 (chunk) = 9000 > 8192, so compaction is needed;
    // but write(5000) + 5000 = 10000, and the old code computed a NEGATIVE
    // drop (read + chunk - ring = -2192) and then set at index 7192 →
    // 7192 + 5000 = 12192 > 8192 → RangeError.
    feed(p, new Float32Array(5000).fill(2));
    expect(p.read).toBe(0);
    expect(p.write).toBe(RING);
    expect(p.ring[0]).toBe(1); // oldest survivor is from chunk 1's tail
    expect(p.ring[RING - 1]).toBe(2); // newest sample intact
  });

  it("compacts when write + chunk overflows the ring even though the live tail alone fits", () => {
    const p = makeProcessor();
    feed(p, Float32Array.from({ length: 6000 }, (_, i) => i)); // write = 6000
    drain(p, 5000); // read = 5000, inUse = 1000
    // inUse(1000) + chunk(6000) = 7000 < 8192 → old trigger did NOT fire,
    // but write(6000) + 6000 = 12000 > 8192 → old code set at 6000 →
    // 6000 + 6000 = 12000 > 8192 → RangeError.
    feed(p, Float32Array.from({ length: 6000 }, (_, i) => i + 10_000));
    // Ring now: [0..1000) = first chunk indices 5000..5999 (5000..5999),
    //            [1000..7000) = second chunk (10000..15999).
    const out = drain(p, RING);
    expect(out[0]).toBe(5000);
    expect(out[999]).toBe(5999);
    expect(out[1000]).toBe(10_000);
    expect(out[6999]).toBe(15_999);
    expect(out[7000]).toBe(0); // underrun tail
  });

  it("preserves FIFO order across a real drop of the oldest samples", () => {
    const p = makeProcessor();
    feed(p, Float32Array.from({ length: 6000 }, (_, i) => i)); // write = 6000
    drain(p, 1000); // read = 1000, inUse = 5000
    // inUse(5000) + chunk(5000) = 10000 > 8192 → real drop of 1808 oldest.
    feed(p, Float32Array.from({ length: 5000 }, (_, i) => i + 100_000));
    // Survivors from chunk 1: indices 1000+1808..5999 = 2808..5999 (3192 f).
    // Ring: [0..3192) = 2808..5999, [3192..8192) = 100000..104999.
    const out = drain(p, RING);
    expect(out[0]).toBe(2808);
    expect(out[3191]).toBe(5999);
    expect(out[3192]).toBe(100_000);
    expect(out[8191]).toBe(104_999);
  });

  it("handles a chunk larger than the ring without throwing", () => {
    const p = makeProcessor();
    feed(p, new Float32Array(20_000).fill(9));
    expect(p.write).toBe(RING);
    const out = drain(p, 10);
    expect(out.every((v) => v === 9)).toBe(true);
  });
});
