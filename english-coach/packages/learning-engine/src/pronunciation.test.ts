import { describe, it, expect } from "vitest";
import {
  measureAudio, scorePronunciation, decodePcm16, encodePcm16,
  PRONUNCIATION_RUBRIC_VERSION,
} from "./pronunciation.js";

const SR = 16000;

/**
 * A synthetic utterance: bursts of voiced energy separated by silence.
 *
 * `gapPattern` lets the gaps vary, which is what rhythm is measured on — a
 * uniform gap pattern is uniform however long the gap is.
 */
function syntheticUtterance(opts: {
  syllables?: number; syllableSec?: number; gapSec?: number; amplitude?: number;
  gapPattern?: number[];
} = {}): Float32Array {
  const syllables = opts.syllables ?? 6;
  const syllableSec = opts.syllableSec ?? 0.15;
  const gapSec = opts.gapSec ?? 0.08;
  const amplitude = opts.amplitude ?? 0.6;
  const gaps = opts.gapPattern ?? new Array(syllables).fill(gapSec);
  const out: number[] = [];
  for (let s = 0; s < syllables; s++) {
    const len = Math.round(SR * syllableSec);
    const gap = Math.round(SR * (gaps[s] ?? gapSec));
    for (let i = 0; i < len; i++) {
      // A decaying formant-ish shape, so each burst has its own peak.
      const env = Math.sin((Math.PI * i) / len);
      out.push(amplitude * env * Math.sin((2 * Math.PI * 220 * i) / SR));
    }
    for (let i = 0; i < gap; i++) out.push(0);
  }
  return Float32Array.from(out);
}

describe("measureAudio", () => {
  it("finds the syllables in a synthetic utterance", () => {
    const m = measureAudio(syntheticUtterance({ syllables: 6 }), SR);
    expect(m.syllableCount).toBeGreaterThanOrEqual(5);
    expect(m.syllableCount).toBeLessThanOrEqual(7);
  });

  it("reports the duration and sample rate", () => {
    const m = measureAudio(syntheticUtterance({ syllables: 4 }), SR);
    expect(m.sampleRate).toBe(SR);
    expect(m.durationSec).toBeGreaterThan(0.5);
  });

  it("measures silence as no speech and no syllables", () => {
    const m = measureAudio(new Float32Array(SR), SR);
    expect(m.speechRatio).toBe(0);
    expect(m.syllableCount).toBe(0);
  });

  it("returns zero measurements for an empty buffer instead of dividing by zero", () => {
    const m = measureAudio(new Float32Array(0), SR);
    expect(m.durationSec).toBe(0);
    expect(Number.isFinite(m.rhythmVariability)).toBe(true);
  });

  it("is deterministic", () => {
    const a = measureAudio(syntheticUtterance(), SR);
    const b = measureAudio(syntheticUtterance(), SR);
    expect(a).toEqual(b);
  });
});

describe("scorePronunciation", () => {
  it("refuses to score a signal with too little to judge", () => {
    const m = measureAudio(syntheticUtterance({ syllables: 1 }), SR);
    const s = scorePronunciation(m);
    // Not zero — unmeasured. Confidence says so.
    expect(s.confidence).toBe(0);
  });

  it("scores a clear utterance with a confidence that grows with the audio", () => {
    const short = scorePronunciation(measureAudio(syntheticUtterance({ syllables: 6 }), SR));
    const long = scorePronunciation(measureAudio(syntheticUtterance({ syllables: 20 }), SR));
    expect(short.confidence).toBeGreaterThan(0);
    expect(long.confidence).toBeGreaterThan(short.confidence);
    expect(long.confidence).toBeLessThanOrEqual(1);
  });

  it("scores every dimension within 0..1", () => {
    const s = scorePronunciation(measureAudio(syntheticUtterance({ syllables: 12 }), SR));
    for (const v of [s.intelligibility, s.stress, s.rhythm, s.confidence]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("measures articulation, not volume: a quiet but clear speaker scores like a loud one", () => {
    const loud = scorePronunciation(measureAudio(syntheticUtterance({ amplitude: 0.9 }), SR));
    const quiet = scorePronunciation(measureAudio(syntheticUtterance({ amplitude: 0.05 }), SR));
    // Energy is normalised against the peak, so loudness is not intelligibility
    // — a shy learner with clear speech is not scored as unintelligible.
    expect(loud.intelligibility).toBeCloseTo(quiet.intelligibility, 3);
  });

  it("scores a machine-even utterance worse on rhythm than a varied one", () => {
    // Rhythm measures the VARIATION between syllable gaps. A perfectly even
    // series is the degenerate case (variability 0); real speech varies, and
    // a moderate variation is the target.
    const even = scorePronunciation(measureAudio(syntheticUtterance({ syllables: 12, gapSec: 0.08 }), SR));
    const varied = scorePronunciation(measureAudio(syntheticUtterance({
      syllables: 12, gapPattern: [0.08, 0.14, 0.10, 0.16, 0.09, 0.13, 0.11, 0.15, 0.08, 0.12, 0.14, 0.10],
    }), SR));
    expect(even.rhythm).toBeLessThan(varied.rhythm);
  });

  it("measures the variation it claims to measure", () => {
    const even = measureAudio(syntheticUtterance({ syllables: 12, gapSec: 0.08 }), SR);
    const varied = measureAudio(syntheticUtterance({
      syllables: 12, gapPattern: [0.08, 0.14, 0.10, 0.16, 0.09, 0.13, 0.11, 0.15, 0.08, 0.12, 0.14, 0.10],
    }), SR);
    expect(even.rhythmVariability).toBeCloseTo(0, 3);
    expect(varied.rhythmVariability).toBeGreaterThan(0);
  });

  it("names its rubric version", () => {
    expect(PRONUNCIATION_RUBRIC_VERSION).toBe("acoustic-prosody-v1");
  });
});

describe("pcm encoding", () => {
  it("round-trips samples within 16-bit precision", () => {
    const samples = Float32Array.from([0, 0.5, -0.5, 1, -1]);
    const decoded = decodePcm16(encodePcm16(samples));
    expect(decoded.length).toBe(samples.length);
    for (let i = 0; i < samples.length; i++) {
      expect(decoded[i]).toBeCloseTo(samples[i], 3);
    }
  });

  it("clamps a sample outside [-1, 1]", () => {
    const decoded = decodePcm16(encodePcm16(Float32Array.from([2, -2])));
    expect(decoded[0]).toBeLessThanOrEqual(1);
    expect(decoded[1]).toBeGreaterThanOrEqual(-1);
  });
});
