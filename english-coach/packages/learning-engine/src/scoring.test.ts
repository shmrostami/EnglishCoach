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
});
