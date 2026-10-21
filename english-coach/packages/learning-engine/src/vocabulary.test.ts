import { describe, it, expect } from "vitest";
import {
  normalizeLemma, lemmaCandidates, applyVocabEvidence, weakestAxis,
  INITIAL_VOCAB_STATE, type VocabState,
} from "./vocabulary.js";
import { decomposeDifficulty, type DifficultyInput } from "./difficulty-decomposition.js";

describe("normalizeLemma", () => {
  it("folds simple inflections onto one key", () => {
    expect(normalizeLemma("books")).toBe("book");
    expect(normalizeLemma("book")).toBe("book");
    expect(normalizeLemma("studies")).toBe("study");
    expect(normalizeLemma("watched")).toBe("watch");
    expect(normalizeLemma("walking")).toBe("walk");
  });

  it("leaves a word it cannot normalise alone rather than guessing", () => {
    expect(normalizeLemma("business")).toBe("business");
    expect(normalizeLemma("glass")).toBe("glass");
    // "analysis" is not "-is"; it must not become "analysi".
    expect(normalizeLemma("analysis")).toBe("analysis");
  });

  it("is case-insensitive and trims", () => {
    expect(normalizeLemma("  Negotiate ")).toBe("negotiate");
  });
});

describe("lemmaCandidates", () => {
  it("offers the right lemma for an inflected form", () => {
    expect(lemmaCandidates("negotiated")).toContain("negotiate");
    expect(lemmaCandidates("studies")).toContain("study");
    expect(lemmaCandidates("books")).toContain("book");
    expect(lemmaCandidates("running")).toContain("run");
  });

  it("never merges two different words: the surface form is always a candidate", () => {
    expect(lemmaCandidates("analysis")).toContain("analysis");
    expect(lemmaCandidates("glass")).toContain("glass");
  });
});

describe("applyVocabEvidence", () => {
  it("moves production most when the learner uses the word unprompted", () => {
    const next = applyVocabEvidence(INITIAL_VOCAB_STATE, { produced: true });
    expect(next.productionMastery).toBeGreaterThan(next.recallMastery);
    expect(next.recallMastery).toBeGreaterThan(next.recognitionMastery);
  });

  it("keeps recognition and recall moving on their own evidence", () => {
    const recognised = applyVocabEvidence(INITIAL_VOCAB_STATE, { recognised: true });
    expect(recognised.recognitionMastery).toBeGreaterThan(0);
    expect(recognised.productionMastery).toBe(0);

    const recalled = applyVocabEvidence(INITIAL_VOCAB_STATE, { recalled: true });
    expect(recalled.recallMastery).toBeGreaterThan(0);
    // Recognition follows recall, so it moves a little too — but not production.
    expect(recalled.productionMastery).toBe(0);
  });

  it("does not mark a word known on exposure alone", () => {
    const seen = applyVocabEvidence(INITIAL_VOCAB_STATE, { recognised: true });
    expect(seen.status).toBe("learning");
  });

  it("marks a word known only once production is high", () => {
    let s: VocabState = INITIAL_VOCAB_STATE;
    for (let i = 0; i < 6; i++) s = applyVocabEvidence(s, { produced: true });
    expect(s.productionMastery).toBeGreaterThanOrEqual(0.8);
    expect(s.status).toBe("known");
  });

  it("costs more on a lapse than it gained, without resetting the word", () => {
    const strong = applyVocabEvidence(INITIAL_VOCAB_STATE, { produced: true });
    const lapsed = applyVocabEvidence(strong, { missed: true });
    expect(lapsed.productionMastery).toBeLessThan(strong.productionMastery);
    expect(lapsed.productionMastery).toBeGreaterThan(0);
    expect(lapsed.lapseCount).toBe(1);
    expect(lapsed.difficulty).toBeGreaterThan(strong.difficulty);
  });

  it("counts one review per piece of evidence", () => {
    const next = applyVocabEvidence(INITIAL_VOCAB_STATE, { produced: true });
    expect(next.reviewCount).toBe(1);
  });

  it("is deterministic", () => {
    const a = applyVocabEvidence(INITIAL_VOCAB_STATE, { produced: true, recalled: true });
    const b = applyVocabEvidence(INITIAL_VOCAB_STATE, { produced: true, recalled: true });
    expect(a).toEqual(b);
  });
});

