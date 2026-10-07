import type { Scores } from "@ec/domain";

export const WEIGHTS: Scores = {
  fluency: 0.25, grammar: 0.2, vocabulary: 0.2,
  pronunciation: 0.15, coherence: 0.1, interaction: 0.1,
};

export function calculateOverall(scores: Scores): number {
  return (
    scores.fluency * WEIGHTS.fluency +
    scores.grammar * WEIGHTS.grammar +
    scores.vocabulary * WEIGHTS.vocabulary +
    scores.pronunciation * WEIGHTS.pronunciation +
    scores.coherence * WEIGHTS.coherence +
    scores.interaction * WEIGHTS.interaction
  );
}
