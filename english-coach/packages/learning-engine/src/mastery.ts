import type { SkillState, Trend } from "@ec/domain";

export function updateSkill(prev: SkillState, observation: number, now: number): SkillState {
  const alpha = prev.observationCount < 5 ? 0.25 : 0.15;
  const mastery = clamp01(prev.mastery * (1 - alpha) + observation * alpha);
  const confidence = Math.min(0.95, prev.confidence + 0.05);
  return {
    mastery,
    confidence,
    observationCount: prev.observationCount + 1,
    trend: prev.trend, // caller updates trend after pushing to its history window
  };
}

const WINDOW = 5;
export function computeTrend(history: number[]): Trend {
  if (history.length < 3) return "stable";
  const recent = history.slice(-WINDOW);
  const half = Math.floor(recent.length / 2);
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  const delta = mean(recent.slice(half)) - mean(recent.slice(0, half));
  if (delta > 0.05) return "improving";
  if (delta < -0.05) return "declining";
  return "stable";
}

/** Two-point trend analog of computeTrend — same 0.05 threshold on (next - prev). */
export function trendFromDelta(prev: number, next: number): Trend {
  const delta = next - prev;
  if (delta > 0.05) return "improving";
  if (delta < -0.05) return "declining";
  return "stable";
}

export function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}
