import { describe, it, expect } from "vitest";
import { newAccumulator, computeMetrics } from "./metrics.js";
import type { TranscriptTurn } from "@ec/openai";

describe("computeMetrics", () => {
  it("computes word count, WPM, and pause stats from learner turns", () => {
    const turns: TranscriptTurn[] = [
      { speaker: "learner", text: "Yesterday I went to work by train", startedAt: 1000, endedAt: 4000 },
      { speaker: "coach", text: "Nice.", startedAt: 4100, endedAt: 4500 },
      { speaker: "learner", text: "It takes about twenty minutes", startedAt: 4900, endedAt: 7000 },
    ];
    const m = computeMetrics(turns, 10_000);
    expect(m.userWordCount).toBe(12);
    expect(m.utteranceCount).toBe(2);
    expect(m.speakingSeconds).toBe(5);              // 3s + 2s of learner speech
    expect(m.wordsPerMinute).toBe(144);            // 12 words / (5s/60) — speaking-time basis
    expect(m.pauseCount).toBe(1);                    // 4900 - 4000 = 900ms gap > 800ms threshold
    expect(m.avgPauseMs).toBe(900);
    expect(m.longestPauseMs).toBe(900);
    expect(m.avgUtteranceWords).toBe(6);
  });
  it("handles a session with no learner speech", () => {
    const m = computeMetrics([{ speaker: "coach", text: "Hello?", startedAt: 0, endedAt: 1000 }], 2000);
    expect(m.userWordCount).toBe(0);
    expect(m.wordsPerMinute).toBe(0);
    expect(m.pauseCount).toBe(0);
  });
});

describe("MetricsAccumulator", () => {
  it("matches computeMetrics on the same data", () => {
    const acc = newAccumulator();
    acc.addLearnerUtterance("Yesterday I went to work by train", 1000, 4000, 0);
    acc.addLearnerUtterance("It takes about twenty minutes", 4900, 7000, 500);
    const m = acc.finish(10_000);
    expect(m.userWordCount).toBe(12);
    expect(m.pauseCount).toBe(1);
    expect(m.speakingSeconds).toBe(5);
  });
});
