import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  LocalAnalysisProvider, evidenceIsGrounded, repairAnalysis, parseJsonLoose,
} from "./analysis.js";
import type { AnalysisInput } from "../providers/types.js";

const METRICS = {
  speakingSeconds: 30, userWordCount: 40, wordsPerMinute: 80, pauseCount: 2,
  avgPauseMs: 400, longestPauseMs: 900, utteranceCount: 4, avgUtteranceWords: 10,
};

const CONTEXT = {
  level: "B1", goals: [], strengths: [], activeWeaknesses: [],
  vocabularyTargets: [], difficulty: 0.5, correctionStyle: "moderate",
  recentTopics: [], currentSessionTargets: [],
};

function input(transcript: AnalysisInput["transcript"]): AnalysisInput {
  return {
    learnerId: "learner-1", transcript, metrics: METRICS,
    learnerContext: CONTEXT, sessionTargets: [],
  };
}

/** A stub OpenAI-compatible endpoint that answers with a canned completion. */
function stubLLM(reply: () => unknown): { server: Server; url: Promise<string>; calls: unknown[] } {
  const calls: unknown[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      calls.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: JSON.stringify(reply()) } }],
      }));
    });
  });
  const url = new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
    });
  });
  return { server, url, calls };
}

let stub: ReturnType<typeof stubLLM>;
let baseURL: string;

const GOOD = {
  scores: { fluency: 0.7, grammar: 0.5, vocabulary: 0.7, pronunciation: 0.9, coherence: 0.6, interaction: 0.8 },
  observations: [
    { type: "language_error", skill: "grammar.past_tense", evidence: "Yesterday I go to work",
      actual: "go", expected: "went", severity: 0.6, confidence: 0.9 },
  ],
  recurring_errors: [],
  strengths: [],
  recommended_targets: ["grammar.past_tense"],
};

beforeAll(async () => {
  stub = stubLLM(() => GOOD);
  baseURL = await stub.url;
});

afterAll(() => { stub.server.close(); });

describe("LocalAnalysisProvider", () => {
  it("scores from the local model rather than returning fixed mock numbers", async () => {
    const p = new LocalAnalysisProvider({ baseURL, model: "test" });
    const out = await p.analyze(input([{ speaker: "learner", text: "Yesterday I go to work", startedAt: 0, endedAt: 1 }]));
    expect(out.scores.grammar).toBe(0.5);
    expect(out.observations).toHaveLength(1);
  });

  it("never reports a pronunciation score, whatever the model claims", async () => {
    const p = new LocalAnalysisProvider({ baseURL, model: "test" });
    const out = await p.analyze(input([{ speaker: "learner", text: "Yesterday I go to work", startedAt: 0, endedAt: 1 }]));
    // The stub returned 0.9. A text model has no acoustic evidence (§12.1).
    expect(out.scores.pronunciation).toBeNull();
    expect(p.capabilities.pronunciationEvidence).toBe(false);
  });

  it("drops an observation whose quote is not in the learner's own words", async () => {
    const invented = {
      ...GOOD,
      observations: [
        { type: "language_error", skill: "grammar.articles", evidence: "I went to the shops", confidence: 0.9, severity: 0.5 },
      ],
    };
    const s = stubLLM(() => invented);
    try {
      const p = new LocalAnalysisProvider({ baseURL: await s.url, model: "test" });
      const out = await p.analyze(input([{ speaker: "learner", text: "Yesterday I go to work", startedAt: 0, endedAt: 1 }]));
      // Never scored on a sentence the learner did not say.
      expect(out.observations).toHaveLength(0);
    } finally {
      s.server.close();
    }
  });

  it("keeps an observation grounded in learner speech even when the coach said the same thing", async () => {
    const p = new LocalAnalysisProvider({ baseURL, model: "test" });
    const out = await p.analyze(input([
      { speaker: "coach", text: "Yesterday I go to work", startedAt: 0, endedAt: 1 },
      { speaker: "learner", text: "Yesterday I go to work", startedAt: 2, endedAt: 3 },
    ]));
    expect(out.observations).toHaveLength(1);
  });

  it("asks the model for JSON and names the transcript", async () => {
    const p = new LocalAnalysisProvider({ baseURL, model: "test" });
    stub.calls.length = 0;
    await p.analyze(input([{ speaker: "learner", text: "Yesterday I go to work", startedAt: 0, endedAt: 1 }]));
    const call = stub.calls[0] as { messages: { content: string }[] };
    expect(call.messages[0].content).toContain("Yesterday I go to work");
    expect(call.messages[0].content).toContain("Do NOT score pronunciation");
    expect(call.messages[1].content).toContain("JSON");
  });

  it("plans through the same endpoint", async () => {
    const s = stubLLM(() => ({ topic: "A difficult decision", candidateSkills: ["grammar.past_tense"], reason: "top-ranked" }));
    try {
      const p = new LocalAnalysisProvider({ baseURL: await s.url, model: "test" });
      const draft = await p.plan({ difficulty: 0.5, candidates: ["grammar.past_tense"], learnerContext: CONTEXT });
      expect(draft.topic).toBe("A difficult decision");
    } finally {
      s.server.close();
    }
  });

  it("surfaces a malformed reply instead of inventing an analysis", async () => {
    const s = stubLLM(() => "not an object");
    try {
      const p = new LocalAnalysisProvider({ baseURL: await s.url, model: "test" });
      await expect(p.analyze(input([{ speaker: "learner", text: "x", startedAt: 0, endedAt: 1 }])))
        .rejects.toThrow();
    } finally {
      s.server.close();
    }
  });
});

