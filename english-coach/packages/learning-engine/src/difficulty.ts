export function adjustDifficulty(current: number, recentPerformance: number): number {
  let next: number;
  if (recentPerformance >= 0.85) next = current + 0.05;
  else if (recentPerformance >= 0.75) next = current + 0.02;
  else if (recentPerformance >= 0.55) next = current;
  else next = current - 0.05;
  return Math.min(0.95, Math.max(0.15, next));
}

export function recentPerformance(sessionScores: number[]): number {
  const last5 = sessionScores.slice(-5);
  return last5.reduce((a, b) => a + b, 0) / last5.length;
}
