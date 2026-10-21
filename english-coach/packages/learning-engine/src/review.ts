import { clamp01 } from "./mastery.js";

/** Bumped whenever `nextIntervalDays` changes shape — attempts record it. */
export const SCHEDULER_VERSION = "interval-v1";

export type ReviewOutcome = "correct" | "incorrect";
export type PromptType = "recognition" | "production";

const DAY_MS = 86_400_000;
const MAX_DAYS = 180;

/**
 * A simple, documented interval policy — NOT SM-2 or FSRS, and not claimed to
 * be (spec §7.4 "do not claim algorithm compatibility unless the implementation
 * follows its specification").
 *
 * Correct recall multiplies the interval by 2.5; a lapse drops it back to 1 day.
 * That is deliberately forgiving: one missed word is not evidence the word was
 * never learned, so a lapse reschedules soon without resetting mastery.
 */
export function nextIntervalDays(prevIntervalDays: number | null, outcome: ReviewOutcome): number {
  if (outcome === "incorrect") return 1;
  const base = prevIntervalDays ?? 1;
  return Math.min(MAX_DAYS, Math.max(1, Math.round(base * 2.5)));
}

/** New mastery after an attempt. A hint is a partial success, not a miss. */
export function applyReviewOutcome(mastery: number, outcome: ReviewOutcome, hintUsed: boolean): number {
  if (outcome === "incorrect") return clamp01(mastery - 0.08);
  return clamp01(mastery + (hintUsed ? 0.02 : 0.06));
}

export function dueAt(now: number, intervalDays: number): number {
  return now + intervalDays * DAY_MS;
}

/** True when an item has no schedule yet, or its review time has passed. */
export function isDue(nextReviewAt: number | null, now: number): boolean {
  return nextReviewAt === null || nextReviewAt <= now;
}

/**
 * Picks what to review in the time available (spec §7.4 requirement 1) and
 * mixes recognition with production (requirement 2).
 *
 * Due items come first, soonest first; the least-recently-seen word breaks
 * ties so a stalled learner does not see the same three words forever.
 * The prompt type alternates off the position so one session is not all
 * recognition — production is the skill the learner actually needs.
 */
export function selectReviewQueue<T extends { word: string; productionMastery: number; nextReviewAt: number | null }>(
  items: T[],
  now: number,
  limit: number,
): { item: T; promptType: PromptType }[] {
  return items
    .filter((i) => isDue(i.nextReviewAt, now))
    .sort((a, b) => (a.nextReviewAt ?? 0) - (b.nextReviewAt ?? 0) || a.word.localeCompare(b.word))
    .slice(0, Math.max(0, limit))
    .map((item, i) => ({
      item,
      // Production only where some recall exists; a brand-new word is seen
      // first (recognition) before being demanded in speech.
      promptType: i % 2 === 1 && item.productionMastery > 0.15 ? "production" : "recognition",
    }));
}
