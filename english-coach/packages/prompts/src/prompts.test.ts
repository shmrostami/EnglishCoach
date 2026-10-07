import { describe, it, expect } from "vitest";
import { loadPrompt, renderPrompt, promptMeta } from "./index.js";

describe("prompt loader", () => {
  it("loads all four versioned prompts", () => {
    for (const name of ["conversation", "analysis", "planning", "memory"] as const) {
      expect(loadPrompt(name).length).toBeGreaterThan(100);
    }
  });
  it("renders slots", () => {
    const rendered = renderPrompt("conversation", {
      learner_context: "LEVEL B1+", targets: "past_tense", difficulty: "0.61",
    });
    expect(rendered).toContain("LEVEL B1+");
    expect(rendered).not.toContain("{{learner_context}}");
  });
  it("keeps unknown slots intact", () => {
    expect(renderPrompt("conversation", { learner_context: "x" })).toContain("{{targets}}");
  });
  it("exposes registry metadata", () => {
    const meta = promptMeta("analysis");
    expect(meta.version).toBe("v1");
    expect(meta.temperature).toBe(0.2);
  });
});
