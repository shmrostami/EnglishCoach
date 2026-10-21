import { describe, it, expect } from "vitest";
import { calculateOverall, WEIGHTS } from "./scoring.js";

describe("calculateOverall", () => {
  it("weights dimensions per spec", () => {
    const s = { fluency: 1, grammar: 1, vocabulary: 1, pronunciation: 1, coherence: 1, interaction: 1 };
    expect(calculateOverall(s)).toBeCloseTo(1);
    const one = { fluency: 1, grammar: 0, vocabulary: 0, pronunciation: 0, coherence: 0, interaction: 0 };
    expect(calculateOverall(one)).toBeCloseTo(0.25);
  });
  it("weights sum to 1", () => {
    const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1);
  });
  it("excludes an unassessed dimension and renormalizes the rest", () => {
    // Pronunciation is null (not assessed): it must neither score 0 nor drag
    // the overall down. The remaining five dimensions carry the full weight.
    const s = { fluency: 1, grammar: 1, vocabulary: 1, pronunciation: null, coherence: 1, interaction: 1 };
    expect(calculateOverall(s)).toBeCloseTo(1);
    // The five assessed weights sum to 0.85, so the renormalized overall is
    // fluency's weighted share over 0.85 — not 0.25 (the un-renormalized sum).
    const zeroOthers = { fluency: 1, grammar: 0, vocabulary: 0, pronunciation: null, coherence: 0, interaction: 0 };
    expect(calculateOverall(zeroOthers)).toBeCloseTo(0.25 / 0.85);
  });
  it("returns 0 when nothing was assessed", () => {
    const s = { fluency: 0, grammar: 0, vocabulary: 0, pronunciation: null, coherence: 0, interaction: 0 };
    expect(calculateOverall(s)).toBe(0);
  });
});
