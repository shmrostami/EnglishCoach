import { describe, it, expect, beforeEach } from "vitest";
import { eq, and } from "drizzle-orm";
import {
  openDb, db, migrate, ensureSeed, sessions, skills, errorPatterns,
  learningPlans, jobs, jobAttempts, learners,
} from "@ec/db";
import type { DrizzleDb } from "@ec/db";
import { LEARNER_ID } from "@ec/domain";
import { SessionService } from "../src/services/session.js";
import { JobRunner, defaultBackoffMs } from "../src/workers/jobs.js";
import { runAnalysis } from "../src/workers/analysis.js";
import { runPlanner, buildCandidates } from "../src/workers/planner.js";
import { MockAnalysisProvider, type AnalysisProvider } from "@ec/openai";
import { isRecurring } from "@ec/learning-engine";

const NOW = 1_700_000_000_000;

/** Seeds a finished ANALYZING session whose learner utterances hit the mock lexicon 3× for past tense. */
function seedAnalyzableSession(d: DrizzleDb, service: SessionService, sessionId: string): void {
  d.update(sessions).set({ status: "ANALYZING", metrics: JSON.stringify({
    speakingSeconds: 12, userWordCount: 20, wordsPerMinute: 100, pauseCount: 1,
    avgPauseMs: 300, longestPauseMs: 900, utteranceCount: 4, avgUtteranceWords: 5,
  }) }).where(eq(sessions.id, sessionId)).run();
  const turns: { speaker: "learner" | "coach"; text: string; startedAt: number; endedAt: number }[] = [
    { speaker: "coach", text: "Hi, tell me about yesterday.", startedAt: NOW, endedAt: NOW + 2000 },
    { speaker: "learner", text: "Yesterday I go to work by train.", startedAt: NOW + 2100, endedAt: NOW + 4500 },
    { speaker: "coach", text: "And later?", startedAt: NOW + 4600, endedAt: NOW + 5200 },
    { speaker: "learner", text: "Yesterday I go home late at night.", startedAt: NOW + 5300, endedAt: NOW + 7600 },
    { speaker: "learner", text: "Yesterday I go shopping in the evening.", startedAt: NOW + 7900, endedAt: NOW + 9500 },
    { speaker: "learner", text: "I go there since five years, it is my office.", startedAt: NOW + 9800, endedAt: NOW + 12000 },
  ];
  for (const t of turns) {
    service.recordUtterance(sessionId, t);
  }
}

function makeFixture() {
  const sqlite = openDb(":memory:");
  migrate(sqlite);
  ensureSeed(sqlite);
  const d = db(sqlite);
  const service = new SessionService(d);
  const session = service.createSession(LEARNER_ID, NOW);
  service.transition(session.id, "WARMUP", NOW);
  service.transition(session.id, "CONVERSATION", NOW);
  seedAnalyzableSession(d, service, session.id);
  return { sqlite, d, service, sessionId: session.id };
}

