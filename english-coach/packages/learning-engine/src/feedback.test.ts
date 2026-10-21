import { describe, it, expect } from "vitest";
import type { SessionAnalysis } from "@ec/domain";
import { deriveFeedback } from "./feedback.js";

function analysis(over: Partial<SessionAnalysis> = {}): SessionAnalysis {
  return {
    scores: { fluency: 0.7, grammar: 0.6, vocabulary: 0.8, pronunciation: null, coherence: 0.55, interaction: 0.9 },
    observations: [],
    recurring_errors: [],
    strengths: [],
    recommended_targets: [],
    ...over,
  };
}

const err = (over: Partial<SessionAnalysis["observations"][number]>) => ({
  type: "language_error" as const,
  skill: "grammar.past_tense",
  evidence: "Yesterday I go to work",
  actual: "go",
  expected: "went",
  severity: 0.6,
  confidence: 0.9,
  ...over,
});

describe("deriveFeedback", () => {
  it("reports an unassessed dimension as not assessed rather than scoring it", () => {
    expect(deriveFeedback(analysis()).notAssessed).toEqual(["pronunciation"]);
  });

  it("replaces the wrong form inside the learner's own sentence", () => {
    const [c] = deriveFeedback(analysis({ observations: [err({})] })).corrections;
    expect(c.original).toBe("Yesterday I go to work");
    expect(c.suggested).toBe("Yesterday I went to work");
    expect(c.skill).toBe("grammar.past_tense");
    expect(c.confidence).toBe(0.9);
  });

  it("never invents a replacement when the wrong form is not in the quote", () => {
    // The model reported "go" but quoted a sentence that does not contain it.
    const [c] = deriveFeedback(analysis({
      observations: [err({ evidence: "I went home early" })],
    })).corrections;
    expect(c.suggested).toBeNull();
    expect(c.explanation).toContain('"went"'); // still names the target form
  });

  it("keeps at most three corrections, ordered by severity then confidence", () => {
    const obs = [
      err({ evidence: "a go", actual: "go", severity: 0.2 }),
      err({ evidence: "b go", actual: "go", severity: 0.9 }),
      err({ evidence: "c go", actual: "go", severity: 0.5 }),
      err({ evidence: "d go", actual: "go", severity: 0.7 }),
    ];
    const out = deriveFeedback(analysis({ observations: obs })).corrections;
    expect(out).toHaveLength(3);
    expect(out.map((c) => c.original)).toEqual(["b go", "d go", "c go"]);
  });

  it("caps strengths at three, highest confidence first", () => {
    const strengths = [0.4, 0.9, 0.7, 0.6].map((confidence, i) => ({
      skill: "vocabulary.precision", evidence: `e${i}`, confidence,
    }));
    const out = deriveFeedback(analysis({ strengths })).strengths;
    expect(out).toHaveLength(3);
    expect(out.map((s) => s.confidence)).toEqual([0.9, 0.7, 0.6]);
  });

  it("dedupes vocabulary to lowercase words from vocabulary-use evidence only", () => {
    const obs = [
      { type: "vocabulary_use" as const, skill: "vocabulary.breadth", evidence: "I said negotiate twice", confidence: 0.8 },
      { type: "vocabulary_use" as const, skill: "vocabulary.breadth", evidence: "negotiate again", confidence: 0.8 },
      err({}),
    ];
    expect(deriveFeedback(analysis({ observations: obs })).vocabulary).toEqual(["negotiate"]);
  });

  it("is deterministic: the same analysis yields the same feedback", () => {
    const a = analysis({ observations: [err({}), err({ evidence: "Then I go home", severity: 0.8 })] });
    expect(deriveFeedback(a)).toEqual(deriveFeedback(a));
  });
});
