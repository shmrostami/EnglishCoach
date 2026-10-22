import { describe, it, expect, beforeEach } from "vitest";
import { openDb, db, migrate, ensureSeed, errorPatterns, learningObjectives, learners } from "@ec/db";
import type { DrizzleDb } from "@ec/db";
import { runReadTool, buildToolMessages, READ_TOOLS } from "./llm-tools.js";
import type { LearnerContext } from "@ec/domain";

const LEARNER = "learner-1";
const NOW = 1_700_000_000_000;

const CONTEXT: LearnerContext = {
  level: "B1",
  goals: ["Speak continuously for 5 minutes"],
  strengths: ["vocabulary.precision"],
  activeWeaknesses: ["grammar.past_tense"],
  vocabularyTargets: ["negotiate"],
  difficulty: 0.5,
  correctionStyle: "moderate",
  recentTopics: ["weekends"],
  currentSessionTargets: ["grammar.past_tense"],
};

let d: DrizzleDb;

beforeEach(() => {
  const sqlite = openDb(":memory:");
  migrate(sqlite);
  ensureSeed(sqlite);
  d = db(sqlite);
});

function ctx() {
  return { db: d, learnerId: LEARNER, learnerContext: CONTEXT };
}

describe("runReadTool", () => {
  it("reads the learner's context", () => {
    const out = runReadTool(ctx(), "get_learner_context") as Record<string, unknown>;
    expect(out.level).toBe("B1");
    expect(out.activeWeaknesses).toEqual(["grammar.past_tense"]);
    expect(out.currentTargets).toEqual(["grammar.past_tense"]);
  });

  it("reads the recurring errors, most frequent first", () => {
    d.insert(errorPatterns).values([
      { id: "e1", learnerId: LEARNER, skillCode: "grammar.past_tense", pattern: "past", frequency: 5, severity: 0.6, confidence: 0.9, status: "active", firstSeenAt: NOW, lastSeenAt: NOW },
      { id: "e2", learnerId: LEARNER, skillCode: "grammar.articles", pattern: "art", frequency: 2, severity: 0.3, confidence: 0.8, status: "active", firstSeenAt: NOW, lastSeenAt: NOW },
    ]).run();
    const out = runReadTool(ctx(), "get_recurring_errors") as { skill: string }[];
    // Only patterns seen at least twice, most frequent first.
    expect(out.map((e) => e.skill)).toEqual(["grammar.past_tense", "grammar.articles"]);
  });

  it("reads the active objectives", () => {
    d.insert(learningObjectives).values([
      { id: "o1", learnerId: LEARNER, title: "Past tense under pressure", description: "d", skillCodes: '["grammar.past_tense"]', priority: 0.8, status: "active", createdAt: NOW, updatedAt: NOW },
      { id: "o2", learnerId: LEARNER, title: "Done", description: "d", skillCodes: "[]", priority: 0.5, status: "achieved", createdAt: NOW, updatedAt: NOW },
    ]).run();
    const out = runReadTool(ctx(), "get_active_learning_objectives") as { title: string }[];
    expect(out.map((o) => o.title)).toEqual(["Past tense under pressure"]);
  });

  it("reads nothing due when there is no vocabulary state", () => {
    expect(runReadTool(ctx(), "get_due_reviews")).toEqual([]);
  });

  it("throws on an unknown tool rather than inventing a result", () => {
    expect(() => runReadTool(ctx(), "delete_everything")).toThrow();
  });

  it("never returns another learner's data", () => {
    // The learner id comes from the caller, never from the model, so a tool
    // call cannot ask for someone else's state. A second learner exists with
    // a frequent error that must NOT appear in learner-1's results.
    d.insert(learners).values({
      id: "learner-2", nativeLanguage: "fa", targetLanguage: "en",
      createdAt: NOW, updatedAt: NOW,
    }).run();
    d.insert(errorPatterns).values({
      id: "e-other", learnerId: "learner-2", skillCode: "grammar.past_tense", pattern: "p",
      frequency: 9, severity: 0.9, confidence: 0.9, status: "active", firstSeenAt: NOW, lastSeenAt: NOW,
    }).run();
    const out = runReadTool(ctx(), "get_recurring_errors") as { skill: string }[];
    expect(out).toEqual([]);
  });
});

describe("buildToolMessages", () => {
  it("offers every read tool", () => {
    const { tools } = buildToolMessages(ctx());
    expect(tools.map((t) => t.function.name)).toEqual(READ_TOOLS.map((t) => t.name));
  });

  it("grounds the model with the real state and the valid skill codes", () => {
    const { context } = buildToolMessages(ctx());
    expect(context).toContain("grammar.past_tense");
    expect(context).toContain("Speak continuously for 5 minutes");
    expect(context).toContain("vocabulary.breadth");
  });
});
