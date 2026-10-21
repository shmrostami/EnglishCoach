import type { AssessmentDimension } from "@ec/domain";
import { clamp01 } from "./mastery.js";

/**
 * Activity modalities (spec Phase 3).
 *
 * Each modality has its own rubric, and — the point of the whole file — each
 * rubric measures ONLY the skills that modality can actually evidence. A
 * dictation exercise says nothing about pronunciation, and a listening task
 * says nothing about how the learner speaks. Reporting a dimension the task
 * did not measure would be a fabricated score (spec §3 principle 7).
 */
export type Modality = "listening" | "reading" | "writing" | "dictation" | "pronunciation";

export interface ModalitySpec {
  modality: Modality;
  label: string;
  inputModality: string[];
  outputModality: string[];
  /** The skills this modality can evidence. Everything else stays unassessed. */
  evidenceSkills: string[];
  rubricVersion: string;
  /** True when the modality needs acoustic evidence to score pronunciation. */
  requiresAudioEvidence: boolean;
}

export const MODALITIES: ModalitySpec[] = [
  {
    modality: "listening",
    label: "Listening",
    inputModality: ["audio"],
    outputModality: ["text"],
    evidenceSkills: ["fluency.continuity", "vocabulary.breadth"],
    rubricVersion: "listening-v1",
    requiresAudioEvidence: false,
  },
  {
    modality: "reading",
    label: "Reading",
    inputModality: ["text"],
    outputModality: ["text"],
    evidenceSkills: ["vocabulary.precision", "discourse.coherence"],
    rubricVersion: "reading-v1",
    requiresAudioEvidence: false,
  },
  {
    modality: "writing",
    label: "Writing and revision",
    inputModality: ["text"],
    outputModality: ["text"],
    evidenceSkills: ["grammar.word_order", "discourse.coherence"],
    rubricVersion: "writing-v1",
    requiresAudioEvidence: false,
  },
  {
    modality: "dictation",
    label: "Dictation",
    inputModality: ["audio"],
    outputModality: ["text"],
    evidenceSkills: ["vocabulary.retrieval", "fluency.continuity"],
    rubricVersion: "dictation-v1",
    requiresAudioEvidence: false,
  },
  {
    modality: "pronunciation",
    label: "Pronunciation",
    inputModality: ["audio"],
    outputModality: ["audio"],
    evidenceSkills: ["pronunciation.intelligibility", "pronunciation.stress", "pronunciation.rhythm"],
    rubricVersion: "pronunciation-v1",
    // Without acoustic evidence there is nothing to score — the dimension is
    // reported as not_assessed rather than guessed (spec §12.1).
    requiresAudioEvidence: true,
  },
];

/**
 * Scores a non-speaking modality.
 *
 * `accuracy` is the measured correctness (0..1) and `coverage` how much of
 * the task was attempted. Only the modality's own skills are scored; the
 * rest appear as `not_assessed` with the reason, so the learner sees what was
 * and was not measured.
 */
export function assessModality(opts: {
  modality: Modality;
  accuracy: number;
  coverage?: number;
  /** True when the pipeline returned audio-derived evidence. */
  hasAudioEvidence?: boolean;
}): { rubricVersion: string; dimensions: AssessmentDimension[]; summary: string } {
  const spec = MODALITIES.find((m) => m.modality === opts.modality);
  if (!spec) throw new Error(`unknown modality ${opts.modality}`);

  const coverage = clamp01(opts.coverage ?? 1);
  const accuracy = clamp01(opts.accuracy);
  const hasAudio = opts.hasAudioEvidence === true;

  const dimensions: AssessmentDimension[] = spec.evidenceSkills.map((skillCode) => {
    // A pronunciation task without audio evidence measures nothing, so it
    // measures nothing — the number would be invented.
    if (spec.requiresAudioEvidence && !hasAudio) {
      return { skillCode, score: null, status: "not_assessed", confidence: 0 };
    }
    return {
      skillCode,
      score: Number((accuracy * (0.7 + 0.3 * coverage)).toFixed(4)),
      status: "assessed",
      confidence: 0.7,
    };
  });

  const unassessed = dimensions.filter((d) => d.status === "not_assessed").map((d) => d.skillCode);
  const summary = [
    `${spec.label}: ${Math.round(accuracy * 100)}% correct`,
    coverage < 1 ? `covering ${Math.round(coverage * 100)}% of the task` : null,
    unassessed.length > 0 ? `not assessed (no evidence): ${unassessed.join(", ")}` : null,
  ].filter(Boolean).join("; ");

  return { rubricVersion: spec.rubricVersion, dimensions, summary };
}

/**
 * Whether a modality may claim a pronunciation score.
 *
 * The rule is the same one the analysis provider uses: a score needs
 * audio-grounded evidence, and nothing else substitutes for it (§12.1).
 */
export function canScorePronunciation(hasAudioEvidence: boolean): boolean {
  return hasAudioEvidence;
}
