import { describe, it, expect } from "vitest";
import { MockSpeechProvider } from "./speech.js";
import { MockAnalysisProvider } from "./analysis.js";
import { SessionAnalysisSchema } from "@ec/domain";
import type { TranscriptTurn, ProviderEvent } from "../providers/types.js";

describe("MockSpeechProvider", () => {
  it("emits connected, then the scripted turns in order, with tool calls", async () => {
    const seen: string[] = [];
    const provider = new MockSpeechProvider({
      turns: [
        { speaker: "coach", text: "Hi! How was your week?", pauseMs: 40 },
        { speaker: "learner", text: "Yesterday I go to work by train.", pauseMs: 40 },
        { speaker: "coach", text: "Almost — try that again with 'went'.", pauseMs: 40 },
        { speaker: "learner", text: "Yesterday I went to work by train.", pauseMs: 40, toolCall: { name: "request_target_retry", skill: "grammar.past_tense" } },
      ],
    });
    await provider.connect((e) => {
      if (e.t === "connected") seen.push("connected");
      if (e.t === "transcript") seen.push(`${e.turn.speaker}:${e.turn.text.slice(0, 12)}`);
      if (e.t === "tool_call") seen.push(`tool:${e.name}:${e.skill}`);
      if (e.t === "closed") seen.push(`closed:${e.reason}`);
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(seen[0]).toBe("connected");
    expect(seen.filter((s) => s.startsWith("learner:"))).toHaveLength(2);
    expect(seen).toContain("tool:request_target_retry:grammar.past_tense");
    expect(seen[seen.length - 1]).toMatch(/^closed:/);
    provider.close();
  });
});

describe("MockAnalysisProvider", () => {
  const transcript: TranscriptTurn[] = [
    { speaker: "learner", text: "Yesterday I go to work by train.", startedAt: 1000, endedAt: 3000 },
    { speaker: "coach", text: "Tell me about it.", startedAt: 3100, endedAt: 3600 },
    { speaker: "learner", text: "Yesterday I go home late at night.", startedAt: 3700, endedAt: 4500 },
    { speaker: "coach", text: "Good story.", startedAt: 4600, endedAt: 5000 },
    { speaker: "learner", text: "Yesterday I go shopping in the evening.", startedAt: 5100, endedAt: 6000 },
    { speaker: "learner", text: "I go there since five years.", startedAt: 6100, endedAt: 7000 },
  ];

  it("returns schema-valid analysis flagging the recurring past-tense pattern", async () => {
    const analysis = await new MockAnalysisProvider().analyze({
      learnerId: "learner-1",
      transcript,
      metrics: {
        speakingSeconds: 12, userWordCount: 18, wordsPerMinute: 90,
        pauseCount: 1, avgPauseMs: 200, longestPauseMs: 200,
        utteranceCount: 3, avgUtteranceWords: 6, rmsEnergyAvg: 0.2,
      },
      learnerContext: {
        level: "B1+", goals: ["fluency"], strengths: [], activeWeaknesses: [],
        vocabularyTargets: [], difficulty: 0.6, correctionStyle: "moderate",
        recentTopics: [], currentSessionTargets: ["grammar.past_tense"],
      },
      sessionTargets: ["grammar.past_tense"],
    });
    const parsed = SessionAnalysisSchema.parse(analysis); // must not throw
    const pastTense = parsed.observations.filter((o) => o.skill === "grammar.past_tense");
    expect(pastTense.length).toBeGreaterThanOrEqual(3);
    expect(parsed.recurring_errors.some((r) => r.skill === "grammar.past_tense")).toBe(true);
  });
});

describe("MockAnalysisProvider.plan", () => {
  it("returns a plan draft with ranked candidates and a difficulty-appropriate topic", async () => {
    const ctx = {
      level: "B1+", goals: ["grammar"], strengths: [], activeWeaknesses: ["grammar.past_tense"],
      vocabularyTargets: [], difficulty: 0.75, correctionStyle: "moderate",
      recentTopics: ["Your last vacation"], currentSessionTargets: ["grammar.past_tense"],
    };
    const draft = await new MockAnalysisProvider().plan({
      difficulty: 0.75,
      candidates: ["grammar.past_tense", "vocabulary.precision"],
      learnerContext: ctx,
    });
    expect(draft.topic.length).toBeGreaterThan(5);
    expect(draft.topic).not.toBe("Your last vacation");
    expect(draft.candidateSkills[0]).toBe("grammar.past_tense");
  });
});
