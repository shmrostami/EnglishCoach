// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { MemoryRouter } from "react-router-dom";
import App from "./App.js";

// A crashing view must not take the whole app down with it: the error
// boundary catches, shows a message, and leaves the nav usable.
vi.mock("./views/DashboardView.js", () => ({
  DashboardView: () => { throw new Error("view exploded"); },
}));

describe("App", () => {
  it("survives a crashing route view (error boundary)", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/dashboard"]}>
          <App />
        </MemoryRouter>,
      );
    });
    expect(container.textContent).toContain("Something went wrong");
    // nav remains so the learner can leave the broken view
    expect(container.textContent).toContain("Session");
    expect(container.textContent).toContain("Goals");
    await act(async () => root.unmount());
    container.remove();
  });
});
