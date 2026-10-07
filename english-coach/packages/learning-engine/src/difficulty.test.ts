import { describe, it, expect } from "vitest";
import { adjustDifficulty, recentPerformance } from "./difficulty.js";

describe("adjustDifficulty", () => {
  it("raises at >= 0.85 by 0.05, capped at 0.95", () => {
    expect(adjustDifficulty(0.6, 0.9)).toBeCloseTo(0.65);
    expect(adjustDifficulty(0.94, 0.9)).toBeCloseTo(0.95);
  });
  it("raises at 0.75..0.85 by 0.02", () => {
    expect(adjustDifficulty(0.6, 0.8)).toBeCloseTo(0.62);
  });
  it("holds at 0.55..0.75", () => {
    expect(adjustDifficulty(0.6, 0.7)).toBe(0.6);
  });
  it("lowers below 0.55 by 0.05, floored at 0.15", () => {
    expect(adjustDifficulty(0.5, 0.3)).toBeCloseTo(0.45);
    expect(adjustDifficulty(0.16, 0.2)).toBeCloseTo(0.15);
  });
  it("never changes by more than 0.05", () => {
    for (const d of [0.15, 0.5, 0.95]) {
      for (const p of [0, 0.4, 0.6, 0.79, 0.86, 1]) {
        const next = adjustDifficulty(d, p);
        expect(Math.abs(next - d)).toBeLessThanOrEqual(0.05 + 1e-9);
      }
    }
  });
});

describe("recentPerformance", () => {
  it("averages the last 5 scores", () => {
    expect(recentPerformance([0.6, 0.7, 0.8, 0.9, 1.0])).toBeCloseTo(0.8);
  });
  it("uses the single score for a first session", () => {
    expect(recentPerformance([0.42])).toBeCloseTo(0.42);
  });
});
