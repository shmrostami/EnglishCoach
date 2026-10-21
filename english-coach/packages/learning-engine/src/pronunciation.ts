import { clamp01 } from "./mastery.js";

/**
 * Acoustic pronunciation measurement (spec §24).
 *
 * Everything here is computed from the PCM samples — never from the
 * transcript, and never from the words. A transcript says what was said; it
 * says nothing about how. This is the evidence §12.1 requires before a
 * pronunciation number may exist at all.
 *
 * The measures are the standard signal-based ones, deliberately conservative:
 *
 * - **intelligibility** — how much of the signal is usable speech. Measured
 *   from the ratio of voiced energy to total energy, and from how much of the
 *   utterance is above the noise floor.
 * - **stress** — whether the learner's stressed syllables carry more energy
 *   than their unstressed ones. Measured as the spread of per-syllable peak
 *   energy against the mean.
 * - **rhythm** — regularity of the syllable intervals. Measured as the
 *   coefficient of variation of the syllable durations: an even, machine-like
 *   rhythm and a wildly uneven one are both poor, so the score peaks in the
 *   middle.
 *
 * These are NOT phoneme-level scores and are not claimed to be. They are
 * fluency-and-prosody measurements, and the rubric version says so.
 */
export const PRONUNCIATION_RUBRIC_VERSION = "acoustic-prosody-v1";

export interface AcousticMeasurements {
  /** Seconds of audio. */
  durationSec: number;
  /** Samples per second. */
  sampleRate: number;
  /** Fraction of the signal that is voiced speech. */
  voicedRatio: number;
  /** Mean energy of voiced frames, 0..1. */
  meanVoicedEnergy: number;
  /** Coefficient of variation of syllable durations. */
  rhythmVariability: number;
  /** Number of energy peaks found — the syllable estimate. */
  syllableCount: number;
  /** Ratio of the loudest syllable to the mean syllable. */
  stressContrast: number;
  /** Samples above the noise floor, 0..1. */
  speechRatio: number;
}

export interface PronunciationScores {
  intelligibility: number;
  stress: number;
  rhythm: number;
  confidence: number;
}

/**
 * Measures a PCM16 buffer.
 *
 * `pcm` is mono 16-bit samples at `sampleRate`. An empty or too-short buffer
 * yields zero measurements rather than a guess.
 */
