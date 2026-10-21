// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { DashboardView } from "./DashboardView.js";

// The API sends plan targets as PARSED ARRAYS (the route JSON.parse's the
// stored JSON string before responding). The view must render them as-is.
vi.mock("../api/client.js", () => ({
  api: {
    profile: vi.fn(async () => ({ estimatedLevel: "B1", estimatedLevelConfidence: 0.5 })),
    // observationCount (camelCase) is the real wire shape — Drizzle
    // serializes the snake_case column as camelCase. The old view read
    // `observation_count`, which the API never sends.
    skills: vi.fn(async () => [{ code: "grammar.past_tense", mastery: 0.4, confidence: 0.9, trend: "improving", observationCount: 3 }]),
    plan: vi.fn(async () => ({
      difficulty: 0.45,
      primaryTargets: ["grammar.past_tense"],
      secondaryTargets: ["vocabulary.travel"],
      topic: "weekends",
      reasoning: "recurring past-tense errors",
    })),
    progress: vi.fn(async () => []),
    // The dashboard now also loads the level history for the trend section.
    levelHistory: vi.fn(async () => ({ sessions: 0, history: [], trends: {}, levels: [] })),
    goals: vi.fn(async () => []),
  },
}));

let root: Root;

async function render(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container); root.render(<DashboardView />); });
  return container;
}

async function unmount(container: HTMLElement): Promise<void> {
  await act(async () => root.unmount());
  container.remove();
}

describe("DashboardView", () => {
  it("renders the active plan from the wire shape (targets are arrays, not JSON strings)", async () => {
    const container = await render();
    expect(container.textContent).toContain("grammar.past_tense");
    expect(container.textContent).toContain("vocabulary.travel");
    expect(container.textContent).toContain("weekends");
    await unmount(container);
  });

  it("shows an unassessed dimension as 'not assessed', never as 0%", async () => {
    const { api } = await import("../api/client.js");
    vi.mocked(api.progress).mockResolvedValueOnce([
      {
        id: "sess-1", startedAt: Date.now(), topic: "weekends",
        scores: { fluency: 0.7, grammar: 0.6, vocabulary: 0.8, pronunciation: null, coherence: 0.55, interaction: 0.9 },
        overall: 0.72,
      },
    ] as never);
    const container = await render();
    expect(container.textContent).toContain("Pronunciation: not assessed");
    expect(container.textContent).toContain("Fluency: 70%");
    await unmount(container);
  });
});

describe("DashboardView with no plan", () => {
  beforeEach(async () => {
    const { api } = await import("../api/client.js");
    vi.mocked(api.plan).mockResolvedValueOnce(null as never);
  });

  it("renders an empty state, not an error (a learner with no plan is valid)", async () => {
    const container = await render();
    expect(container.textContent).toContain("No plan yet");
    // Not a failure banner.
    expect(container.textContent).not.toContain("didn't load");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await unmount(container);
  });
});
