import { describe, it, expect } from "vitest";
import { assessGuidedSpeaking, selectObjective, GUIDED_RUBRIC_VERSION } from "./activity.js";
import { runDiagnostic, DIAGNOSTIC_VERSION } from "./diagnostic.js";

const base = {
  attemptId: "att-1",
  metrics: {
    speakingSeconds: 45, userWordCount: 80, wordsPerMinute: 100, pauseCount: 2,
    avgPauseMs: 300, longestPauseMs: 900, utteranceCount: 5, avgUtteranceWords: 16,
  },
  criteria: { requiredWords: ["negotiate", "budget", "deadline"], targetSeconds: 90, skillCode: "fluency.continuity" },
};

describe("assessGuidedSpeaking", () => {
  it("scores word coverage and speaking time, and names both", () => {
    const r = assessGuidedSpeaking({ ...base, transcript: ["I had to negotiate the budget."] });
    const bySkill = Object.fromEntries(r.dimensions.map((d) => [d.skillCode, d]));
    expect(bySkill["vocabulary.precision"].score).toBeCloseTo(2 / 3, 5);
    expect(bySkill["fluency.continuity"].score).toBeCloseTo(0.5, 5);
    expect(r.summary).toContain("2/3 target words used");
    expect(r.summary).toContain("missing: deadline");
    expect(r.rubricVersion).toBe(GUIDED_RUBRIC_VERSION);
  });

  it("never scores pronunciation — the activity has no audio evidence", () => {
    const r = assessGuidedSpeaking({ ...base, transcript: ["negotiate budget deadline"] });
    const pron = r.dimensions.find((d) => d.skillCode === "pronunciation.intelligibility")!;
    expect(pron.status).toBe("not_assessed");
    expect(pron.score).toBeNull();
    expect(r.summary).toContain("pronunciation not assessed");
  });

  it("marks the activity's own target skill not_assessed rather than inventing a score", () => {
    const r = assessGuidedSpeaking({ ...base, transcript: ["negotiate budget deadline"] });
    const target = r.dimensions.find((d) => d.skillCode === "fluency.continuity");
    // fluency.continuity IS measured (by time), so a different target is used here.
    expect(target?.status).toBe("assessed");

    const r2 = assessGuidedSpeaking({
      ...base, transcript: ["negotiate budget deadline"],
      criteria: { ...base.criteria, skillCode: "grammar.past_tense" },
    });
    const g = r2.dimensions.find((d) => d.skillCode === "grammar.past_tense")!;
    expect(g.status).toBe("not_assessed");
    expect(g.score).toBeNull();
  });

  it("is deterministic for the same input", () => {
    const a = assessGuidedSpeaking({ ...base, transcript: ["negotiate"] });
    const b = assessGuidedSpeaking({ ...base, transcript: ["negotiate"] });
    expect(a).toEqual(b);
  });

  it("treats an activity with no required words as full coverage, not zero", () => {
    const r = assessGuidedSpeaking({
      ...base, transcript: ["anything at all"],
      criteria: { ...base.criteria, requiredWords: [] },
    });
    expect(r.dimensions.find((d) => d.skillCode === "vocabulary.precision")?.score).toBe(1);
  });
});

describe("selectObjective", () => {
  it("picks the highest-priority open objective, ignoring finished ones", () => {
    const picked = selectObjective([
      { id: "a", priority: 0.4, status: "active" },
      { id: "b", priority: 0.9, status: "achieved" },
      { id: "c", priority: 0.7, status: "planned" },
    ]);
    expect(picked?.id).toBe("c");
  });

  it("returns null when there is nothing to work on", () => {
    expect(selectObjective([{ id: "a", priority: 0.9, status: "achieved" }])).toBeNull();
  });
});

describe("runDiagnostic", () => {
  it("places a confident learner higher than an unsure one", () => {
    const high = runDiagnostic({ speakingComfort: 0.9, grammarConfidence: 0.9, weeklySpeakingFrequency: 7, focusSkills: [] });
    const low = runDiagnostic({ speakingComfort: 0.1, grammarConfidence: 0.1, weeklySpeakingFrequency: 0, focusSkills: [] });
    expect(high.difficulty).toBeGreaterThan(low.difficulty);
    expect(high.band).not.toBe(low.band);
  });

  it("labels itself self-report and keeps confidence low — it is not an assessment", () => {
    const r = runDiagnostic({ speakingComfort: 1, grammarConfidence: 1, weeklySpeakingFrequency: 7, focusSkills: [] });
    expect(r.basis).toBe("self_report");
    expect(r.confidence).toBeLessThanOrEqual(0.5);
    expect(r.rubricVersion).toBe(DIAGNOSTIC_VERSION);
  });

  it("does not let an impossible frequency buy a higher placement", () => {
    const week = runDiagnostic({ speakingComfort: 0.5, grammarConfidence: 0.5, weeklySpeakingFrequency: 7, focusSkills: [] });
    const absurd = runDiagnostic({ speakingComfort: 0.5, grammarConfidence: 0.5, weeklySpeakingFrequency: 70, focusSkills: [] });
    expect(absurd.difficulty).toBe(week.difficulty);
  });

  it("dedupes focus skills", () => {
    const r = runDiagnostic({ speakingComfort: 0.5, grammarConfidence: 0.5, weeklySpeakingFrequency: 3, focusSkills: ["a", "a", "b"] });
    expect(r.focusSkills).toEqual(["a", "b"]);
  });
});
