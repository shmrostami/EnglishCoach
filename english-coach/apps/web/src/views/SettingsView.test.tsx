// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { SettingsView } from "./SettingsView.js";

vi.mock("../api/client.js", () => ({
  api: {
    preferences: vi.fn(),
    savePreferences: vi.fn(),
  },
}));

let root: Root;

async function render(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container); root.render(<SettingsView />); });
  return container;
}

async function unmount(container: HTMLElement): Promise<void> {
  await act(async () => root.unmount());
  container.remove();
}

const UNSET = {
  correctionStyle: null, preferredSessionMinutes: null,
  preferredFeedbackLanguage: null, preferredAccent: null, updatedAt: null,
};

describe("SettingsView", () => {
  beforeEach(async () => {
    const { api } = await import("../api/client.js");
    vi.mocked(api.preferences).mockResolvedValue(UNSET as never);
    vi.mocked(api.savePreferences).mockResolvedValue({ ok: true } as never);
  });

  it("renders an unset preference as empty, not as a chosen default", async () => {
    const container = await render();
    const style = container.querySelector("select") as HTMLSelectElement;
    expect(style.value).toBe("");
    expect(container.textContent).toContain("never change your assessed level");
    await unmount(container);
  });

  it("saves only the fields the learner filled in", async () => {
    const { api } = await import("../api/client.js");
    const container = await render();
    const inputs = [...container.querySelectorAll("input")] as HTMLInputElement[];
    const minutes = inputs.find((i) => i.type === "number")!;
    await act(async () => {
      // React reads the DOM value through its own setter; set then dispatch.
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(minutes, "20");
      minutes.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    // A blank style is not sent, so it cannot overwrite a stored preference.
    expect(vi.mocked(api.savePreferences)).toHaveBeenCalledWith({ preferredSessionMinutes: 20 });
    await unmount(container);
  });

  it("reports a save failure instead of claiming success", async () => {
    const { api } = await import("../api/client.js");
    vi.mocked(api.savePreferences).mockRejectedValueOnce(new Error("400 invalid"));
    const container = await render();
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(container.textContent).toContain("Couldn't save");
    expect(container.textContent).not.toContain("Saved.");
    await unmount(container);
  });

  it("surfaces a load failure rather than an empty settings form", async () => {
    const { api } = await import("../api/client.js");
    vi.mocked(api.preferences).mockRejectedValueOnce(new Error("boom"));
    const container = await render();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await unmount(container);
  });
});
