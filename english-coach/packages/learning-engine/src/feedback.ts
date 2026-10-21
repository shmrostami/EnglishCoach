import type { Observation, Scores, SessionAnalysis, SkillEvidence } from "@ec/domain";

export interface CorrectionDraft {
  original: string;
  /** null when no grounded replacement could be derived — never invented. */
  suggested: string | null;
  explanation: string;
  skill: string;
  evidence: string;
  confidence: number;
}

export interface FeedbackDraft {
  notAssessed: (keyof Scores)[];
  strengths: SkillEvidence[];
  corrections: CorrectionDraft[];
  vocabulary: string[];
}

const MAX_STRENGTHS = 3;
// Spec §11.3: "a small number of high-value corrections", not every error.
const MAX_CORRECTIONS = 3;

/**
 * Turns a stored analysis into the reviewable feedback shape (spec §11.3).
 *
 * Pure and deterministic: the same analysis always yields the same feedback,
 * so a retried analysis job cannot invent different corrections, and the rows
 * it writes are stable (spec §3 principle 6).
 */
export function deriveFeedback(analysis: SessionAnalysis): FeedbackDraft {
  return {
    notAssessed: (Object.keys(analysis.scores) as (keyof Scores)[])
      .filter((k) => analysis.scores[k] == null),
    strengths: [...analysis.strengths]
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, MAX_STRENGTHS),
    corrections: analysis.observations
      .filter(correctable)
      .sort((a, b) => (b.severity ?? 0.5) - (a.severity ?? 0.5) || b.confidence - a.confidence)
      .slice(0, MAX_CORRECTIONS)
      .map(toCorrection),
    vocabulary: vocabularyFrom(analysis.observations),
  };
}

type CorrectableError = Observation & { actual: string; expected: string };

function correctable(o: Observation): o is CorrectableError {
  return o.type === "language_error" && !!o.actual && !!o.expected;
}

function toCorrection(o: CorrectableError): CorrectionDraft {
  // The analysis quotes the learner's sentence, so a replacement is only
  // proposed when the wrong form actually appears in it. A model that reports
  // an error it cannot locate in the transcript does not get to write one.
  const at = o.evidence.indexOf(o.actual);
  const suggested = at === -1
    ? null
    : o.evidence.slice(0, at) + o.expected + o.evidence.slice(at + o.actual.length);
  return {
    original: o.evidence,
    suggested,
    explanation: `Replace "${o.actual}" with "${o.expected}" here.`,
    skill: o.skill,
    evidence: o.evidence,
    confidence: o.confidence,
  };
}

/** Distinct longest alpha tokens from vocabulary-use evidence, first use order. */
function vocabularyFrom(observations: Observation[]): string[] {
  const seen = new Set<string>();
  for (const o of observations) {
    if (o.type !== "vocabulary_use") continue;
    const word = (o.evidence.match(/[a-zA-Z]{4,}/g) ?? []).sort((a, b) => b.length - a.length)[0];
    if (word) seen.add(word.toLowerCase());
  }
  return [...seen];
}
