import type { SessionState } from "@ec/domain";

// CLOSING is reachable from every active state so a learner can end the
// session at any time (end path: CLOSING → ANALYZING). FAILED is also
// reachable from every active state (the realtime provider can drop the
// connection mid-session). Terminal states accept no transitions.
const TRANSITIONS: Record<SessionState, SessionState[]> = {
  STARTING: ["WARMUP", "CLOSING", "FAILED"],
  WARMUP: ["CONVERSATION", "CLOSING", "FAILED"],
  CONVERSATION: ["CONVERSATION", "MICRO_COACH", "TARGET_RETRY", "CHALLENGE", "CLOSING", "FAILED"],
  MICRO_COACH: ["CONVERSATION", "TARGET_RETRY", "CLOSING", "FAILED"],
  TARGET_RETRY: ["CONVERSATION", "CLOSING", "FAILED"],
  CHALLENGE: ["CONVERSATION", "CLOSING", "FAILED"],
  CLOSING: ["ANALYZING"],
  ANALYZING: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  FAILED: [],
};

export function canTransition(from: SessionState, to: SessionState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function nextAllowed(from: SessionState): SessionState[] {
  return TRANSITIONS[from] ?? [];
}