export function measureAudio(pcm: Float32Array, sampleRate: number): AcousticMeasurements {
  const empty: AcousticMeasurements = {
    durationSec: 0, sampleRate, voicedRatio: 0, meanVoicedEnergy: 0,
    rhythmVariability: 0, syllableCount: 0, stressContrast: 0, speechRatio: 0,
  };
  if (pcm.length < sampleRate / 10) return empty;

  // Frame the signal at 25 ms with a 10 ms hop — enough to resolve syllabic
  // energy changes without smearing them.
  const frameLen = Math.max(1, Math.round(sampleRate * 0.025));
  const hop = Math.max(1, Math.round(sampleRate * 0.01));
  const frameCount = Math.max(1, Math.floor((pcm.length - frameLen) / hop) + 1);
  const energies = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    const start = f * hop;
    let sum = 0;
    for (let i = 0; i < frameLen && start + i < pcm.length; i++) {
      const v = pcm[start + i];
      sum += v * v;
    }
    energies[f] = Math.sqrt(sum / frameLen);
  }

  // The noise floor is the quietest tenth of the frames.
  const sorted = Array.from(energies).sort((a, b) => a - b);
  const floor = sorted[Math.max(0, Math.floor(sorted.length * 0.1) - 1)] ?? 0;
  const peak = sorted[sorted.length - 1] ?? 0;
  // A threshold between the floor and the peak, weighted toward the floor so
  // quiet speech still counts as speech.
  const threshold = floor + (peak - floor) * 0.15;
  const speechFrames = Array.from(energies).filter((e) => e > threshold);
  const speechRatio = speechFrames.length / frameCount;

  // Voiced frames: above the threshold AND not silent. Energy is normalised
  // against the peak, so it is a 0..1 shape, not an absolute loudness.
  const norm = (e: number) => (peak > 0 ? e / peak : 0);
  const voicedEnergies = energies.filter((e) => e > threshold).map(norm);
  const meanVoicedEnergy = voicedEnergies.length > 0
    ? voicedEnergies.reduce((a, b) => a + b, 0) / voicedEnergies.length
    : 0;

  // Syllable peaks: a local maximum above the threshold, with a refractory
  // period so one long vowel is not counted as several.
  const refractory = Math.round(sampleRate * 0.12 / hop);
  const peaks: number[] = [];
  for (let f = 1; f < frameCount - 1; f++) {
    if (energies[f] > threshold && energies[f] >= energies[f - 1] && energies[f] > energies[f + 1]) {
      const last = peaks.length > 0 ? peaks[peaks.length - 1] : -refractory - 1;
      if (f - last >= refractory) peaks.push(f);
    }
  }
  const syllableCount = peaks.length;

  // Syllable durations: the gap between successive peaks, in seconds.
  const durations: number[] = [];
  for (let i = 1; i < peaks.length; i++) {
    durations.push(((peaks[i] - peaks[i - 1]) * hop) / sampleRate);
  }
  const meanDur = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  const variance = durations.length > 0
    ? durations.reduce((a, d) => a + (d - meanDur) ** 2, 0) / durations.length
    : 0;
  const rhythmVariability = meanDur > 0 ? Math.sqrt(variance) / meanDur : 0;

  // Stress contrast: the loudest syllable against the mean syllable energy.
  const peakEnergies = peaks.map((f) => norm(energies[f]));
  const meanPeak = peakEnergies.length > 0
    ? peakEnergies.reduce((a, b) => a + b, 0) / peakEnergies.length
    : 0;
  const stressContrast = meanPeak > 0 ? Math.max(...peakEnergies) / meanPeak : 0;

  return {
    durationSec: pcm.length / sampleRate,
    sampleRate,
    voicedRatio: speechRatio,
    meanVoicedEnergy,
    rhythmVariability,
    syllableCount,
    stressContrast,
    speechRatio,
  };
}

/**
 * Turns acoustic measurements into the three pronunciation dimensions.
 *
 * Confidence rises with how much audio there was and how much of it was
 * usable speech: a two-second sample cannot support a confident judgement,
 * and saying so is better than a precise-looking number from thin evidence.
 */
export function scorePronunciation(m: AcousticMeasurements): PronunciationScores {
  if (m.durationSec < 0.5 || m.syllableCount < 2) {
    // Too little to judge. Not zero — unmeasured.
    return { intelligibility: 0, stress: 0, rhythm: 0, confidence: 0 };
  }

  // Intelligibility: how much of the signal is usable speech, tempered by how
  // strong the voiced energy is.
  const intelligibility = clamp01(m.speechRatio * 0.6 + m.meanVoicedEnergy * 0.4);

  // Stress: contrast between the loudest syllable and the mean. A ratio of
  // 1 means every syllable is equally loud (no stress), 3+ is strong stress.
  const stress = clamp01((m.stressContrast - 1) / 2);

  // Rhythm: an even rhythm (variability ~0.25) is the target. Both very even
  // and very uneven score lower, so the curve peaks in the middle.
  const ideal = 0.25;
  const deviation = Math.abs(m.rhythmVariability - ideal);
  const rhythm = clamp01(1 - deviation * 2.2);

  // Confidence: more audio, more of it speech, more syllables to judge.
  const durationFactor = clamp01(m.durationSec / 8);
  const confidence = Number(clamp01(
    durationFactor * 0.45 + m.speechRatio * 0.35 + clamp01(m.syllableCount / 12) * 0.2,
  ).toFixed(4));

  return {
    intelligibility: Number(intelligibility.toFixed(4)),
    stress: Number(stress.toFixed(4)),
    rhythm: Number(rhythm.toFixed(4)),
    confidence,
  };
}

/** Decodes base64 PCM16 into normalised float samples in [-1, 1]. */
export function decodePcm16(base64: string): Float32Array {
  const bytes = Buffer.from(base64, "base64");
  const count = Math.floor(bytes.length / 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = bytes.readInt16LE(i * 2) / 32768;
  }
  return out;
}

/** Encodes float samples as base64 PCM16. */
export function encodePcm16(samples: Float32Array): string {
  const bytes = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    bytes.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return bytes.toString("base64");
}
