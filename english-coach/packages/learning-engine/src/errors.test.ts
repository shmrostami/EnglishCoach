import { describe, it, expect } from "vitest";
import {
  upsertErrorInput, effectiveFrequency, isRecurring, shouldRetire,
  type ErrorPatternInput,
} from "./errors.js";

const DAY = 86_400_000;
const NOW = 1_000_000_000_000;

describe("upsertErrorInput", () => {
  it("creates a pattern on first high-confidence error", () => {
    const e = upsertErrorInput(null,
      { skill: "grammar.past_tense", pattern: "present_after_past_expr", severity: 0.65, confidence: 0.9 }, NOW)!;
    expect(e.frequency).toBe(1);
    expect(e.confidence).toBe(0.9);
  });
  it("ignores low-confidence observations (no increment, no creation)", () => {
    const e = upsertErrorInput(null,
      { skill: "grammar.articles", pattern: "missing_article", severity: 0.3, confidence: 0.6 }, NOW);
    expect(e).toBeNull();
  });
  it("increments frequency and takes max confidence on repeat", () => {
    const first = upsertErrorInput(null,
      { skill: "grammar.past_tense", pattern: "p", severity: 0.6, confidence: 0.85 }, NOW - DAY)!;
    const second = upsertErrorInput(first,
      { skill: "grammar.past_tense", pattern: "p", severity: 0.7, confidence: 0.92 }, NOW)!;
    expect(second.frequency).toBe(2);
    expect(second.confidence).toBe(0.92);
  });
});

describe("effectiveFrequency", () => {
  it("decays over time", () => {
    const fresh = effectiveFrequency(6, NOW, NOW);
    const old = effectiveFrequency(6, NOW - 90 * DAY, NOW);
    expect(old).toBeLessThan(fresh);
  });
  it("damps a 90-day-old error below 1", () => {
    expect(effectiveFrequency(3, NOW - 90 * DAY, NOW)).toBeLessThan(1);
  });
});

describe("isRecurring", () => {
  it("requires frequency >= 3 AND confidence >= 0.75", () => {
    expect(isRecurring({ frequency: 2, confidence: 0.9, lastSeenAt: NOW, status: "active" } as ErrorPatternInput)).toBe(false);
    expect(isRecurring({ frequency: 3, confidence: 0.7, status: "active" } as ErrorPatternInput)).toBe(false);
    expect(isRecurring({ frequency: 3, confidence: 0.8, status: "active" } as ErrorPatternInput)).toBe(true);
  });
});

describe("shouldRetire", () => {
  it("retires when unseen for 90 days (effective frequency < 1)", () => {
    const e = { frequency: 3, confidence: 0.8, lastSeenAt: NOW - 90 * DAY, status: "active" } as ErrorPatternInput;
    expect(shouldRetire(e, 0.6, NOW)).toBe(true);
  });
  it("retires when the skill is mastered", () => {
    const e = { frequency: 4, confidence: 0.8, lastSeenAt: NOW, status: "active" } as ErrorPatternInput;
    expect(shouldRetire(e, 0.85, NOW)).toBe(true);
  });
  it("keeps active errors", () => {
    const e = { frequency: 4, confidence: 0.8, lastSeenAt: NOW, status: "active" } as ErrorPatternInput;
    expect(shouldRetire(e, 0.4, NOW)).toBe(false);
  });
});
