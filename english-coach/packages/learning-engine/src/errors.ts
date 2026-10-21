export interface ErrorPatternInput {
  skill: string;
  pattern: string;
  description?: string;
  frequency: number;
  severity: number;
  mastery: number;
  confidence: number;
  status: "active" | "mastered";
  firstSeenAt: number;
  lastSeenAt: number;
}

const CONFIDENCE_GATE = 0.8;

export function upsertErrorInput(
  prev: ErrorPatternInput | null,
  obs: { skill: string; pattern: string; severity: number; confidence: number },
  now: number,
): ErrorPatternInput | null {
  if (obs.confidence < CONFIDENCE_GATE) return prev;
  if (!prev || prev.skill !== obs.skill || prev.pattern !== obs.pattern) {
    return {
      skill: obs.skill, pattern: obs.pattern,
      frequency: 1, severity: obs.severity, mastery: 0,
      confidence: obs.confidence, status: "active",
      firstSeenAt: now, lastSeenAt: now,
    };
  }
  return {
    ...prev,
    frequency: prev.frequency + 1,
    severity: Math.max(prev.severity, obs.severity),
    confidence: Math.max(prev.confidence, obs.confidence),
    lastSeenAt: now,
  };
}

export function effectiveFrequency(freq: number, lastSeenAt: number, now: number): number {
  const days = (now - lastSeenAt) / 86_400_000;
  return freq * Math.exp(-Math.max(0, days) / 30);
}

export function isRecurring(e: ErrorPatternInput): boolean {
  return e.status === "active" && e.frequency >= 3 && e.confidence >= 0.75;
}

export function shouldRetire(e: ErrorPatternInput, skillMastery: number, now: number): boolean {
  if (e.status !== "active") return false;
  if (skillMastery >= 0.8) return true;
  return effectiveFrequency(e.frequency, e.lastSeenAt, now) < 1;
}

/**
 * Direction of an error pattern, from how often it was observed per session.
 *
 * Takes the counts oldest→newest. Fewer than two sessions with this skill is
 * not a trend, it is a sample: the answer is `null` ("not enough evidence"),
 * never "stable" (spec §3 principle 7).
 */
export function errorTrend(perSessionCounts: number[]): "improving" | "stable" | "declining" | null {
  if (perSessionCounts.length < 2) return null;
  const half = Math.floor(perSessionCounts.length / 2);
  const mean = (a: number[]) => (a.length === 0 ? 0 : a.reduce((s, x) => s + x, 0) / a.length);
  const delta = mean(perSessionCounts.slice(-half)) - mean(perSessionCounts.slice(0, half));
  if (delta < -0.5) return "improving";
  if (delta > 0.5) return "declining";
  return "stable";
}
