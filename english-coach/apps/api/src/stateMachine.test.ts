import { describe, it, expect } from "vitest";
import { canTransition } from "./stateMachine.js";

describe("state machine", () => {
  it("follows the spec transition table", () => {
    const ok: [Parameters<typeof canTransition>[0], Parameters<typeof canTransition>[1]][] = [
      ["STARTING", "WARMUP"], ["STARTING", "CLOSING"], ["STARTING", "FAILED"],
      ["WARMUP", "CONVERSATION"], ["WARMUP", "CLOSING"], ["WARMUP", "FAILED"],
      ["CONVERSATION", "CONVERSATION"], ["CONVERSATION", "MICRO_COACH"],
      ["CONVERSATION", "TARGET_RETRY"], ["CONVERSATION", "CHALLENGE"], ["CONVERSATION", "CLOSING"], ["CONVERSATION", "FAILED"],
      ["MICRO_COACH", "CONVERSATION"], ["MICRO_COACH", "TARGET_RETRY"], ["MICRO_COACH", "CLOSING"], ["MICRO_COACH", "FAILED"],
      ["TARGET_RETRY", "CONVERSATION"], ["TARGET_RETRY", "CLOSING"], ["TARGET_RETRY", "FAILED"],
      ["CHALLENGE", "CONVERSATION"], ["CHALLENGE", "CLOSING"], ["CHALLENGE", "FAILED"],
      ["CLOSING", "ANALYZING"], ["ANALYZING", "COMPLETED"], ["ANALYZING", "FAILED"],
    ];
    for (const [from, to] of ok) expect(canTransition(from, to), `${from} -> ${to}`).toBe(true);
  });
  it("rejects illegal transitions", () => {
    expect(canTransition("STARTING", "CONVERSATION")).toBe(false);   // no warmup skip
    expect(canTransition("ANALYZING", "CONVERSATION")).toBe(false);
    expect(canTransition("ANALYZING", "CLOSING")).toBe(false);       // analysis is one-way
    expect(canTransition("COMPLETED", "WARMUP")).toBe(false);
    expect(canTransition("COMPLETED", "ANALYZING")).toBe(false);
    expect(canTransition("FAILED", "WARMUP")).toBe(false);
    expect(canTransition("FAILED", "CLOSING")).toBe(false);
    expect(canTransition("CLOSING", "CONVERSATION")).toBe(false);
  });
});
