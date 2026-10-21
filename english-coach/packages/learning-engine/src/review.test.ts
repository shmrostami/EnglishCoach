import { describe, it, expect } from "vitest";
import {
  nextIntervalDays, applyReviewOutcome, dueAt, isDue, selectReviewQueue, SCHEDULER_VERSION,
} from "./review.js";
import { errorTrend } from "./errors.js";

const DAY = 86_400_000;

describe("nextIntervalDays", () => {
  it("expands a correct recall and starts a new item at one day", () => {
    expect(nextIntervalDays(null, "correct")).toBe(3); // 1 * 2.5, rounded
    expect(nextIntervalDays(4, "correct")).toBe(10);
  });

  it("drops a lapse back to one day without erasing progress", () => {
    expect(nextIntervalDays(40, "incorrect")).toBe(1);
  });

  it("caps the interval so a word cannot disappear for years", () => {
    expect(nextIntervalDays(1000, "correct")).toBe(180);
  });

  it("is deterministic for the same inputs", () => {
    expect(nextIntervalDays(7, "correct")).toBe(nextIntervalDays(7, "correct"));
  });
});

describe("applyReviewOutcome", () => {
  it("raises mastery on a correct recall, less when a hint was needed", () => {
    expect(applyReviewOutcome(0.5, "correct", false)).toBeCloseTo(0.56, 5);
    expect(applyReviewOutcome(0.5, "correct", true)).toBeCloseTo(0.52, 5);
  });

  it("lowers mastery on a lapse but keeps it in range", () => {
    expect(applyReviewOutcome(0.5, "incorrect", false)).toBeCloseTo(0.42, 5);
    // A lapse on an already-low mastery floors at 0, never negative.
    expect(applyReviewOutcome(0.02, "incorrect", false)).toBe(0);
  });
});

describe("isDue / dueAt", () => {
  it("treats an unscheduled item as due and a future one as not", () => {
    expect(isDue(null, 1000)).toBe(true);
    expect(isDue(1000, 1000)).toBe(true);
    expect(isDue(1001, 1000)).toBe(false);
  });

  it("schedules by whole days from the review instant", () => {
    expect(dueAt(0, 3)).toBe(3 * DAY);
  });
});

describe("selectReviewQueue", () => {
  const item = (word: string, nextReviewAt: number | null, productionMastery = 0.5) =>
    ({ word, nextReviewAt, productionMastery, recognitionMastery: 0.5 });

  it("returns only due items, soonest first", () => {
    const q = selectReviewQueue(
      [item("later", 5000), item("due-now", null), item("earlier", 10)],
      1000, 10,
    );
    expect(q.map((x) => x.item.word)).toEqual(["due-now", "earlier"]);
  });

  it("respects the review-time budget", () => {
    const items = Array.from({ length: 8 }, (_, i) => item(`w${i}`, i));
    expect(selectReviewQueue(items, 1000, 3)).toHaveLength(3);
  });

  it("mixes recognition with production instead of all recognition", () => {
    const q = selectReviewQueue(
      [item("a", 1), item("b", 2), item("c", 3), item("d", 4)],
      1000, 4,
    );
    expect(q.map((x) => x.promptType)).toEqual(["recognition", "production", "recognition", "production"]);
  });

  it("does not demand production for a word with no recall yet", () => {
    const q = selectReviewQueue([item("new", 1, 0.05), item("newer", 2, 0.05)], 1000, 2);
    expect(q.map((x) => x.promptType)).toEqual(["recognition", "recognition"]);
  });

  it("names its scheduler version so attempts stay interpretable", () => {
    expect(SCHEDULER_VERSION).toBe("interval-v1");
  });
});

describe("errorTrend", () => {
  it("is null with fewer than two sessions of evidence, never 'stable'", () => {
    expect(errorTrend([])).toBeNull();
    expect(errorTrend([3])).toBeNull();
  });

  it("reads fewer occurrences as improving and more as declining", () => {
    expect(errorTrend([4, 4, 1, 0])).toBe("improving");
    expect(errorTrend([0, 1, 4, 4])).toBe("declining");
    expect(errorTrend([2, 2, 2, 2])).toBe("stable");
  });
});
