// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ReviewView } from "./ReviewView.js";

vi.mock("../api/client.js", () => ({
  api: {
    progress: vi.fn(async () => [{ id: "sess-new" }]),
    feedback: vi.fn(),
    // ReviewView now renders ReviewSections, which loads these too.
    errors: vi.fn(async () => ({ patterns: [], generatedAt: Date.now() })),
    reviewQueue: vi.fn(async () => []),
    recordReview: vi.fn(),
  },
}));

let root: Root;

async function render(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={["/review"]}>
        <Routes><Route path="/review" element={<ReviewView />} /></Routes>
      </MemoryRouter>,
    );
  });
  return container;
}

async function unmount(container: HTMLElement): Promise<void> {
  await act(async () => root.unmount());
  container.remove();
}

const FEEDBACK = {
  sessionId: "sess-new",
  state: "COMPLETED",
  feedback: {
    sessionId: "sess-new",
    topic: "A difficult decision",
    startedAt: Date.now(),
    scores: { fluency: 0.7, grammar: 0.6, vocabulary: 0.8, pronunciation: null, coherence: 0.55, interaction: 0.9 },
    notAssessed: ["pronunciation"],
    strengths: [{ skill: "vocabulary.precision", evidence: "used 'negotiate' in context", confidence: 0.8 }],
    corrections: [{
      id: "corr-1", original: "Yesterday I go to work", suggested: "Yesterday I went to work",
      explanation: 'Replace "go" with "went" here.', skill: "grammar.past_tense",
      evidence: "Yesterday I go to work", confidence: 0.9, learnerAction: "pending",
    }],
    vocabulary: ["negotiate"],
    next: { topic: "past weekends", targets: ["grammar.past_tense"], reason: "recurring past-tense errors" },
  },
};

describe("ReviewView", () => {
  beforeEach(async () => {
    const { api } = await import("../api/client.js");
    vi.mocked(api.feedback).mockResolvedValue(FEEDBACK as never);
  });

  it("renders the persisted review: correction, unassessed dimension, next plan", async () => {
    const container = await render();
    const text = container.textContent ?? "";
    expect(text).toContain("Yesterday I went to work");
    expect(text).toContain("Pronunciation");
    // An unmeasured dimension is labelled, never rendered as 0%.
    expect(text).toContain("not assessed");
    expect(text).not.toContain("Pronunciation0%");
    expect(text).toContain("grammar.past_tense");
    expect(text).toContain("recurring past-tense errors");
    await unmount(container);
  });

  it("shows a still-analysing session as a state, not an error", async () => {
    const { api } = await import("../api/client.js");
    vi.mocked(api.feedback).mockResolvedValueOnce({ sessionId: "sess-new", state: "ANALYZING", feedback: null } as never);
    const container = await render();
    expect(container.textContent).toContain("still being analysed");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await unmount(container);
  });

  it("reports a failed analysis without pretending there is feedback", async () => {
    const { api } = await import("../api/client.js");
    vi.mocked(api.feedback).mockResolvedValueOnce({ sessionId: "sess-new", state: "FAILED", feedback: null } as never);
    const container = await render();
    expect(container.textContent).toContain("failed");
    expect(container.textContent).not.toContain("Corrections");
    await unmount(container);
  });

  it("loads an empty state when there is no completed session yet", async () => {
    const { api } = await import("../api/client.js");
    vi.mocked(api.progress).mockResolvedValueOnce([] as never);
    const container = await render();
    expect(container.textContent).toContain("No finished session to review yet");
    await unmount(container);
  });
});
