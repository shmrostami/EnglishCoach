import type { Scores } from "@ec/domain";

type Dimension = keyof Scores;

/** Weight per assessed dimension. The weights sum to 1 over all six dimensions. */
export const WEIGHTS: Record<Dimension, number> = {
  fluency: 0.25, grammar: 0.2, vocabulary: 0.2,
  pronunciation: 0.15, coherence: 0.1, interaction: 0.1,
};

/**
 * Weighted mean over the dimensions that were actually assessed. A dimension
 * the analysis could not evidence is null and is excluded — the remaining
 * weights are renormalized so an unassessed dimension neither scores 0 nor
 * drags the overall score down (spec §3.7, §12.1).
 */
export function calculateOverall(scores: Scores): number {
  let weighted = 0;
  let totalWeight = 0;
  for (const dim of Object.keys(WEIGHTS) as Dimension[]) {
    const value = scores[dim];
    if (value == null) continue;
    weighted += value * WEIGHTS[dim];
    totalWeight += WEIGHTS[dim];
  }
  return totalWeight === 0 ? 0 : weighted / totalWeight;
}
