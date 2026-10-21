import { describe, it, expect } from "vitest";
import { milestoneMet, suggestMilestones } from "./goals.js";

const m = (over: Partial<Parameters<typeof milestoneMet>[0]> = {}) => ({
  id: "ms-1", status: "planned", targetSkillCode: "grammar.past_tense", targetMastery: 0.7, ...over,
});

describe("milestoneMet", () => {
  it("is met when mastery reaches the target", () => {
    expect(milestoneMet(m(), 0.7)).toBe(true);
    expect(milestoneMet(m(), 0.69)).toBe(false);
  });

  it("stays achieved once achieved, even if mastery later drops", () => {
    expect(milestoneMet(m({ status: "achieved" }), 0.1)).toBe(true);
  });

  it("is never auto-met without a target skill and threshold", () => {
    // A milestone the engine cannot check is left to the learner, not guessed.
    expect(milestoneMet(m({ targetSkillCode: null }), 0.99)).toBe(false);
    expect(milestoneMet(m({ targetMastery: null }), 0.99)).toBe(false);
    expect(milestoneMet(m(), undefined)).toBe(false);
  });
});

describe("suggestMilestones", () => {
  it("suggests only skills in the goal's family, weakest first", () => {
    const out = suggestMilestones("grammar", [
      { code: "grammar.articles", mastery: 0.6 },
      { code: "grammar.past_tense", mastery: 0.2 },
      { code: "fluency.continuity", mastery: 0.1 },
    ]);
    expect(out.map((s) => s.targetSkillCode)).toEqual(["grammar.past_tense", "grammar.articles"]);
  });

  it("caps at three suggestions", () => {
    const weak = ["a", "b", "c", "d", "e"].map((x, i) => ({ code: `grammar.${x}`, mastery: i / 10 }));
    expect(suggestMilestones("grammar", weak)).toHaveLength(3);
  });

  it("suggests nothing when the learner has no weak skill in that family", () => {
    expect(suggestMilestones("vocabulary", [{ code: "grammar.past_tense", mastery: 0.1 }])).toEqual([]);
  });

  it("targets 0.7, a step short of the 0.8 the engine treats as mastered", () => {
    const [first] = suggestMilestones("grammar", [{ code: "grammar.past_tense", mastery: 0.2 }]);
    expect(first.targetMastery).toBe(0.7);
  });
});
