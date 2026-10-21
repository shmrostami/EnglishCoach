// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { ReviewSections } from "./ReviewSections.js";

vi.mock("../api/client.js", () => ({
  api: {
    errors: vi.fn(),
    reviewQueue: vi.fn(),
    recordReview: vi.fn(),
  },
}));

let root: Root;

async function render(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container); root.render(<ReviewSections />); });
  return container;
}

async function unmount(container: HTMLElement): Promise<void> {
  await act(async () => root.unmount());
  container.remove();
}

const PATTERN = {
  id: "err-1", skill: "grammar.past_tense", pattern: "present_form_after_past_time_expression",
  description: "Base form after a past time expression", frequency: 3, effectiveFrequency: 2.4,
  severity: 0.65, confidence: 0.97, status: "active",
  firstSeenAt: Date.now() - 86_400_000, lastSeenAt: Date.now(),
  trend: null as null | string,
  example: { original: "Yesterday I go to work", suggested: "Yesterday I went to work" },
};

describe("ReviewSections", () => {
  beforeEach(async () => {
    const { api } = await import("../api/client.js");
    vi.mocked(api.errors).mockResolvedValue({ patterns: [PATTERN], generatedAt: Date.now() } as never);
    vi.mocked(api.reviewQueue).mockResolvedValue([] as never);
  });

  it("renders a recurring error with its example and frequency", async () => {
    const container = await render();
    const text = container.textContent ?? "";
    expect(text).toContain("grammar.past_tense");
    expect(text).toContain("Yesterday I went to work");
    expect(text).toContain("seen 3×");
    await unmount(container);
  });

  it("says there is not enough evidence for a trend rather than claiming 'stable'", async () => {
    const container = await render();
    expect(container.textContent).toContain("not enough evidence for a trend");
    // A null trend must never be rendered as a direction.
    expect(container.querySelector(".ec-trend--stable")).toBeNull();
    await unmount(container);
  });

  it("hides a retired pattern — history, not a to-do", async () => {
    const { api } = await import("../api/client.js");
    vi.mocked(api.errors).mockResolvedValueOnce({
      patterns: [{ ...PATTERN, status: "mastered" }], generatedAt: Date.now(),
    } as never);
    const container = await render();
    expect(container.textContent).toContain("No recurring errors tracked yet");
    await unmount(container);
  });

  it("records a review attempt and reports the new interval", async () => {
    const { api } = await import("../api/client.js");
    vi.mocked(api.reviewQueue).mockResolvedValueOnce([
      { word: "negotiate", promptType: "production", recognitionMastery: 0.3, productionMastery: 0.4, nextReviewAt: null },
    ] as never);
    vi.mocked(api.recordReview).mockResolvedValueOnce({
      word: "negotiate", intervalDays: 3, nextReviewAt: Date.now() + 1, schedulerVersion: "interval-v1",
    } as never);

    const container = await render();
    expect(container.textContent).toContain("negotiate");

    const correct = [...container.querySelectorAll("button")].find((b) => b.textContent === "I knew it")!;
    await act(async () => { correct.click(); });

    expect(vi.mocked(api.recordReview)).toHaveBeenCalledWith("negotiate", { outcome: "correct", promptType: "production" });
    expect(container.textContent).toContain("next review in 3 days");
    // The answered word leaves the queue.
    expect(container.textContent).not.toContain("I knew it");
    await unmount(container);
  });

  it("surfaces a fetch failure instead of showing an empty list as success", async () => {
    const { api } = await import("../api/client.js");
    vi.mocked(api.errors).mockRejectedValueOnce(new Error("boom"));
    const container = await render();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await unmount(container);
  });
});
