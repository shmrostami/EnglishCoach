import { describe, it, expect } from "vitest";
import { selectTargets, chooseIntervention, estimateLevel } from "./planning.js";
import type { TargetCandidate } from "./prioritization.js";

function cand(skill: string, priority: number): TargetCandidate {
  return { skill, recurrence: priority, severity: priority, goalRelevance: priority,
    communicativeImpact: priority, readiness: priority, forgettingRisk: priority };
}

describe("selectTargets", () => {
  it("picks top 2 primary and at most 1 secondary", () => {
    const out = selectTargets([cand("a", 0.9), cand("b", 0.8), cand("c", 0.7), cand("d", 0.6)]);
    expect(out.primary).toHaveLength(2);
    expect(out.primary.map((t) => t.skill)).toEqual(["a", "b"]);
    expect(out.secondary).toHaveLength(1);
  });
  it("handles fewer candidates than slots", () => {
    const out = selectTargets([cand("a", 0.5)]);
    expect(out.primary).toHaveLength(1);
    expect(out.secondary).toHaveLength(0);
  });
  it("excludes mastered skills passed in with mastery >= 0.8", () => {
    const mastered = { ...cand("a", 0.9), mastery: 0.85 };
    const out = selectTargets([mastered, cand("b", 0.5)]);
    expect(out.primary.map((t) => t.skill)).toEqual(["b"]);
  });
});

describe("chooseIntervention", () => {
  it("maps grammar errors to natural_reuse or micro_correction", () => {
    const i = chooseIntervention("grammar.past_tense");
    expect(["natural_reuse", "micro_correction"]).toContain(i);
  });
  it("maps vocabulary retrieval to repetition", () => {
    expect(chooseIntervention("vocabulary.retrieval")).toBe("repetition");
  });
  it("maps discourse to storytelling", () => {
    expect(chooseIntervention("discourse.storytelling")).toBe("storytelling");
  });
  it("maps fluency to role_play", () => {
    expect(chooseIntervention("fluency.continuity")).toBe("role_play");
  });
});

describe("estimateLevel", () => {
  it("maps score bands to CEFR-ish labels", () => {
    expect(estimateLevel(0.45, 5).level).toBe("B1");
    expect(estimateLevel(0.62, 5).level).toBe("B1+");
    expect(estimateLevel(0.75, 5).level).toBe("B2+");
    expect(estimateLevel(0.85, 5).level).toBe("C1");
  });
  it("confidence grows with session count, capped at 0.95", () => {
    expect(estimateLevel(0.6, 2).confidence).toBeLessThan(estimateLevel(0.6, 12).confidence);
    expect(estimateLevel(0.6, 100).confidence).toBeLessThanOrEqual(0.95);
  });
  it("low confidence before 3 sessions", () => {
    expect(estimateLevel(0.6, 1).confidence).toBeLessThan(0.5);
  });
});