describe("JobRunner", () => {
  it("enqueue is idempotent per (session, type)", () => {
    const f = makeFixture();
    const runner = new JobRunner({ db: f.d, handle: async () => {} });
    runner.enqueue("analyze", f.sessionId);
    runner.enqueue("analyze", f.sessionId);
    const rows = f.d.select().from(jobs).where(eq(jobs.type, "analyze")).all();
    expect(rows.filter((r) => r.sessionId === f.sessionId)).toHaveLength(1);
  });

  it("retries with backoff then marks failed after max attempts (Review Focus 1)", async () => {
    const f = makeFixture();
    let calls = 0;
    const runner = new JobRunner({
      db: f.d, pollMs: 1,
      handle: async () => { calls += 1; throw new Error("boom"); },
    });
    runner.enqueue("analyze", f.sessionId);
    const jobId = f.d.select().from(jobs).where(eq(jobs.sessionId, f.sessionId)).all()[0].id;
    for (let i = 0; i < 3; i++) {
      await runner.processOne(jobId);
    }
    const job = f.d.select().from(jobs).where(eq(jobs.id, jobId)).all()[0];
    expect(calls).toBe(3);
    expect(job.status).toBe("failed");
    expect(job.attempts).toBe(3);
    expect(job.error).toContain("boom");
  });

  it("backoff grows exponentially and caps at 30s", () => {
    expect(defaultBackoffMs(1)).toBe(10000);
    expect(defaultBackoffMs(2)).toBe(20000);
    expect(defaultBackoffMs(5)).toBe(30000);
  });

  it("records every attempt with an error class and reports the terminal failure", async () => {
    const f = makeFixture();
    const failed: { jobId: string; class: string; message: string }[] = [];
    const runner = new JobRunner({
      db: f.d, pollMs: 1,
      handle: async () => { throw new Error("upstream rejected"); },
      onFailed: (job, error) => { failed.push({ jobId: job.id, class: error.class, message: error.message }); },
    });
    runner.enqueue("analyze", f.sessionId);
    const jobId = f.d.select().from(jobs).where(eq(jobs.sessionId, f.sessionId)).all()[0].id;
    for (let i = 0; i < 3; i++) await runner.processOne(jobId);

    expect(failed).toHaveLength(1);
    expect(failed[0].class).toBe("provider");
    const attempts = f.d.select().from(jobAttempts).where(eq(jobAttempts.jobId, jobId)).all();
    expect(attempts).toHaveLength(3);
    expect(attempts.map((a) => a.attempt)).toEqual([1, 2, 3]);
    expect(attempts.every((a) => a.status === "failed" && a.errorClass === "provider")).toBe(true);
  });

  it("a terminal analysis failure moves the session out of ANALYZING (spec §5)", async () => {
    const f = makeFixture();
    const runner = new JobRunner({
      db: f.d, pollMs: 1,
      handle: async () => { throw new Error("upstream rejected"); },
      onFailed: (job) => { if (job.type === "analyze" && job.sessionId) f.service.failSession(job.sessionId, NOW + 200000); },
    });
    runner.enqueue("analyze", f.sessionId);
    const jobId = f.d.select().from(jobs).where(eq(jobs.sessionId, f.sessionId)).all()[0].id;
    for (let i = 0; i < 3; i++) await runner.processOne(jobId);

    const job = f.d.select().from(jobs).where(eq(jobs.id, jobId)).all()[0];
    expect(job.status).toBe("failed");
    // The session is not stuck in ANALYZING any more.
    expect(f.d.select().from(sessions).where(eq(sessions.id, f.sessionId)).all()[0].status).toBe("FAILED");
  });

  it("reset re-queues an existing job instead of inserting a duplicate", () => {
    const f = makeFixture();
    const runner = new JobRunner({ db: f.d, handle: async () => {} });
    runner.enqueue("analyze", f.sessionId);
    const jobId = f.d.select().from(jobs).where(eq(jobs.sessionId, f.sessionId)).all()[0].id;
    f.d.update(jobs).set({ status: "failed", attempts: 3, error: "boom" }).where(eq(jobs.id, jobId)).run();

    expect(runner.reset("analyze", f.sessionId)).toBe(true);
    const job = f.d.select().from(jobs).where(eq(jobs.id, jobId)).all()[0];
    expect(job.status).toBe("pending");
    expect(job.attempts).toBe(0);
    expect(job.error).toBeNull();
    expect(f.d.select().from(jobs).where(eq(jobs.sessionId, f.sessionId)).all()).toHaveLength(1);
    expect(runner.reset("analyze", "sess-nope")).toBe(false);
  });
});

