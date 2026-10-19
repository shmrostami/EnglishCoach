import { describe, it, expect } from "vitest";
import { floatToPcm16, pcm16ToFloat, resampleLinear, resampleSinc, SincResampler, bytesToBase64, base64ToBytes } from "./pcm.js";

describe("pcm16 round trip", () => {
  it("encodes and decodes with quantization error < 1/32768", () => {
    const input = new Float32Array([0, 0.5, -0.5, 1, -1, 0.123, -0.987]);
    const pcm = floatToPcm16(input);
    const back = pcm16ToFloat(pcm);
    for (let i = 0; i < input.length; i++) {
      expect(Math.abs(back[i] - input[i])).toBeLessThan(1 / 32768 + 1e-9);
    }
  });
  it("clamps out-of-range input", () => {
    const pcm = floatToPcm16(new Float32Array([2.0, -3.0]));
    expect(pcm[0]).toBe(0x7fff);
    expect(pcm[1]).toBe(-0x8000);
  });
});

describe("resampleLinear", () => {
  it("returns a copy at equal rates", () => {
    const in_ = new Float32Array([1, 2, 3]);
    const out = resampleLinear(in_, 16000, 16000);
    expect(out).toEqual(new Float32Array([1, 2, 3]));
    expect(out).not.toBe(in_);
  });
  it("halves length when downsampling 2x", () => {
    const in_ = new Float32Array([0, 1, 0, -1, 0, 1, 0, -1]);
    const out = resampleLinear(in_, 32000, 16000);
    expect(out.length).toBe(4);
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[2]).toBeCloseTo(0, 5);
  });
  it("keeps a constant signal constant", () => {
    const in_ = new Float32Array(100).fill(0.42);
    const out = resampleLinear(in_, 16000, 44100);
    expect(out.length).toBe(Math.round(100 * 44100 / 16000));
    for (const v of out) expect(v).toBeCloseTo(0.42, 4);
  });
});

describe("base64 over bytes", () => {
  it("round-trips arbitrary buffers (1, 2, and 3-byte-aligned lengths)", () => {
    for (const len of [1, 2, 3, 4, 5, 17, 255]) {
      const u8 = new Uint8Array(len);
      for (let i = 0; i < len; i++) u8[i] = (i * 37 + 11) & 0xff;
      expect(Array.from(base64ToBytes(bytesToBase64(u8)))).toEqual(Array.from(u8));
    }
  });
  it("matches Buffer base64", () => {
    const u8 = new Uint8Array([0, 255, 65, 128, 1]);
    expect(bytesToBase64(u8)).toBe(Buffer.from(u8).toString("base64"));
  });
});

// DFT amplitude at a single frequency (phase-free) - a one-bin spectrum
// probe for the resampler image tests below.
function dftAmp(x: Float32Array, rate: number, hz: number): number {
  let re = 0;
  let im = 0;
  for (let n = 0; n < x.length; n++) {
    const w = (2 * Math.PI * hz * n) / rate;
    re += x[n] * Math.cos(w);
    im -= x[n] * Math.sin(w);
  }
  return (2 * Math.hypot(re, im)) / x.length;
}

describe("resampleSinc", () => {
  it("returns a copy at equal rates", () => {
    const in_ = new Float32Array([1, 2, 3]);
    const out = resampleSinc(in_, 22050, 22050);
    expect(out).toEqual(new Float32Array([1, 2, 3]));
    expect(out).not.toBe(in_);
  });
  it("keeps a constant signal constant (windowed DC gain is normalized out)", () => {
    const in_ = new Float32Array(100).fill(0.42);
    const out = resampleSinc(in_, 16000, 44100);
    expect(out.length).toBe(Math.round((100 * 44100) / 16000));
    for (const v of out) expect(v).toBeCloseTo(0.42, 4);
  });
  it("preserves an in-band tone's level", () => {
    const N = 11025; // 0.5 s @ 22050, 1000 Hz = 500 whole cycles
    const in_ = new Float32Array(N);
    for (let i = 0; i < N; i++) in_[i] = Math.sin((2 * Math.PI * 1000 * i) / 22050);
    const out = resampleSinc(in_, 22050, 48000);
    expect(out.length).toBe(24000);
    const amp = dftAmp(out, 48000, 1000);
    expect(amp).toBeGreaterThan(0.9);
    expect(amp).toBeLessThan(1.1);
  });
  it("pushes upsample spectral images far below linear interpolation", () => {
    const N = 11025; // 0.5 s @ 22050; 8000 Hz is in-band (below the 11025 Hz cutoff)
    const in_ = new Float32Array(N);
    for (let i = 0; i < N; i++) in_[i] = Math.sin((2 * Math.PI * 8000 * i) / 22050);
    const lin = resampleLinear(in_, 22050, 48000);
    const sinc = resampleSinc(in_, 22050, 48000);
    const toneLin = dftAmp(lin, 48000, 8000);
    const imgLin = dftAmp(lin, 48000, 14050); // 22050 - 8000: the mirrored image
    const toneSinc = dftAmp(sinc, 48000, 8000);
    const imgSinc = dftAmp(sinc, 48000, 14050);
    expect(imgLin / toneLin).toBeGreaterThan(0.03); // the probe really sees the linear image (~-15 dB)
    expect(imgSinc / toneSinc).toBeLessThan(0.01); // <= -40 dB relative to the tone
    expect(imgSinc).toBeLessThan(imgLin / 10); // at least 20 dB better than linear
  });
});

describe("SincResampler (streaming, 20 ms frames)", () => {
  // The player feeds each 20 ms TTS frame to ONE resampler and posts the
  // returned Float32Array to the worklet. This verifies the streamed output
  // equals a one-shot resample of the whole utterance (no frame-boundary
  // artifacts). Values are copied to a plain number[] at the push() boundary
  // because vitest's worker corrupts long-lived multi-push Float32Arrays in
  // transit on this machine; the copied value is exactly what the browser
  // (real V8, unaffected) receives.
  it("matches a one-shot resample across frame boundaries", () => {
    const inR = 22050, outR = 48000;
    const N = 4410; // 0.2 s
    const in_ = new Float32Array(N);
    for (let i = 0; i < N; i++) in_[i] = Math.sin((2 * Math.PI * 1000 * i) / inR);
    const ref = Array.from(resampleSinc(in_, inR, outR));
    const r = new SincResampler();
    const stream: number[] = [];
    const frameLen = 441; // 20 ms
    for (let off = 0; off < N; off += frameLen) {
      const out = r.push(in_.subarray(off, off + frameLen), inR, outR);
      for (const v of Array.from(out)) stream.push(v);
    }
    for (const v of Array.from(r.flush())) stream.push(v);
    expect(stream.length).toBe(ref.length);
    let maxDev = 0;
    for (let i = 0; i < stream.length; i++) maxDev = Math.max(maxDev, Math.abs(stream[i] - ref[i]));
    expect(maxDev).toBeLessThan(1e-3);
  });
});
