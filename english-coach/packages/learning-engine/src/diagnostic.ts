import { clamp01 } from "./mastery.js";

/**
 * Diagnostic onboarding (spec §5 Phase 2, backlog item 12).
 *
 * A short self-report, scored deterministically. Self-report is evidence of
 * *what to work on*, never of proficiency: every result is marked
 * `self_report` and confidence stays deliberately low, so a placement can start
 * the learner somewhere sensible without pretending to have measured them
 * (spec §6.1 "never use profile preferences as proof of proficiency").
 */
export const DIAGNOSTIC_VERSION = "onboarding-v1";

export type ProficiencyBand = "A2" | "B1" | "B1+" | "B2+" | "C1";

export interface DiagnosticAnswers {
  /** Self-rated speaking comfort, 0 (none) .. 1 (confident). */
  speakingComfort: number;
  /** Self-rated grammar confidence, 0 .. 1. */
  grammarConfidence: number;
  /** How often the learner speaks English in a week. */
  weeklySpeakingFrequency: number;
  /** Skills the learner wants to work on. */
  focusSkills: string[];
}

export interface Diagnostic {
  band: ProficiencyBand;
  confidence: number;
  difficulty: number;
  focusSkills: string[];
  /** Spelled out so the learner knows a placement is not a measurement. */
  basis: "self_report";
  rubricVersion: string;
}

const BANDS: ProficiencyBand[] = ["A2", "B1", "B1+", "B2+", "C1"];

export function runDiagnostic(a: DiagnosticAnswers): Diagnostic {
  const comfort = clamp01(a.speakingComfort);
  const grammar = clamp01(a.grammarConfidence);
  // Frequency is capped at a week of daily practice, so a learner cannot buy a
  // higher placement by claiming they speak ten times a day.
  const frequency = clamp01(a.weeklySpeakingFrequency / 7);
  const score = clamp01(comfort * 0.4 + grammar * 0.4 + frequency * 0.2);

  const band = BANDS[Math.min(BANDS.length - 1, Math.floor(score * BANDS.length))];
  return {
    band,
    // Low on purpose: three self-ratings are not an assessment, and a high
    // confidence number here would be a claim the input cannot support.
    confidence: Number(Math.min(0.5, 0.2 + a.weeklySpeakingFrequency * 0.02).toFixed(2)),
    difficulty: Number((0.15 + score * 0.7).toFixed(2)),
    focusSkills: [...new Set(a.focusSkills)],
    basis: "self_report",
    rubricVersion: DIAGNOSTIC_VERSION,
  };
}
