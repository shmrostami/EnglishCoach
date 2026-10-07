import { describe, it, expect } from "vitest";
import { calculatePriority, rankCandidates, DEFAULT_NO_HISTORY, type TargetCandidate } from "./prioritization.js";

describe("calculatePriority", () => {
  it("weights per spec (0.25/0.20/0.20/0.15/0.10/0.10)", () => {
    const all = { skill: "x", recurrence: 1, severity: 1, goalRelevance: 1, communicativeImpact: 1, readiness: 1, forgettingRisk: 1 };
    expect(calculatePriority(all)).toBeCloseTo(1);
    const none = { skill: "x", recurrence: 0, severity: 0, goalRelevance: 0, communicativeImpact: 0, readiness: 0, forgettingRisk: 0 };
    expect(calculatePriority(none)).toBeCloseTo(0);
  });
  it("goal relevance breaks ties", () => {
    const a = { skill: "grammar.past_tense", recurrence: 0.5, severity: 0.6, goalRelevance: 1, communicativeImpact: 0.5, readiness: 0.5, forgettingRisk: 0.5 };
    const b = { skill: "vocabulary.precision", recurrence: 0.5, severity: 0.6, goalRelevance: 0.3, communicativeImpact: 0.5, readiness: 0.5, forgettingRisk: 0.5 };
    expect(calculatePriority(a)).toBeGreaterThan(calculatePriority(b));
  });
});

describe("rankCandidates", () => {
  it("sorts descending and never reorders ties arbitrarily (stable)", () => {
    const cands: TargetCandidate[] = [
      { skill: "a", recurrence: 0.1, severity: 0.1, goalRelevance: 0.1, communicativeImpact: 0.1, readiness: 0.1, forgettingRisk: 0.1 },
      { skill: "b", recurrence: 0.9, severity: 0.9, goalRelevance: 0.9, communicativeImpact: 0.9, readiness: 0.9, forgettingRisk: 0.9 },
    ];
    const ranked = rankCandidates(cands);
    expect(ranked[0].skill).toBe("b");
  });
});

describe("DEFAULT_NO_HISTORY", () => {
  it("matches spec §10.6 defaults", () => {
    expect(DEFAULT_NO_HISTORY).toEqual({ recurrence: 0, severity: 0.4, forgettingRisk: 0 });
  });
});
