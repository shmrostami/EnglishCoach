import type { SessionMetrics } from "@ec/domain";

/**
 * Conversation difficulty, decomposed (design.md §10).
 *
 * The design says difficulty is not one number but the sum of six components.
 * This computes them from what was actually measured — the transcript and the
 * deterministic metrics — so every component is evidence, not a guess.
 *
 * Each component is 0..1 and they are combined with weights that reflect how
 * much each moves the perceived demand of a conversation. The composite is
 * clamped to the same 0..1 range the planner already uses.
 */
export interface DifficultyComponents {
  vocabularyComplexity: number;
  grammaticalComplexity: number;
  speechSpeed: number;
  abstraction: number;
  interactionPressure: number;
  topicFamiliarity: number;
}

export interface DifficultyProfile extends DifficultyComponents {
  /** The weighted combination the planner's scalar difficulty comes from. */
  composite: number;
}

const WEIGHTS: Record<keyof DifficultyComponents, number> = {
  // Vocabulary load drives most of the felt difficulty of a topic.
  vocabularyComplexity: 0.22,
  grammaticalComplexity: 0.22,
  // Speed is how much the learner had to work in real time.
  speechSpeed: 0.16,
  // Abstract content is harder than concrete narrative.
  abstraction: 0.14,
  // Pressure from the coach (turn-taking, interventions) is real load.
  interactionPressure: 0.14,
  // Familiarity REDUCES difficulty, so it enters inverted.
  topicFamiliarity: 0.12,
};

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Words longer than this count toward complexity rather than being noise. */
const LONG_WORD = 7;

/**
 * Markers of grammatical complexity. Deliberately a small, explicit list: a
 * heuristic that claims to measure "grammatical complexity" from text can
 * only count constructions it knows about, so it is labelled as that.
 */
const COMPLEX_MARKERS = [
  "had been", "have been", "has been", "had been", "would have", "could have",
  "should have", "might have", "were to", "provided that", "as long as",
  "even though", "although", "despite", "in addition", "furthermore",
  "moreover", "therefore", "consequently", "nevertheless", "otherwise",
  "whereas", "while", "unless", "whether", "whom", "whose",
];

export interface DifficultyInput {
  /** Learner turns only — the coach's speech is not the learner's load. */
  learnerTurns: string[];
  coachTurns: string[];
  metrics: SessionMetrics;
  /** Number of live interventions during the session. */
  interventions: number;
  /** Words the learner already used in earlier sessions (topic familiarity). */
  familiarWords: Set<string>;
}

/**
 * Six components plus a composite. Deterministic: the same session always
 * produces the same profile.
 */
export function decomposeDifficulty(input: DifficultyInput): DifficultyProfile {
  const learnerText = input.learnerTurns.join(" ").toLowerCase();
  const words = learnerText.match(/[a-z']+/g) ?? [];

  // 1. Vocabulary complexity: the share of words that are long enough to be
  // content words rather than function words.
  const longWords = words.filter((w) => w.length > LONG_WORD).length;
  const vocabularyComplexity = words.length === 0 ? 0 : clamp01(longWords / Math.max(8, words.length * 0.3));

  // 2. Grammatical complexity: complex constructions per 100 words.
  const markerHits = COMPLEX_MARKERS.reduce((n, m) => n + countOccurrences(learnerText, m), 0);
  const grammaticalComplexity = words.length === 0 ? 0 : clamp01((markerHits * 100) / (words.length * 2));

  // 3. Speech speed: words per minute, mapped from 60 to 200 wpm onto 0..1.
  const wpm = input.metrics.wordsPerMinute;
  const speechSpeed = clamp01((wpm - 60) / 140);

  // 4. Abstraction: a proxy — the share of long words, which in English skew
  // toward abstract nominalisations. It is a proxy and documented as one.
  const abstraction = vocabularyComplexity;

  // 5. Interaction pressure: how much the coach pushed relative to how much
  // the learner spoke, plus the live interventions.
  const learnerChars = input.learnerTurns.reduce((n, t) => n + t.length, 0);
  const coachChars = input.coachTurns.reduce((n, t) => n + t.length, 0);
  const turnRatio = coachChars === 0 ? 0 : learnerChars / (learnerChars + coachChars);
  const pressure = (1 - turnRatio) * 0.6 + clamp01(input.interventions / 5) * 0.4;

  // 6. Topic familiarity: the share of the learner's words already seen.
  // Inverted — familiar words make a conversation easier.
  const familiarHits = words.filter((w) => input.familiarWords.has(w)).length;
  const familiarity = words.length === 0 ? 0 : clamp01(familiarHits / words.length);

  const components: DifficultyComponents = {
    vocabularyComplexity,
    grammaticalComplexity,
    speechSpeed,
    abstraction,
    interactionPressure: clamp01(pressure),
    topicFamiliarity: familiarity,
  };

  let composite = 0;
  for (const key of Object.keys(WEIGHTS) as (keyof DifficultyComponents)[]) {
    const value = components[key];
    // Familiarity is inverted: more familiarity, less difficulty.
    const contribution = key === "topicFamiliarity" ? 1 - value : value;
    composite += contribution * WEIGHTS[key];
  }

  return { ...components, composite: Number(clamp01(composite).toFixed(4)) };
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}
