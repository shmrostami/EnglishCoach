import { describe, it, expect } from "vitest";
import { initialTranscript, applyTranscript } from "./transcript.js";

describe("transcript reducer", () => {
  it("appends in seq order even if delivered out of order", () => {
    let s = initialTranscript();
    s = applyTranscript(s, { t: "transcript", seq: 2, speaker: "coach", text: "second" });
    s = applyTranscript(s, { t: "transcript", seq: 1, speaker: "learner", text: "first" });
    expect(s.turns.map((t) => t.text)).toEqual(["first", "second"]);
  });

  it("ignores duplicate seqs (reconnect replay)", () => {
    let s = initialTranscript();
    s = applyTranscript(s, { t: "transcript", seq: 1, speaker: "learner", text: "a" });
    const again = applyTranscript(s, { t: "transcript", seq: 1, speaker: "learner", text: "a" });
    expect(again.turns).toHaveLength(1);
  });
});