describe("runAnalysis (mock provider)", () => {
  let d: DrizzleDb;
  let sessionId: string;

  beforeEach(() => {
    const f = makeFixture();
    d = f.d;
    sessionId = f.sessionId;
  });

  it("persists scores, analysis JSON, skill updates, and a recurring error pattern", async () => {
    await runAnalysis({ db: d, provider: new MockAnalysisProvider(), sessionId, now: NOW + 120000 });
    const session = d.select().from(sessions).where(eq(sessions.id, sessionId)).all()[0];
    expect(session.status).toBe("COMPLETED");
    expect(session.analysis).toBeTruthy();
    expect(session.grammarScore).not.toBe(null);
    expect(session.overallScore!).toBeGreaterThan(0.4);

    const skill = d.select().from(skills).where(and(eq(skills.learnerId, LEARNER_ID), eq(skills.code, "grammar.past_tense"))).all()[0];
    expect(skill).toBeTruthy();
    expect(skill.observationCount).toBe(3);
    expect(skill.mastery).toBeLessThan(0.5); // three errors pull mastery below the 0.5 prior

    const err = d.select().from(errorPatterns)
      .where(and(eq(errorPatterns.learnerId, LEARNER_ID), eq(errorPatterns.skillCode, "grammar.past_tense")))
      .all()[0];
    expect(err.frequency).toBeGreaterThanOrEqual(2);
    expect(isRecurring({
      skill: err.skillCode, pattern: err.pattern, frequency: err.frequency,
      severity: err.severity, mastery: err.mastery, confidence: err.confidence,
      status: err.status as "active" | "mastered", firstSeenAt: err.firstSeenAt, lastSeenAt: err.lastSeenAt,
    })).toBe(true);

    // learner level estimate updated
    const learner = d.select().from(learners).where(eq(learners.id, LEARNER_ID)).all()[0];
    expect(learner.estimatedLevel).toBeTruthy();
    expect(learner.estimatedLevelConfidence).toBeGreaterThan(0);
  });

  it("is idempotent: a second run changes nothing (Review Focus 3/worker idempotency)", async () => {
    await runAnalysis({ db: d, provider: new MockAnalysisProvider(), sessionId, now: NOW + 120000 });
    const snapshot = d.select().from(skills).all();
    await runAnalysis({ db: d, provider: new MockAnalysisProvider(), sessionId, now: NOW + 121000 });
    const after = d.select().from(skills).all();
    expect(after).toEqual(snapshot);
  });

  it("invalid provider output fails the job without touching learner state (Review Focus 1)", async () => {
    const bad: AnalysisProvider = {
      capabilities: { pronunciationEvidence: false },
      analyze: async () => { throw new Error("upstream rejected: expected object, got string"); },
      plan: async () => { throw new Error("unused"); },
    };
    const before = d.select().from(skills).all();
    await expect(runAnalysis({ db: d, provider: bad, sessionId, now: NOW + 120000 }))
      .rejects.toThrow(/upstream rejected/);
    expect(d.select().from(skills).all()).toEqual(before);
    expect(d.select().from(sessions).where(eq(sessions.id, sessionId)).all()[0].status).toBe("ANALYZING");
  });

  it("stores pronunciation as null when the provider has no audio evidence (spec §12.1)", async () => {
    await runAnalysis({ db: d, provider: new MockAnalysisProvider(), sessionId, now: NOW + 120000 });
    const session = d.select().from(sessions).where(eq(sessions.id, sessionId)).all()[0];
    expect(session.pronunciationScore).toBeNull();
    const stored = JSON.parse(session.analysis!) as import("@ec/domain").SessionAnalysis;
    expect(stored.scores.pronunciation).toBeNull();
  });

  it("keeps a pronunciation score only when the provider declares audio evidence", async () => {
    const grounded: AnalysisProvider = {
      capabilities: { pronunciationEvidence: true },
      analyze: async () => ({
        scores: {
          fluency: 0.7, grammar: 0.6, vocabulary: 0.8, pronunciation: 0.65,
          coherence: 0.7, interaction: 0.8,
        },
        observations: [],
        recurring_errors: [], strengths: [], recommended_targets: [],
      }),
      plan: async () => { throw new Error("unused"); },
    };
    await runAnalysis({ db: d, provider: grounded, sessionId, now: NOW + 120000 });
    const session = d.select().from(sessions).where(eq(sessions.id, sessionId)).all()[0];
    expect(session.pronunciationScore).toBe(0.65);
  });

  it("strips a pronunciation number from a provider that cannot ground it", async () => {
    // The provider LLM returned a number; without audio evidence the worker
    // strips it (spec §3 principle 7: no fabricated measurement).
    const ungrounded: AnalysisProvider = {
      capabilities: { pronunciationEvidence: false },
      analyze: async () => ({
        scores: {
          fluency: 0.7, grammar: 0.6, vocabulary: 0.8, pronunciation: 0.78,
          coherence: 0.7, interaction: 0.8,
        },
        observations: [],
        recurring_errors: [], strengths: [], recommended_targets: [],
      }),
      plan: async () => { throw new Error("unused"); },
    };
    await runAnalysis({ db: d, provider: ungrounded, sessionId, now: NOW + 120000 });
    const session = d.select().from(sessions).where(eq(sessions.id, sessionId)).all()[0];
    expect(session.pronunciationScore).toBeNull();
    const stored = JSON.parse(session.analysis!) as import("@ec/domain").SessionAnalysis;
    expect(stored.scores.pronunciation).toBeNull();
  });
});

