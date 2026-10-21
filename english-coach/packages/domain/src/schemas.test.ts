import { describe, it, expect } from "vitest";
import { ScoresSchema, SessionAnalysisSchema } from "./schemas.js";
import { isSkillCode, SKILL_CODES } from "./codes.js";

describe("ScoresSchema", () => {
  it("accepts a valid scores object", () => {
    const ok = ScoresSchema.parse({
      fluency: 0.71, grammar: 0.64, vocabulary: 0.73,
      pronunciation: null, coherence: 0.69, interaction: 0.82,
    });
    expect(ok.fluency).toBe(0.71);
  });
  it("accepts a null pronunciation (not assessed)", () => {
    const ok = ScoresSchema.parse({
      fluency: 0.71, grammar: 0.64, vocabulary: 0.73,
      pronunciation: null, coherence: 0.69, interaction: 0.82,
    });
    expect(ok.pronunciation).toBeNull();
  });
  it("rejects a score above 1", () => {
    expect(() => ScoresSchema.parse({
      fluency: 1.2, grammar: 0.64, vocabulary: 0.73,
      pronunciation: null, coherence: 0.69, interaction: 0.82,
    })).toThrow();
  });
  it("rejects missing fields", () => {
    expect(() => ScoresSchema.parse({ fluency: 0.5 })).toThrow();
  });
});

describe("SessionAnalysisSchema", () => {
  const base = {
    scores: { fluency: 0.7, grammar: 0.6, vocabulary: 0.7, pronunciation: null, coherence: 0.7, interaction: 0.8 },
    recurring_errors: [], strengths: [], recommended_targets: [],
  };
  it("accepts a valid analysis", () => {
    const a = SessionAnalysisSchema.parse({
      ...base,
      observations: [{ type: "language_error", skill: "grammar.past_tense",
        evidence: "Yesterday I go to work", actual: "go", expected: "went",
        severity: 0.61, confidence: 0.97 }],
    });
    expect(a.observations).toHaveLength(1);
  });
  it("rejects an observation with an unknown skill code", () => {
    expect(() => SessionAnalysisSchema.parse({
      ...base,
      observations: [{ type: "language_error", skill: "grammar.nope", evidence: "x", confidence: 0.9 }],
    })).toThrow(/skill/);
  });
});

describe("codes", () => {
  it("knows the canonical codes", () => {
    expect(isSkillCode("grammar.past_tense")).toBe(true);
    expect(isSkillCode("fluency.hesitation")).toBe(true);
    expect(isSkillCode("grammar.wrong_code")).toBe(false);
    expect(SKILL_CODES).toContain("discourse.argumentation");
  });
});
