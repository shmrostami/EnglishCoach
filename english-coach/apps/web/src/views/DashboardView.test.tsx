// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { DashboardView } from "./DashboardView.js";

// The API sends plan targets as PARSED ARRAYS (the route JSON.parse's the
// stored JSON string before responding). The view must render them as-is.
vi.mock("../api/client.js", () => ({
  api: {
    profile: async () => ({ estimatedLevel: "B1", estimatedLevelConfidence: 0.5 }),
    // observationCount (camelCase) is the real wire shape — Drizzle
    // serializes the snake_case column as camelCase. The old view read
    // `observation_count`, which the API never sends.
    skills: async () => [{ code: "grammar.past_tense", mastery: 0.4, confidence: 0.9, trend: "improving", observationCount: 3 }],
    plan: async () => ({
      difficulty: 0.45,
      primaryTargets: ["grammar.past_tense"],
      secondaryTargets: ["vocabulary.travel"],
      topic: "weekends",
      reasoning: "recurring past-tense errors",
    }),
    progress: async () => [],
    goals: async () => [],
  },
}));

let root: Root;

describe("DashboardView", () => {
  it("renders the active plan from the wire shape (targets are arrays, not JSON strings)", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => { root = createRoot(container); root.render(<DashboardView />); });
    expect(container.textContent).toContain("grammar.past_tense");
    expect(container.textContent).toContain("vocabulary.travel");
    expect(container.textContent).toContain("weekends");
    await act(async () => root.unmount());
    container.remove();
  });
});