describe("runPlanner", () => {
  let d: DrizzleDb;
  let sessionId: string;

  async function analyzed(): Promise<void> {
    await runAnalysis({ db: d, provider: new MockAnalysisProvider(), sessionId, now: NOW + 120000 });
  }

  beforeEach(async () => {
    const f = makeFixture();
    d = f.d;
    sessionId = f.sessionId;
    await analyzed();
  });

  it("creates a plan targeting the recurring weakness with adjusted difficulty", async () => {
    await runPlanner({ db: d, provider: new MockAnalysisProvider(), sessionId, now: NOW + 121000 });
    const plan = d.select().from(learningPlans)
      .where(and(eq(learningPlans.learnerId, LEARNER_ID), eq(learningPlans.status, "active"))).all()[0];
    expect(plan).toBeTruthy();
    const primary = JSON.parse(plan.primaryTargets) as string[];
    expect(primary[0]).toBe("grammar.past_tense");
    expect(primary.length).toBeLessThanOrEqual(2);
    expect(plan.difficulty).toBeGreaterThanOrEqual(0.15);
    expect(plan.difficulty).toBeLessThanOrEqual(0.95);
    expect(plan.topic).toBeTruthy();
  });

  it("is idempotent: re-running does not create a second active plan", async () => {
    await runPlanner({ db: d, provider: new MockAnalysisProvider(), sessionId, now: NOW + 121000 });
    await runPlanner({ db: d, provider: new MockAnalysisProvider(), sessionId, now: NOW + 122000 });
    const active = d.select().from(learningPlans)
      .where(and(eq(learningPlans.learnerId, LEARNER_ID), eq(learningPlans.status, "active"))).all();
    expect(active).toHaveLength(1);
  });

  it("buildCandidates applies no-history defaults to engine-unknown skills", () => {
    const analysis = d.select().from(sessions).where(eq(sessions.id, sessionId)).all()[0];
    const parsed = JSON.parse(analysis.analysis!) as import("@ec/domain").SessionAnalysis;
    const candidates = buildCandidates(d, LEARNER_ID, parsed, ["fluency", "grammar", "vocabulary"], NOW + 121000);
    const unknown = candidates.find((c) => c.skill === "discourse.argumentation");
    if (unknown) {
      expect(unknown.recurrence).toBe(0);
      expect(unknown.severity).toBe(0.4);
    }
    expect(candidates.some((c) => c.skill === "grammar.past_tense")).toBe(true);
  });

  it("adapts difficulty to the NEWEST five completed sessions, not the oldest", async () => {
    // Seven completed sessions: the two oldest are far below the newest five,
    // so a planner that reads the oldest five drops the difficulty while a
    // planner that reads the newest five raises it.
    const f = makeFixture();
    const dd = f.d;
    const svc = f.service;
    // Oldest two: very low scores.
    for (let i = 0; i < 2; i++) {
      const s = svc.createSession(LEARNER_ID, NOW - (10 - i) * 86_400_000);
      dd.update(sessions).set({ status: "COMPLETED", startedAt: NOW - (10 - i) * 86_400_000, overallScore: 0.1 }).where(eq(sessions.id, s.id)).run();
    }
    // Newest five: high scores.
    for (let i = 0; i < 5; i++) {
      const s = svc.createSession(LEARNER_ID, NOW - (5 - i) * 86_400_000);
      dd.update(sessions).set({ status: "COMPLETED", startedAt: NOW - (5 - i) * 86_400_000, overallScore: 0.9 }).where(eq(sessions.id, s.id)).run();
    }
    // The session under test: planned difficulty 0.5.
    const target = svc.createSession(LEARNER_ID, NOW);
    dd.update(sessions).set({ status: "ANALYZING", analysis: JSON.stringify({
      scores: { fluency: 0.7, grammar: 0.6, vocabulary: 0.8, pronunciation: null, coherence: 0.7, interaction: 0.8 },
      observations: [], recurring_errors: [], strengths: [], recommended_targets: [],
    }) }).where(eq(sessions.id, target.id)).run();

    await runPlanner({ db: dd, provider: new MockAnalysisProvider(), sessionId: target.id, now: NOW + 121000 });
    const plan = dd.select().from(learningPlans)
      .where(and(eq(learningPlans.learnerId, LEARNER_ID), eq(learningPlans.status, "active"))).all()[0];
    // recentPerformance over the newest five = 0.9 → difficulty goes UP.
    expect(plan.difficulty).toBeGreaterThan(0.5);
  });
});
