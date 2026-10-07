import { familyOf } from "@ec/domain";
import { clamp01 } from "./mastery.js";

export interface TargetCandidate {
  skill: string;
  recurrence: number;       // 0..1 normalized effective frequency of its errors
  severity: number;         // 0..1 mean severity of its error patterns
  goalRelevance: number;    // 0..1 — 1 if skill family matches an active goal type, else 0.3
  communicativeImpact: number; // 0..1 from analysis observation severity, capped
  readiness: number;        // 0..1 — 1 - mastery
  forgettingRisk: number;   // 0..1 — 1 - e^(-daysSinceLastReview/30)
  mastery?: number;         // optional; used by selectTargets to exclude mastered skills
}

/** Spec §10.6 defaults for skills with no observation history. */
export const DEFAULT_NO_HISTORY = { recurrence: 0, severity: 0.4, forgettingRisk: 0 } as const;

export function calculatePriority(c: TargetCandidate): number {
  return clamp01(
    0.25 * c.recurrence +
    0.2 * c.severity +
    0.2 * c.goalRelevance +
    0.15 * c.communicativeImpact +
    0.1 * c.readiness +
    0.1 * c.forgettingRisk,
  );
}

export function rankCandidates(candidates: TargetCandidate[]): TargetCandidate[] {
  return [...candidates].sort(
    (a, b) => calculatePriority(b) - calculatePriority(a) || a.skill.localeCompare(b.skill),
  );
}

export function goalRelevanceFor(skill: string, goalTypes: string[]): number {
  const family = familyOf(skill);
  return family && goalTypes.includes(family) ? 1 : 0.3;
}
