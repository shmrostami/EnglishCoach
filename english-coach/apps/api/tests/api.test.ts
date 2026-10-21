import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { WebSocket } from "ws";
import { buildApp } from "../src/app.js";
import { openDb, db, migrate, ensureSeed } from "@ec/db";
import { SessionService } from "../src/services/session.js";
import { BridgeRegistry, RealtimeBridge } from "../src/realtime/bridge.js";
import { JobRunner } from "../src/workers/jobs.js";
import { MockSpeechProvider, type MockTurn, selectSpeechProvider, MOCK_DEMO_SCRIPT } from "@ec/openai";
import { LEARNER_ID } from "@ec/domain";

const SCRIPT: MockTurn[] = [
  { speaker: "coach", text: "Hello there?", pauseMs: 30 },
  { speaker: "learner", text: "Yesterday I go to the market.", pauseMs: 30 },
  { speaker: "coach", text: "Good.", pauseMs: 30 },
];

let app: Awaited<ReturnType<typeof buildApp>>;
let url: string;
let endedSessions: string[] = [];
let sqlite: Database.Database;
let service: SessionService;
let registry: BridgeRegistry;

beforeAll(async () => {
  sqlite = openDb(":memory:");
  migrate(sqlite);
  ensureSeed(sqlite);
  service = new SessionService(db(sqlite));
  registry = new BridgeRegistry();
  // A real JobRunner (never started, so it never polls) gives the retry route
  // the same DB semantics the server has.
  const runner = new JobRunner({ db: db(sqlite), handle: async () => {} });
  app = await buildApp({
    service,
    db: db(sqlite),
    registry,
    selectSpeech: () => new MockSpeechProvider({ turns: SCRIPT, autoClose: false }),
    env: { PORT: 0, HOST: "127.0.0.1", DB_PATH: ":memory:", PROVIDER: "mock", WARMUP_MS: 50, SESSION_TARGET_MS: 60_000, OPENAI_API_KEY: undefined },
    queue: (type, sessionId) => {
      if (type === "analyze") endedSessions.push(sessionId);
      runner.enqueue(type, sessionId);
    },
    retry: (type, sessionId) => runner.reset(type, sessionId),
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
});

afterAll(async () => { await app.close(); });

/**
 * Wait for a condition instead of a fixed number of milliseconds — the mock
 * provider plays its script on timers, so a hardcoded wait could land before
 * the script had finished under load.
 */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("HTTP API", () => {
  it("creates a session and rejects unknown learner ids", async () => {
    const ok = await app.inject({ method: "POST", url: `/v1/learners/${LEARNER_ID}/sessions` });
    expect(ok.statusCode).toBe(201);
    expect((ok.json() as { sessionId: string }).sessionId).toMatch(/^sess-/);
    const bad = await app.inject({ method: "POST", url: "/v1/learners/nobody/sessions" });
    expect(bad.statusCode).toBe(404);
  });

  it("ends a session exactly once: second end is 409 (Review Focus 3)", async () => {
    const created = (await app.inject({ method: "POST", url: `/v1/learners/${LEARNER_ID}/sessions` })).json() as { sessionId: string };
    const first = await app.inject({ method: "POST", url: `/v1/sessions/${created.sessionId}/end` });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "POST", url: `/v1/sessions/${created.sessionId}/end` });
    expect(second.statusCode).toBe(409);
    expect(endedSessions.filter((s) => s === created.sessionId)).toHaveLength(1);
  });

  it("tears the live provider down when the session ends over HTTP", async () => {
    const created = (await app.inject({ method: "POST", url: `/v1/learners/${LEARNER_ID}/sessions` })).json() as { sessionId: string };
    let closeCalls = 0;
    const provider = {
      connect: async () => {},
      sendAudio: () => {},
      sendInstruction: () => {},
      close: () => { closeCalls += 1; },
    };
    const bridge = new RealtimeBridge({
      sessionId: created.sessionId, provider, service,
      learnerContext: service.getLearnerContext(created.sessionId),
      difficulty: 0.5, warmupMs: 999_999, sessionTargetMs: 999_999, onEnded: () => {},
    });
    registry.set(created.sessionId, bridge);

    const res = await app.inject({ method: "POST", url: `/v1/sessions/${created.sessionId}/end` });
    expect(res.statusCode).toBe(200);
    expect(closeCalls).toBe(1); // the provider session is not orphaned
    // Ending over HTTP is a normal end, not a failure.
    const detail = await app.inject({ method: "GET", url: `/v1/sessions/${created.sessionId}` });
    expect((detail.json() as { state: string }).state).toBe("ANALYZING");
    expect(endedSessions.filter((s) => s === created.sessionId)).toHaveLength(1);
  });

  it("returns session state and transcript via GET", async () => {
    const created = (await app.inject({ method: "POST", url: `/v1/learners/${LEARNER_ID}/sessions` })).json() as { sessionId: string };
    const res = await app.inject({ method: "GET", url: `/v1/sessions/${created.sessionId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("state");
  });

  it("returns the persisted scores, analysis and metrics from the session detail endpoint", async () => {
    const created = (await app.inject({ method: "POST", url: `/v1/learners/${LEARNER_ID}/sessions` })).json() as { sessionId: string };
    sqlite.prepare(
      "UPDATE sessions SET status='COMPLETED', fluency_score=0.7, grammar_score=0.6, vocabulary_score=0.8, pronunciation_score=NULL, coherence_score=0.55, interaction_score=0.9, overall_score=0.72, analysis=?, metrics=? WHERE id=?",
    ).run(
      JSON.stringify({ scores: { fluency: 0.7, grammar: 0.6, vocabulary: 0.8, pronunciation: null, coherence: 0.55, interaction: 0.9 } }),
      JSON.stringify({ speakingSeconds: 12, userWordCount: 20, wordsPerMinute: 100, pauseCount: 1, avgPauseMs: 300, longestPauseMs: 900, utteranceCount: 4, avgUtteranceWords: 5 }),
      created.sessionId,
    );
    const res = await app.inject({ method: "GET", url: `/v1/sessions/${created.sessionId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      state: string;
      scores: { fluency: number; pronunciation: number | null } | null;
      analysis: { scores: { fluency: number } } | null;
      metrics: { speakingSeconds: number } | null;
    };
    expect(body.state).toBe("COMPLETED");
    expect(body.scores?.fluency).toBe(0.7);
    // Not assessed → null, never 0 (spec §12.1).
    expect(body.scores?.pronunciation).toBeNull();
    expect(body.analysis?.scores?.fluency).toBe(0.7);
    expect(body.metrics?.speakingSeconds).toBe(12);
  });

  it("answers the learning plan with 200 null when there is no plan (empty state, not an error)", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/learners/${LEARNER_ID}/learning-plan` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body).toBe("null");
  });

  it("returns 404 feedback for an unknown session and null feedback before analysis", async () => {
    const missing = await app.inject({ method: "GET", url: "/v1/sessions/sess-nope/feedback" });
    expect(missing.statusCode).toBe(404);

    const created = (await app.inject({ method: "POST", url: `/v1/learners/${LEARNER_ID}/sessions` })).json() as { sessionId: string };
    // A session that has not finished analysing is a valid state, not an error.
    const pending = await app.inject({ method: "GET", url: `/v1/sessions/${created.sessionId}/feedback` });
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toMatchObject({ sessionId: created.sessionId, feedback: null });
  });

  it("returns the persisted review: scores, not-assessed dims, corrections and the next plan", async () => {
    const created = (await app.inject({ method: "POST", url: `/v1/learners/${LEARNER_ID}/sessions` })).json() as { sessionId: string };
    const analysis = {
      scores: { fluency: 0.7, grammar: 0.6, vocabulary: 0.8, pronunciation: null, coherence: 0.55, interaction: 0.9 },
      observations: [{
        type: "language_error", skill: "grammar.past_tense", evidence: "Yesterday I go to work",
        actual: "go", expected: "went", severity: 0.6, confidence: 0.9,
      }],
      recurring_errors: [], strengths: [], recommended_targets: [],
    };
    sqlite.prepare(
      "UPDATE sessions SET status='COMPLETED', fluency_score=?, grammar_score=?, vocabulary_score=?, pronunciation_score=NULL, coherence_score=?, interaction_score=?, overall_score=0.7, analysis=?, started_at=? WHERE id=?",
    ).run(0.7, 0.6, 0.8, 0.55, 0.9, JSON.stringify(analysis), Date.now(), created.sessionId);
    // A correction row as the analysis worker would have written it.
    sqlite.prepare(
      "INSERT INTO corrected_sentences (id, session_id, original, suggested, explanation, skill_code, evidence, confidence, learner_action, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run("corr-1", created.sessionId, "Yesterday I go to work", "Yesterday I went to work",
      'Replace "go" with "went" here.', "grammar.past_tense", "Yesterday I go to work", 0.9, "pending", Date.now());
    sqlite.prepare(
      "INSERT INTO learning_plans (id, learner_id, difficulty, primary_targets, secondary_targets, topic, reasoning, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run("plan-fb", LEARNER_ID, 0.45, '["grammar.past_tense"]', '["vocabulary.precision"]', "past weekends", "recurring past-tense errors", "active", Date.now());

    const res = await app.inject({ method: "GET", url: `/v1/sessions/${created.sessionId}/feedback` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      state: string;
      feedback: {
        scores: { pronunciation: number | null };
        notAssessed: string[];
        corrections: { id: string; suggested: string | null; learnerAction: string; skill: string }[];
        next: { topic: string; targets: string[] } | null;
      };
    };
    expect(body.state).toBe("COMPLETED");
    // Not assessed → named, never scored 0 (spec §12.1).
    expect(body.feedback.scores.pronunciation).toBeNull();
    expect(body.feedback.notAssessed).toEqual(["pronunciation"]);
    // Read back from the row, so the learner action survives a reload.
    expect(body.feedback.corrections[0]).toMatchObject({
      id: "corr-1", suggested: "Yesterday I went to work", learnerAction: "pending", skill: "grammar.past_tense",
    });
    expect(body.feedback.next?.targets).toContain("grammar.past_tense");
  });

  it("returns recurring errors with their evidence, trend and example", async () => {
    // A fresh database: the trend is computed over the learner's completed
    // sessions, so earlier tests' sessions would otherwise decide it.
    const fresh = openDb(":memory:");
    migrate(fresh);
    ensureSeed(fresh);
    const freshService = new SessionService(db(fresh));
    const isolated = await buildApp({
      service: freshService, db: db(fresh), registry: new BridgeRegistry(),
      selectSpeech: () => new MockSpeechProvider({ turns: SCRIPT, autoClose: false }),
      env: { PORT: 0, HOST: "127.0.0.1", DB_PATH: ":memory:", PROVIDER: "mock", WARMUP_MS: 50, SESSION_TARGET_MS: 60_000, OPENAI_API_KEY: undefined },
      queue: () => {},
    });
    const created = freshService.createSession(LEARNER_ID, Date.now());
    fresh.prepare("UPDATE sessions SET status='COMPLETED' WHERE id=?").run(created.id);
    fresh.prepare(
      "INSERT INTO error_patterns (id, learner_id, skill_code, pattern, description, frequency, severity, mastery, confidence, status, first_seen_at, last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run("err-t1", LEARNER_ID, "grammar.past_tense", "present_form_after_past_time_expression",
      "Base form after a past time expression", 3, 0.65, 0.2, 0.97, "active", Date.now() - 1000, Date.now());
    fresh.prepare(
      "INSERT INTO corrected_sentences (id, session_id, original, suggested, explanation, skill_code, evidence, confidence, learner_action, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run("corr-e1", created.id, "Yesterday I go to work", "Yesterday I went to work",
      'Replace "go" with "went" here.', "grammar.past_tense", "Yesterday I go to work", 0.9, "pending", Date.now());

    const res = await isolated.inject({ method: "GET", url: `/v1/learners/${LEARNER_ID}/errors` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { patterns: { skill: string; frequency: number; trend: string | null; example: { original: string; suggested: string | null } | null }[] };
    const pattern = body.patterns.find((p) => p.skill === "grammar.past_tense");
    expect(pattern).toBeTruthy();
    expect(pattern?.frequency).toBe(3);
    expect(pattern?.example).toMatchObject({ original: "Yesterday I go to work", suggested: "Yesterday I went to work" });
    // One session of evidence is not a trend (spec §3 principle 7).
    expect(pattern?.trend).toBeNull();

    expect((await isolated.inject({ method: "GET", url: "/v1/learners/nobody/errors" })).statusCode).toBe(404);
    await isolated.close();
  });

  it("serves a due review queue and reschedules the item from a recorded attempt", async () => {
    sqlite.prepare(
      "INSERT INTO vocabulary_items (id, learner_id, word, recognition_mastery, production_mastery, collocation_mastery, exposure_count, production_count, last_used_at, next_review_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run("voc-1", LEARNER_ID, "negotiate", 0.3, 0.4, 0, 0, 1, Date.now() - 2000, null);

    const queue = await app.inject({ method: "GET", url: `/v1/learners/${LEARNER_ID}/review-queue` });
    expect(queue.statusCode).toBe(200);
    expect((queue.json() as { word: string }[]).some((i) => i.word === "negotiate")).toBe(true);

    const before = sqlite.prepare("SELECT production_mastery, next_review_at FROM vocabulary_items WHERE id='voc-1'")
      .get() as { production_mastery: number; next_review_at: number | null };
    expect(before.next_review_at).toBeNull();

    const attempt = await app.inject({
      method: "POST", url: `/v1/learners/${LEARNER_ID}/reviews/negotiate/attempts`,
      payload: { outcome: "correct", promptType: "production" },
    });
    expect(attempt.statusCode).toBe(200);
    const out = attempt.json() as { intervalDays: number; nextReviewAt: number; schedulerVersion: string };
    expect(out.intervalDays).toBeGreaterThan(0);
    expect(out.nextReviewAt).toBeGreaterThan(Date.now());
    expect(out.schedulerVersion).toBe("interval-v1");

    const after = sqlite.prepare("SELECT production_mastery, next_review_at FROM vocabulary_items WHERE id='voc-1'")
      .get() as { production_mastery: number; next_review_at: number | null };
    expect(after.production_mastery).toBeGreaterThan(before.production_mastery);
    expect(after.next_review_at).toBeGreaterThan(Date.now());

    // The attempt is persisted, not just applied (spec §7.4 requirement 3).
    const attempts = sqlite.prepare("SELECT COUNT(*) AS n FROM review_attempts WHERE word='negotiate'").get() as { n: number };
    expect(attempts.n).toBe(1);

    // Bad outcome and unknown word are client errors, not 500s.
    expect((await app.inject({
      method: "POST", url: `/v1/learners/${LEARNER_ID}/reviews/negotiate/attempts`, payload: { outcome: "maybe" },
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "POST", url: `/v1/learners/${LEARNER_ID}/reviews/absent/attempts`, payload: { outcome: "correct" },
    })).statusCode).toBe(404);
  });

  it("stores preferences, and an unset preference stays null rather than a default", async () => {
    const empty = await app.inject({ method: "GET", url: `/v1/learners/${LEARNER_ID}/preferences` });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toMatchObject({ correctionStyle: null, preferredSessionMinutes: null, updatedAt: null });

    const save = await app.inject({
      method: "PATCH", url: `/v1/learners/${LEARNER_ID}/preferences`,
      payload: { correctionStyle: "intensive", preferredSessionMinutes: 20 },
    });
    expect(save.statusCode).toBe(200);

    const saved = await app.inject({ method: "GET", url: `/v1/learners/${LEARNER_ID}/preferences` });
    expect(saved.json()).toMatchObject({ correctionStyle: "intensive", preferredSessionMinutes: 20 });
    // The live coach reads correction style off the learners row — a stored
    // preference that never reached it would be cosmetic.
    const learner = sqlite.prepare("SELECT correction_style FROM learners WHERE id=?").get(LEARNER_ID) as { correction_style: string };
    expect(learner.correction_style).toBe("intensive");

    expect((await app.inject({
      method: "PATCH", url: `/v1/learners/${LEARNER_ID}/preferences`, payload: { preferredSessionMinutes: 0 },
    })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/v1/learners/nobody/preferences" })).statusCode).toBe(404);
  });

  it("re-enqueues a failed analysis job and refuses an already-analyzed session", async () => {
    const created = (await app.inject({ method: "POST", url: `/v1/learners/${LEARNER_ID}/sessions` })).json() as { sessionId: string };
    // A failed job row exists for this session (the runner exhausted its attempts).
    const jobId = "job-failed-1";
    sqlite.prepare(
      "INSERT INTO jobs (id, type, session_id, status, attempts, max_attempts, error, created_at, done_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(jobId, "analyze", created.sessionId, "failed", 3, 3, "boom", Date.now(), Date.now());
    sqlite.prepare(
      "INSERT INTO job_attempts (id, job_id, attempt, status, error_class, error, started_at, finished_at) VALUES (?,?,?,?,?,?,?,?)",
    ).run("att-1", jobId, 3, "failed", "provider", "boom", Date.now(), Date.now());

    const listed = await app.inject({ method: "GET", url: "/v1/jobs/failed" });
    expect(listed.statusCode).toBe(200);
    const failed = listed.json() as { id: string; sessionId: string; history: { attempt: number; errorClass: string }[] }[];
    const row = failed.find((j) => j.id === jobId);
    expect(row).toBeTruthy();
    expect(row?.sessionId).toBe(created.sessionId);
    expect(row?.history[0]).toMatchObject({ attempt: 3, errorClass: "provider" });

    // The retry flips the existing job back to pending (UNIQUE(session_id,type)
    // makes a fresh insert impossible) — the job is not duplicated.
    const retried = await app.inject({ method: "POST", url: `/v1/sessions/${created.sessionId}/analyze` });
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({ state: "QUEUED" });
    const job = sqlite.prepare("SELECT status, attempts FROM jobs WHERE id = ?").get(jobId) as { status: string; attempts: number };
    expect(job.status).toBe("pending");
    expect(job.attempts).toBe(0);
    const count = sqlite.prepare("SELECT COUNT(*) AS n FROM jobs WHERE session_id = ?").get(created.sessionId) as { n: number };
    expect(count.n).toBe(1);

    // A completed session cannot be re-analyzed.
    sqlite.prepare("UPDATE sessions SET status='COMPLETED' WHERE id=?").run(created.sessionId);
    const refused = await app.inject({ method: "POST", url: `/v1/sessions/${created.sessionId}/analyze` });
    expect(refused.statusCode).toBe(409);
  });

  it("mock mode plays the scripted demo end-to-end (README promise; the real factory wiring)", async () => {
    // This app is built the way server.ts builds it: the speech provider comes
    // from selectSpeechProvider with the demo script — not an injected literal.
    // Before the fix the server passed no script, the mock auto-closed on an
    // empty script, and every mock session ended FAILED with zero conversation.
    const sqlite = openDb(":memory:");
    migrate(sqlite);
    ensureSeed(sqlite);
    const service = new SessionService(db(sqlite));
    const registry = new BridgeRegistry();
    const local = await buildApp({
      service,
      db: db(sqlite),
      registry,
      selectSpeech: () => selectSpeechProvider({ PROVIDER: "mock", OPENAI_API_KEY: undefined }, MOCK_DEMO_SCRIPT),
      env: { PORT: 0, HOST: "127.0.0.1", DB_PATH: ":memory:", PROVIDER: "mock", WARMUP_MS: 50, SESSION_TARGET_MS: 600_000, OPENAI_API_KEY: undefined },
      queue: (type, sessionId) => { if (type === "analyze") endedSessions.push(sessionId); },
    });
    await local.listen({ port: 0, host: "127.0.0.1" });

    const created = (await local.inject({ method: "POST", url: `/v1/learners/${LEARNER_ID}/sessions`, payload: {} })).json() as { sessionId: string };
    const ws = new WebSocket(`ws://127.0.0.1:${(local.server.address() as { port: number }).port}/ws/session/${created.sessionId}`);
    const events: any[] = [];
    ws.on("message", (raw) => { events.push(JSON.parse(String(raw))); });
    await new Promise<void>((resolve) => { ws.on("open", resolve); });
    // The demo script: 7 turns x 25 ms, and the tool call fires 50 ms after
    // the learner's third turn. Wait for both instead of guessing how long
    // the script takes.
    await waitFor(
      () =>
        events.filter((m) => m.t === "transcript" && m.speaker === "learner").length >= 3 &&
        events.some((m) => m.t === "intervention"),
      "the scripted conversation and its tool call",
    );

    const learnerTurns = events.filter((m) => m.t === "transcript" && m.speaker === "learner");
    expect(learnerTurns.length).toBeGreaterThanOrEqual(3); // the scripted learner spoke (recurring past-tense error)
    expect(events.some((m) => m.t === "intervention" && m.kind === "micro_coach")).toBe(true); // tool call fired

    ws.send(JSON.stringify({ t: "control", action: "end" }));
    await waitFor(
      () => events.some((m) => m.t === "session_ended"),
      "the session_ended message",
    );
    expect(events.some((m) => m.t === "session_ended" && m.state === "ANALYZING")).toBe(true); // client end -> analysis, not FAILED
    expect(endedSessions.filter((s) => s === created.sessionId)).toHaveLength(1);
    ws.close();
    await local.close();
  });
});

describe("WebSocket session protocol", () => {
  it("streams transcript events and state changes, then session_ended", async () => {
    const created = (await app.inject({ method: "POST", url: `/v1/learners/${LEARNER_ID}/sessions` })).json() as { sessionId: string };
    const messages: any[] = [];
    const ws = new WebSocket(`${url.replace("http", "ws")}/ws/session/${created.sessionId}`);
    ws.on("message", (raw) => {
      messages.push(JSON.parse(String(raw)));
    });
    await new Promise<void>((resolve) => {
      ws.on("open", () => resolve());
    });
    // wait for the script to play out
    await waitFor(
      () => messages.some((m) => m.t === "transcript" && m.speaker === "learner"),
      "the scripted learner turn",
    );
    expect(messages.some((m) => m.t === "state" && m.state === "WARMUP")).toBe(true);
    expect(messages.some((m) => m.t === "transcript" && m.speaker === "learner")).toBe(true);
    ws.send(JSON.stringify({ t: "control", action: "end" }));
    await waitFor(
      () => messages.some((m) => m.t === "session_ended"),
      "the session_ended message",
    );
    expect(messages.some((m) => m.t === "session_ended" && m.state === "ANALYZING")).toBe(true);
    ws.close();
  }, 10_000);
});
