import { describe, it, expect } from "vitest";
import { floatToPcm16, pcm16ToFloat, resampleLinear, bytesToBase64, base64ToBytes } from "./pcm.js";

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
