import type { SessionMetrics } from "@ec/domain";
import type { TranscriptTurn } from "@ec/openai";

const PAUSE_THRESHOLD_MS = 800;

interface Turn { text: string; startedAt: number; endedAt: number; }

export interface MetricsAccumulator {
  addLearnerUtterance(text: string, startedAt: number, endedAt: number, pauseBeforeMs: number): void;
  finish(now: number): SessionMetrics;
}

export function newAccumulator(): MetricsAccumulator {
  const turns: Turn[] = [];
  let pauseSum = 0;
  let longestPause = 0;

  return {
    addLearnerUtterance(text, startedAt, endedAt, pauseBeforeMs) {
      turns.push({ text, startedAt, endedAt });
      if (pauseBeforeMs > 0) {
        pauseSum += pauseBeforeMs;
        longestPause = Math.max(longestPause, pauseBeforeMs);
      }
    },
    finish(now) {
      void now;
      const speakingMs = turns.reduce((s, t) => s + Math.max(0, t.endedAt - t.startedAt), 0);
      const speakingSeconds = Math.round(speakingMs / 1000);
      const userWordCount = turns.reduce((s, t) => s + t.text.split(/\s+/).filter(Boolean).length, 0);
      return {
        speakingSeconds,
        userWordCount,
        wordsPerMinute: speakingSeconds > 0 ? Math.round(userWordCount / (speakingSeconds / 60)) : 0,
        pauseCount: turns.length > 1 && longestPause > 0 ? turns.filter((t, i) => i > 0 && pauseBefore(t, turns[i - 1])).length : 0,
        avgPauseMs: 0,
        longestPauseMs: longestPause,
        utteranceCount: turns.length,
        avgUtteranceWords: turns.length > 0 ? Math.round(userWordCount / turns.length) : 0,
      };
    },
  };

  function pauseBefore(t: Turn, prev: Turn): boolean {
    return t.startedAt - prev.endedAt > PAUSE_THRESHOLD_MS;
  }
}

export function computeMetrics(turns: TranscriptTurn[], now: number): SessionMetrics {
  const acc = newAccumulator();
  let prevEnd: number | null = null;
  for (const t of turns) {
    if (t.speaker !== "learner") continue;
    const pause = prevEnd !== null && t.startedAt - prevEnd > PAUSE_THRESHOLD_MS ? t.startedAt - prevEnd : 0;
    acc.addLearnerUtterance(t.text, t.startedAt, t.endedAt, pause);
    prevEnd = t.endedAt;
  }
  void now;
  const base = acc.finish(now);
  return {
    ...base,
    avgPauseMs: base.pauseCount > 0 ? Math.round((turns
      .filter((t) => t.speaker === "learner")
      .map((t, i, arr) => i > 0 && t.speaker === "learner"
        ? t.startedAt - prevLearnerEnd(arr, i) : 0)
      .filter((p) => p > PAUSE_THRESHOLD_MS)
      .reduce((a, b) => a + b, 0)) / base.pauseCount) : 0,
  };
  function prevLearnerEnd(arr: TranscriptTurnLike[], i: number): number {
    for (let j = i - 1; j >= 0; j--) if (arr[j].speaker === "learner") return arr[j].endedAt;
    return 0;
  }
}

type TranscriptTurnLike = { speaker: "learner" | "coach"; text: string; startedAt: number; endedAt: number };
