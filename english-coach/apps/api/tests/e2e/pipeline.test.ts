import { describe, it, expect, beforeEach } from "vitest";
import { eq, and } from "drizzle-orm";
import {
  openDb, db, migrate, ensureSeed, sessions, skills, errorPatterns,
  learningPlans, jobs, correctedSentences,
} from "@ec/db";
import type { DrizzleDb } from "@ec/db";
import { LEARNER_ID } from "@ec/domain";
import { MockSpeechProvider, MockAnalysisProvider, type MockTurn } from "@ec/openai";
import { SessionService } from "../../src/services/session.js";
import { RealtimeBridge } from "../../src/realtime/bridge.js";
import { JobRunner } from "../../src/workers/jobs.js";
import { runAnalysis } from "../../src/workers/analysis.js";
import { runPlanner } from "../../src/workers/planner.js";

const NOW = 1_700_000_000_000;

/** A 3-turn session: the learner makes the same past-tense error three times. */
const SCRIPT: MockTurn[] = [
  { speaker: "coach", text: "Hi! Tell me about yesterday.", pauseMs: 25 },
  { speaker: "learner", text: "Yesterday I go to work by train.", pauseMs: 25 },
  { speaker: "coach", text: "And what did you do after work?", pauseMs: 25 },
  { speaker: "learner", text: "Yesterday I go home and I eat dinner.", pauseMs: 25 },
  { speaker: "coach", text: "Was it a good dinner?", pauseMs: 25 },
  { speaker: "learner", text: "Yesterday I go to a restaurant with my friend.", pauseMs: 25,
    toolCall: { name: "request_micro_coaching", skill: "grammar.past_tense", reason: "recurring present-form-after-past-time" } },
];

function fakeClient() {
  const sent: any[] = [];
  return {
    sent,
    send: (m: string) => sent.push(JSON.parse(m)),
    readyState: 1,
    on: () => {}, // bridge attaches close/message listeners; no-op in the fake
    close: () => {}, // bridge.close() / destroy() call this; no-op in the fake
  };
}

describe("full pipeline (mock provider, spec 11.3)", () => {
  let d: DrizzleDb;
  let service: SessionService;
  let runner: JobRunner;

  beforeEach(() => {
    const sqlite = openDb(":memory:");
    migrate(sqlite);
    ensureSeed(sqlite);
    d = db(sqlite);
    service = new SessionService(d);
    runner = new JobRunner({
      db: d, pollMs: 5,
      handle: async (job) => {
        if (!job.sessionId) return;
        if (job.type === "analyze") {
          await runAnalysis({ db: d, provider: new MockAnalysisProvider(), sessionId: job.sessionId, now: Date.now() });
        } else {
          await runPlanner({ db: d, provider: new MockAnalysisProvider(), sessionId: job.sessionId, now: Date.now() });
        }
      },
    });
  });

  it("session → utterances → analysis → memory → next plan, and the next session reflects it", async () => {
    const s = service.createSession(LEARNER_ID, NOW);

    // live session. autoClose:false because the CLIENT ends this session
    // (via endSession below), not the scripted provider — the default autoClose
    // would fire a `closed` event ~200ms in and the bridge would mark it FAILED.
    const bridge = new RealtimeBridge({
      sessionId: s.id,
      provider: new MockSpeechProvider({ turns: SCRIPT, autoClose: false }),
      service,
      learnerContext: service.getLearnerContext(s.id),
      difficulty: 0.5,
      warmupMs: 5,
      sessionTargetMs: 600_000,
      onEnded: () => runner.enqueue("analyze", s.id),
    });
    bridge.attach(fakeClient() as never);
    await new Promise((r) => setTimeout(r, 500));
    bridge.destroy("e2e");

    // end + persist. In production the WS client's "end" control message
    // triggers bridge.onEnded → enqueue; destroy() is a test-only teardown,
    // so we enqueue the same way the HTTP /end route would.
    const end = service.endSession(s.id, NOW + 120_000);
    expect(end.ok).toBe(true);
    runner.enqueue("analyze", s.id);

    // run the queued jobs in order (runner.poll would too; processOne is deterministic)
    const analyzeJob = d.select().from(jobs)
      .where(and(eq(jobs.type, "analyze"), eq(jobs.sessionId, s.id))).all()[0];
    await runner.processOne(analyzeJob.id);

    const planJob = d.select().from(jobs)
      .where(and(eq(jobs.type, "plan_next"), eq(jobs.sessionId, s.id))).all()[0];
    expect(planJob).toBeTruthy();
    await runner.processOne(planJob.id);

    // assertions: memory changed
    const skill = d.select().from(skills).where(
      and(eq(skills.learnerId, LEARNER_ID), eq(skills.code, "grammar.past_tense")),
    ).all()[0];
    expect(skill.observationCount).toBe(3);
    expect(skill.mastery).toBeLessThan(0.5);

    const err = d.select().from(errorPatterns).where(
      and(eq(errorPatterns.learnerId, LEARNER_ID), eq(errorPatterns.skillCode, "grammar.past_tense")),
    ).all()[0];
    expect(err.frequency).toBe(3);
    expect(err.confidence).toBeGreaterThanOrEqual(0.9);

    // assertions: next session reflects the evidence (spec 11.3 exit criterion)
    const plan = d.select().from(learningPlans).where(
      and(eq(learningPlans.learnerId, LEARNER_ID), eq(learningPlans.status, "active")),
    ).all()[0];
    const primary = JSON.parse(plan.primaryTargets) as string[];
    expect(primary[0]).toBe("grammar.past_tense");

    const next = service.createSession(LEARNER_ID, NOW + 3_600_000);
    expect(next.difficulty).toBeCloseTo(plan.difficulty, 2);
    const ctx = service.getLearnerContext(next.id);
    expect(ctx.currentSessionTargets[0]).toBe("grammar.past_tense");
    expect(ctx.activeWeaknesses).toContain("grammar.past_tense");
    expect(ctx.recentTopics).toContain(s.topic);

    const sessionRow = d.select().from(sessions).where(eq(sessions.id, s.id)).all()[0];
    expect(sessionRow.status).toBe("COMPLETED");

    // Feedback is persisted, not only computed on read (spec §11.3).
    const corrections = d.select().from(correctedSentences)
      .where(eq(correctedSentences.sessionId, s.id)).all();
    expect(corrections.length).toBeGreaterThan(0);
    expect(corrections[0].suggested).toContain("went");
    expect(corrections[0].learnerAction).toBe("pending");

    // A re-run of the same analysis must not duplicate them (spec §3 principle 6).
    await runAnalysis({ db: d, provider: new MockAnalysisProvider(), sessionId: s.id, now: Date.now() });
    expect(d.select().from(correctedSentences)
      .where(eq(correctedSentences.sessionId, s.id)).all()).toHaveLength(corrections.length);
  }, 15_000);
});
