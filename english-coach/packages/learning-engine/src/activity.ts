import type { AssessmentDimension, SessionMetrics } from "@ec/domain";
import { clamp01 } from "./mastery.js";

export const GUIDED_RUBRIC_VERSION = "guided-speaking-v1";

export interface GuidedCriteria {
  /** Words the learner was asked to use. */
  requiredWords: string[];
  /** Speaking time the activity targets, in seconds. */
  targetSeconds: number;
  /** Skill the activity is about. */
  skillCode: string;
}

type Dimension = AssessmentDimension;

/**
 * Deterministic check of a guided-speaking attempt — no model involved, so the
 * same transcript and metrics always produce the same result, and nothing is
 * invented (spec §3 principles 2 and 7).
 *
 * Only the skills the activity can actually evidence are `assessed`.
 * Pronunciation is always `not_assessed`: this activity sees text only
 * (spec §12.1).
 */
export function assessGuidedSpeaking(opts: {
  attemptId: string;
  transcript: string[];
  metrics: SessionMetrics;
  criteria: GuidedCriteria;
}): {
  rubricVersion: string;
  dimensions: Dimension[];
  summary: string;
} {
  const { attemptId, transcript, metrics, criteria } = opts;
  const said = transcript.join(" ").toLowerCase();
  const used = criteria.requiredWords.filter((w) => said.includes(w.toLowerCase()));
  const wordCoverage = criteria.requiredWords.length === 0
    ? 1
    : used.length / criteria.requiredWords.length;
  const timeRatio = criteria.targetSeconds === 0
    ? 1
    : Math.min(1, metrics.speakingSeconds / criteria.targetSeconds);

  const dimensions: Dimension[] = [
    // Vocabulary: did the learner actually use the requested words.
    { skillCode: "vocabulary.precision", score: clamp01(wordCoverage), status: "assessed", confidence: 0.9 },
    // Fluency: spoke for the time the activity asked for. This is a duration
    // check, not a judgement of quality — it is named as such in the summary.
    { skillCode: "fluency.continuity", score: clamp01(timeRatio), status: "assessed", confidence: 0.7 },
    // The activity's own target skill, when it is neither of the two above.
    ...(criteria.skillCode !== "vocabulary.precision" && criteria.skillCode !== "fluency.continuity"
      ? [{ skillCode: criteria.skillCode, score: null, status: "not_assessed" as const, confidence: 0 }]
      : []),
    // Text-only activity: no acoustic evidence, so it is named as unmeasured
    // rather than scored (spec §12.1).
    { skillCode: "pronunciation.intelligibility", score: null, status: "not_assessed", confidence: 0 },
  ];

  const missing = criteria.requiredWords.filter((w) => !used.includes(w));
  const summary = [
    `${used.length}/${criteria.requiredWords.length} target words used`,
    missing.length > 0 ? `(missing: ${missing.join(", ")})` : "",
    `spoke ${metrics.speakingSeconds}s of a ${criteria.targetSeconds}s target`,
    "pronunciation not assessed — this activity has no audio evidence",
  ].filter(Boolean).join("; ");

  void attemptId;
  return { rubricVersion: GUIDED_RUBRIC_VERSION, dimensions, summary };
}

/** The first objective a learner should work on, or null if there is none. */
export function selectObjective<T extends { priority: number; status: string }>(
  objectives: T[],
): T | null {
  const active = objectives.filter((o) => o.status === "active" || o.status === "planned");
  if (active.length === 0) return null;
  return [...active].sort((a, b) => b.priority - a.priority)[0];
}
