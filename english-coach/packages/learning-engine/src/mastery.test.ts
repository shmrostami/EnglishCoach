import { describe, it, expect } from "vitest";
import { updateSkill, computeTrend, trendFromDelta } from "./mastery.js";
import type { SkillState } from "@ec/domain";

const base: SkillState = { mastery: 0.5, confidence: 0.1, observationCount: 0, trend: "stable" };

describe("updateSkill", () => {
  it("uses alpha 0.25 for the first 5 observations", () => {
    const next = updateSkill(base, 0.9, 0);
    expect(next.mastery).toBeCloseTo(0.5 * 0.75 + 0.9 * 0.25);
    expect(next.observationCount).toBe(1);
    expect(next.confidence).toBeCloseTo(0.15);
  });
  it("switches to alpha 0.15 after 5 observations", () => {
    const prev: SkillState = { mastery: 0.5, confidence: 0.4, observationCount: 5, trend: "stable" };
    const next = updateSkill(prev, 0.9, 0);
    expect(next.mastery).toBeCloseTo(0.5 * 0.85 + 0.9 * 0.15);
  });
  it("caps confidence at 0.95", () => {
    const prev: SkillState = { mastery: 0.5, confidence: 0.94, observationCount: 10, trend: "stable" };
    expect(updateSkill(prev, 0.9, 0).confidence).toBeLessThanOrEqual(0.95);
  });
  it("keeps mastery within [0,1] at boundaries", () => {
    const atOne: SkillState = { mastery: 1, confidence: 0.9, observationCount: 20, trend: "stable" };
    const next = updateSkill(atOne, 0, 0);
    expect(next.mastery).toBeGreaterThanOrEqual(0);
    expect(next.mastery).toBeLessThanOrEqual(1);
  });
});

describe("computeTrend", () => {
  it("detects improving", () => {
    expect(computeTrend([0.42, 0.51, 0.58, 0.71, 0.69])).toBe("improving");
  });
  it("detects declining", () => {
    expect(computeTrend([0.71, 0.62, 0.55, 0.48, 0.41])).toBe("declining");
  });
  it("is stable for flat history", () => {
    expect(computeTrend([0.6, 0.61, 0.59, 0.6])).toBe("stable");
  });
});

describe("trendFromDelta", () => {
  it("improving when next rises > 0.05", () => {
    expect(trendFromDelta(0.5, 0.6)).toBe("improving");
  });
  it("declining when next falls > 0.05", () => {
    expect(trendFromDelta(0.6, 0.5)).toBe("declining");
  });
  it("stable within the 0.05 band", () => {
    expect(trendFromDelta(0.6, 0.62)).toBe("stable");
  });
});
