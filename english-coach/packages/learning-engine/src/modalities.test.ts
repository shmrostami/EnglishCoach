import { describe, it, expect } from "vitest";
import { MODALITIES, assessModality, canScorePronunciation } from "./modalities.js";

describe("assessModality", () => {
  it("scores only the skills its modality can evidence", () => {
    const r = assessModality({ modality: "listening", accuracy: 0.8 });
    expect(r.dimensions.map((d) => d.skillCode)).toEqual(["fluency.continuity", "vocabulary.breadth"]);
    expect(r.dimensions.every((d) => d.status === "assessed")).toBe(true);
  });

  it("does not score pronunciation from a listening task", () => {
    const r = assessModality({ modality: "listening", accuracy: 1 });
    expect(r.dimensions.some((d) => d.skillCode.startsWith("pronunciation"))).toBe(false);
  });

  it("refuses a pronunciation score without audio evidence, and says so", () => {
    const r = assessModality({ modality: "pronunciation", accuracy: 0.9, hasAudioEvidence: false });
    expect(r.dimensions.every((d) => d.status === "not_assessed")).toBe(true);
    expect(r.dimensions.every((d) => d.score === null)).toBe(true);
    expect(r.summary).toContain("not assessed");
  });

  it("scores pronunciation when the pipeline returned audio evidence", () => {
    const r = assessModality({ modality: "pronunciation", accuracy: 0.9, hasAudioEvidence: true });
    expect(r.dimensions.every((d) => d.status === "assessed")).toBe(true);
    expect(r.dimensions.every((d) => (d.score ?? 0) > 0)).toBe(true);
  });

  it("weights coverage into the score — a partly-answered task scores less", () => {
    const full = assessModality({ modality: "reading", accuracy: 0.8, coverage: 1 });
    const partial = assessModality({ modality: "reading", accuracy: 0.8, coverage: 0.5 });
    expect(partial.dimensions[0].score!).toBeLessThan(full.dimensions[0].score!);
  });

  it("clamps an accuracy outside 0..1", () => {
    const r = assessModality({ modality: "writing", accuracy: 1.5 });
    expect(r.dimensions[0].score).toBeLessThanOrEqual(1);
  });

  it("gives every modality its own rubric version", () => {
    const versions = MODALITIES.map((m) => m.rubricVersion);
    expect(new Set(versions).size).toBe(versions.length);
  });
});

describe("canScorePronunciation", () => {
  it("needs audio evidence, always", () => {
    expect(canScorePronunciation(true)).toBe(true);
    expect(canScorePronunciation(false)).toBe(false);
  });
});