describe("weakestAxis", () => {
  it("names the axis that needs the most work", () => {
    expect(weakestAxis({ ...INITIAL_VOCAB_STATE, recognitionMastery: 0.1, recallMastery: 0.5, productionMastery: 0.9 })).toBe("recognition");
    expect(weakestAxis({ ...INITIAL_VOCAB_STATE, recognitionMastery: 0.9, recallMastery: 0.2, productionMastery: 0.9 })).toBe("recall");
    expect(weakestAxis({ ...INITIAL_VOCAB_STATE, recognitionMastery: 0.9, recallMastery: 0.9, productionMastery: 0.1 })).toBe("production");
  });
});

const baseDifficulty: DifficultyInput = {
  learnerTurns: ["Yesterday I went to the market and bought some fresh bread for the family."],
  coachTurns: ["Nice! What did you do afterwards?"],
  metrics: {
    speakingSeconds: 30, userWordCount: 40, wordsPerMinute: 90, pauseCount: 2,
    avgPauseMs: 400, longestPauseMs: 900, utteranceCount: 3, avgUtteranceWords: 13,
  },
  interventions: 0,
  familiarWords: new Set<string>(),
};

describe("decomposeDifficulty", () => {
  it("returns all six components and a composite", () => {
    const p = decomposeDifficulty(baseDifficulty);
    expect(p.vocabularyComplexity).toBeGreaterThanOrEqual(0);
    expect(p.grammaticalComplexity).toBeGreaterThanOrEqual(0);
    expect(p.speechSpeed).toBeGreaterThanOrEqual(0);
    expect(p.abstraction).toBeGreaterThanOrEqual(0);
    expect(p.interactionPressure).toBeGreaterThanOrEqual(0);
    expect(p.topicFamiliarity).toBeGreaterThanOrEqual(0);
    expect(p.composite).toBeGreaterThan(0);
    expect(p.composite).toBeLessThanOrEqual(1);
  });

  it("scores a faster speaker as more demanding", () => {
    const slow = decomposeDifficulty(baseDifficulty);
    const fast = decomposeDifficulty({
      ...baseDifficulty,
      metrics: { ...baseDifficulty.metrics, wordsPerMinute: 180 },
    });
    expect(fast.speechSpeed).toBeGreaterThan(slow.speechSpeed);
    expect(fast.composite).toBeGreaterThan(slow.composite);
  });

  it("scores a coach-dominated conversation as higher pressure", () => {
    const balanced = decomposeDifficulty(baseDifficulty);
    const pressured = decomposeDifficulty({
      ...baseDifficulty,
      coachTurns: ["Say more. Again. And again. Keep going."],
      interventions: 4,
    });
    expect(pressured.interactionPressure).toBeGreaterThan(balanced.interactionPressure);
  });

  it("scores familiar vocabulary as LESS demanding", () => {
    const unfamiliar = decomposeDifficulty(baseDifficulty);
    const familiar = decomposeDifficulty({
      ...baseDifficulty,
      familiarWords: new Set(["yesterday", "went", "to", "the", "market", "and", "bought", "some", "fresh", "bread", "for", "the", "family"]),
    });
    expect(familiar.topicFamiliarity).toBeGreaterThan(unfamiliar.topicFamiliarity);
    expect(familiar.composite).toBeLessThan(unfamiliar.composite);
  });

  it("scores complex grammar as more demanding than simple grammar", () => {
    const simple = decomposeDifficulty({
      ...baseDifficulty,
      learnerTurns: ["I go to work. I come home. I eat dinner. I watch TV."],
    });
    const complex = decomposeDifficulty({
      ...baseDifficulty,
      learnerTurns: ["Even though I had been working there for years, I decided that although it seemed unreasonable, I would nevertheless have to reconsider."],
    });
    expect(complex.grammaticalComplexity).toBeGreaterThan(simple.grammaticalComplexity);
  });

  it("is deterministic", () => {
    expect(decomposeDifficulty(baseDifficulty)).toEqual(decomposeDifficulty(baseDifficulty));
  });

  it("does not divide by zero on an empty session", () => {
    const empty = decomposeDifficulty({
      ...baseDifficulty, learnerTurns: [], coachTurns: [],
      metrics: { ...baseDifficulty.metrics, wordsPerMinute: 0, userWordCount: 0 },
    });
    expect(Number.isFinite(empty.composite)).toBe(true);
    expect(empty.composite).toBeGreaterThanOrEqual(0);
  });
});