describe("evidenceIsGrounded", () => {
  const learner = (text: string) => ({ speaker: "learner" as const, text });

  it("matches despite case and whitespace differences", () => {
    expect(evidenceIsGrounded("yesterday   I GO to work", [learner("Yesterday I go to work.")])).toBe(true);
  });

  it("rejects a quote that appears only in the coach's turn", () => {
    expect(evidenceIsGrounded("Nice work", [
      { speaker: "coach", text: "Nice work" },
      learner("thanks"),
    ])).toBe(false);
  });

  it("matches a quote whose typography differs from the transcript", () => {
    // A model may return curly quotes and an en dash for a straight quote and
    // a hyphen. Same sentence, so it must still count as grounded.
    expect(evidenceIsGrounded("Yesterday I go to work", [learner("Yesterday I go to work.")])).toBe(true);
    expect(evidenceIsGrounded("it’s fine", [learner("it's fine")])).toBe(true);
    expect(evidenceIsGrounded("well-known", [learner("well known")])).toBe(false);
  });

  it("rejects an empty quote", () => {
    expect(evidenceIsGrounded("   ", [learner("anything")])).toBe(false);
  });

  it("rejects an invented sentence", () => {
    expect(evidenceIsGrounded("I have been to Paris", [learner("Yesterday I go to work")])).toBe(false);
  });
});

describe("repairAnalysis", () => {
  it("takes the first real member of a pipe-separated enum the model copied", () => {
    const out = repairAnalysis({
      observations: [{ type: "language_error|strength|vocabulary_use|fluency_signal", skill: "grammar.past_tense", evidence: "x", confidence: 0.5 }],
    }) as { observations: { type: string }[] };
    expect(out.observations[0].type).toBe("language_error");
  });

  it("turns numeric strings into numbers", () => {
    const out = repairAnalysis({
      scores: { fluency: "0.7", grammar: 0.5, vocabulary: 0.6, pronunciation: "0.9", coherence: 0.5, interaction: 0.5 },
      observations: [{ type: "language_error", skill: "grammar.past_tense", evidence: "x", confidence: "0.8" }],
    }) as { scores: Record<string, number | null>; observations: { confidence: number }[] };
    expect(out.scores.fluency).toBe(0.7);
    expect(out.scores.pronunciation).toBe(0.9);
    expect(out.observations[0].confidence).toBe(0.8);
  });

  it("defaults a missing pronunciation score to null rather than leaving it undefined", () => {
    const out = repairAnalysis({
      scores: { fluency: 0.7, grammar: 0.5, vocabulary: 0.6, coherence: 0.5, interaction: 0.5 },
    }) as { scores: Record<string, number | null> };
    expect(out.scores.pronunciation).toBeNull();
  });

  it("drops an observation about a skill code that does not exist", () => {
    const out = repairAnalysis({
      observations: [
        { type: "language_error", skill: "grammar.telepathy", evidence: "x", confidence: 0.5 },
        { type: "language_error", skill: "grammar.past_tense", evidence: "x", confidence: 0.5 },
      ],
    }) as { observations: { skill: string }[] };
    expect(out.observations).toHaveLength(1);
    expect(out.observations[0].skill).toBe("grammar.past_tense");
  });

  it("drops an invented recommended target", () => {
    const out = repairAnalysis({ recommended_targets: ["grammar.past_tense", "grammar.telepathy"] }) as { recommended_targets: string[] };
    expect(out.recommended_targets).toEqual(["grammar.past_tense"]);
  });

  it("caps a self-reported confidence of 1 at 0.95", () => {
    const out = repairAnalysis({
      observations: [{ type: "language_error", skill: "grammar.past_tense", evidence: "x", confidence: 1 }],
    }) as { observations: { confidence: number }[] };
    expect(out.observations[0].confidence).toBe(0.95);
  });
});

describe("parseJsonLoose", () => {
  it("extracts an object from a fenced reply", () => {
    const fenced = "```json\n" + '{"a": 1}' + "\n```";
    const out = parseJsonLoose(fenced) as { a: number };
    expect(out.a).toBe(1);
  });

  it("salvages a reply that was truncated mid-object", () => {
    const truncated = '{"scores": {"fluency": 0.7}, "observations": [{"type": "language_error", "skill": "grammar.past_tense"';
    const out = parseJsonLoose(truncated) as { scores: { fluency: number } };
    expect(out.scores.fluency).toBe(0.7);
  });

  it("throws when there is no object at all", () => {
    expect(() => parseJsonLoose("I am sorry, I cannot help with that.")).toThrow();
  });
});
