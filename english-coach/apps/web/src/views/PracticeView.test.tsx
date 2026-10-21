// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { PracticeView } from "./PracticeView.js";

vi.mock("../api/client.js", () => ({
  api: {
    diagnostic: vi.fn(),
    objectives: vi.fn(),
    recommendedActivity: vi.fn(),
    runDiagnostic: vi.fn(),
    addObjective: vi.fn(),
    startAttempt: vi.fn(),
  },
}));

let root: Root;

async function render(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container); root.render(<PracticeView />); });
  return container;
}

async function unmount(container: HTMLElement): Promise<void> {
  await act(async () => root.unmount());
  container.remove();
}

describe("PracticeView", () => {
  beforeEach(async () => {
    const { api } = await import("../api/client.js");
    vi.mocked(api.diagnostic).mockResolvedValue({ diagnostic: null } as never);
    vi.mocked(api.objectives).mockResolvedValue([] as never);
    vi.mocked(api.recommendedActivity).mockResolvedValue({ activity: null, reason: "No active objective — start a free conversation or add one." } as never);
    vi.mocked(api.addObjective).mockResolvedValue({ id: "obj-1" } as never);
    vi.mocked(api.startAttempt).mockResolvedValue({ attemptId: "att-1", status: "in_progress" } as never);
  });

  it("offers the placement form when no diagnostic exists", async () => {
    const container = await render();
    expect(container.textContent).toContain("Three questions. This places you");
    expect(container.querySelector("form")).not.toBeNull();
    await unmount(container);
  });

  it("shows a placement as self-reported, never as a measured score", async () => {
    const { api } = await import("../api/client.js");
    vi.mocked(api.diagnostic).mockResolvedValueOnce({
      diagnostic: { band: "B1", confidence: 0.28, difficulty: 0.55, focusSkills: ["fluency.continuity"], basis: "self_report", rubricVersion: "onboarding-v1" },
    } as never);
    const container = await render();
    expect(container.textContent).toContain("Starting level B1");
    expect(container.textContent).toContain("Based on your own answers, not a measurement");
    await unmount(container);
  });

  it("renders a recommended activity with its prompt and target words", async () => {
    const { api } = await import("../api/client.js");
    vi.mocked(api.recommendedActivity).mockResolvedValueOnce({
      activity: {
        id: "act-1", version: 1, type: "guided_speaking", title: "Guided speaking — Talk about work",
        objectiveIds: ["obj-1"], targetSkillCodes: ["grammar.past_tense"], difficulty: 0.5,
        estimatedMinutes: 3, prompt: "Speak for about 90 seconds about: Talk about work.",
        targetWords: ["negotiate", "budget"], rubricVersion: "guided-speaking-v1", status: "ready",
      },
      reason: "Targets work (priority 80%).",
    } as never);
    const container = await render();
    const text = container.textContent ?? "";
    expect(text).toContain("Guided speaking — Talk about work");
    expect(text).toContain("negotiate");
    expect(text).toContain("3 min");
    await unmount(container);
  });

  it("shows the no-objective reason as an empty state, not an error", async () => {
    const container = await render();
    expect(container.textContent).toContain("No active objective");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await unmount(container);
  });

  it("surfaces a load failure instead of an empty practice screen", async () => {
    const { api } = await import("../api/client.js");
    vi.mocked(api.objectives).mockRejectedValueOnce(new Error("boom"));
    const container = await render();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await unmount(container);
  });
});
