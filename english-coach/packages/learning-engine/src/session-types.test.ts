import { describe, it, expect } from "vitest";
import {
  SESSION_TYPES, selectSessionType, renderSessionPrompt, type SessionType,
} from "./session-types.js";

describe("selectSessionType", () => {
  it("gives a beginner a mode they can handle", () => {
    const spec = selectSessionType({ difficulty: 0.3, recentTypes: [] });
    expect(spec.cognitiveDemand).toBeLessThanOrEqual(0.3 + 0.12);
  });

  it("gives an advanced learner a demanding mode", () => {
    const spec = selectSessionType({ difficulty: 0.9, recentTypes: [] });
    expect(spec.cognitiveDemand).toBeGreaterThan(0.6);
  });

  it("rotates: it does not pick the mode the learner just did", () => {
    const first = selectSessionType({ difficulty: 0.6, recentTypes: [] });
    const second = selectSessionType({ difficulty: 0.6, recentTypes: [first.type] });
    expect(second.type).not.toBe(first.type);
  });

  it("still returns a mode when every candidate was just used", () => {
    const all = SESSION_TYPES.map((s) => s.type);
    const spec = selectSessionType({ difficulty: 0.9, recentTypes: all });
    expect(spec).toBeTruthy();
    expect(all).toContain(spec.type);
  });

  it("never asks for more demand than the learner can take", () => {
    for (const difficulty of [0.2, 0.4, 0.6, 0.8, 0.95]) {
      const spec = selectSessionType({ difficulty, recentTypes: [] });
      expect(spec.cognitiveDemand).toBeLessThanOrEqual(difficulty + 0.12);
    }
  });

  it("is deterministic", () => {
    const a = selectSessionType({ difficulty: 0.55, recentTypes: ["conversation"] });
    const b = selectSessionType({ difficulty: 0.55, recentTypes: ["conversation"] });
    expect(a.type).toBe(b.type);
  });
});

describe("renderSessionPrompt", () => {
  it("fills the topic into the mode's template", () => {
    const spec = SESSION_TYPES.find((s) => s.type === "opinion_debate")!;
    const prompt = renderSessionPrompt(spec, "remote work");
    expect(prompt).toContain("remote work");
    expect(prompt).not.toContain("{topic}");
  });

  it("fills the role when the mode asks for one", () => {
    const spec = SESSION_TYPES.find((s) => s.type === "role_play")!;
    const prompt = renderSessionPrompt(spec, "a job interview", "a hiring manager");
    expect(prompt).toContain("a hiring manager");
    expect(prompt).not.toContain("{role}");
  });

  it("uses a default role when none is given", () => {
    const spec = SESSION_TYPES.find((s) => s.type === "professional_simulation")!;
    expect(renderSessionPrompt(spec, "a conflict")).not.toContain("{role}");
  });
});

describe("SESSION_TYPES", () => {
  it("covers the six modes the design lists", () => {
    const types: SessionType[] = SESSION_TYPES.map((s) => s.type);
    expect(types).toEqual([
      "conversation", "storytelling", "role_play",
      "problem_solving", "opinion_debate", "professional_simulation",
    ]);
  });

  it("orders the modes by rising cognitive demand", () => {
    const demands = SESSION_TYPES.map((s) => s.cognitiveDemand);
    for (let i = 1; i < demands.length; i++) {
      expect(demands[i]).toBeGreaterThan(demands[i - 1]);
    }
  });
});
