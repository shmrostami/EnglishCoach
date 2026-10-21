import { randomUUID } from "node:crypto";
import { and, eq, desc } from "drizzle-orm";
import {
  sessions, utterances, interventions, learningPlans, audioEvidence, tryParseJson,
} from "@ec/db";
import type { DrizzleDb, SessionRow } from "@ec/db";
import type {
  LearnerContext, Scores, SessionAnalysis, SessionMetrics, SessionRecord, SessionState,
} from "@ec/domain";
import { canTransition } from "../stateMachine.js";
import { computeMetrics } from "../metrics.js";
import { buildLearnerContext } from "../workers/context.js";

export class SessionService {
  constructor(private readonly d: DrizzleDb) {}

  createSession(learnerId: string, now: number): { id: string; topic: string; difficulty: number; state: SessionState } {
    const plan = this.d.select().from(learningPlans)
      .where(and(eq(learningPlans.learnerId, learnerId), eq(learningPlans.status, "active")))
      .orderBy(desc(learningPlans.createdAt)).all()[0];
    const difficulty = plan ? plan.difficulty : 0.5;
    const topic = plan?.topic ?? "Free conversation about your day";
    const id = `sess-${randomUUID()}`;
    this.d.insert(sessions).values({
      id, learnerId, status: "STARTING", topic,
      plannedDifficulty: difficulty,
      startedAt: now,
    }).run();
    return { id, topic, difficulty, state: "STARTING" };
  }

  recordUtterance(sessionId: string, turn: { speaker: "learner" | "coach"; text: string; startedAt: number; endedAt: number }): { utteranceId: string; seq: number } {
    // The previous learner turn is found by speaker, never by the parity of its
    // sequence number (spec §10.3: no speaker inference from odd/even ids).
    const last = this.d.select().from(utterances)
      .where(and(eq(utterances.sessionId, sessionId), eq(utterances.speaker, "learner")))
      .orderBy(utterances.sequenceNumber).all()
      .at(-1);
    const pauseBeforeMs = last ? Math.max(0, turn.startedAt - (last.endedAt ?? turn.startedAt)) : 0;
    const seq = (this.d.select().from(utterances).where(eq(utterances.sessionId, sessionId)).all().length) + 1;
    const id = `utt-${randomUUID()}`;
    this.d.insert(utterances).values({
      id, sessionId, speaker: turn.speaker, sequenceNumber: seq,
      text: turn.text, startedAt: turn.startedAt, endedAt: turn.endedAt,
      durationMs: turn.endedAt - turn.startedAt,
      wordCount: turn.text.split(/\s+/).filter(Boolean).length,
      pauseBeforeMs: turn.speaker === "learner" ? pauseBeforeMs : 0,
    }).run();
    return { utteranceId: id, seq };
  }

  recordIntervention(sessionId: string, kind: "micro_coach" | "target_retry" | "challenge", skill: string, now: number): void {
    // Interventions are coaching actions, not assessment evidence: they go to
    // their own table so `observations` keeps only assessed observations
    // (spec §23 separation).
    this.d.insert(interventions).values({
      id: `int-${randomUUID()}`, sessionId, kind, skillCode: skill, state: null, createdAt: now,
    }).run();
  }

  /**
   * Stores the learner's audio for one turn.
   *
   * This is the only path by which audio reaches a pronunciation assessment
   * (spec §12.1). The samples are kept with the turn they belong to, so a
   * score is always measured against the words that were said.
   */
  recordAudioEvidence(opts: {
    sessionId: string;
    utteranceId: string | null;
    pcm: Buffer;
    sampleRate: number;
    now: number;
  }): string | null {
    if (opts.pcm.length === 0) return null;
    const id = `aud-${randomUUID()}`;
    const sampleCount = Math.floor(opts.pcm.length / 2);
    this.d.insert(audioEvidence).values({
      id,
      sessionId: opts.sessionId,
      utteranceId: opts.utteranceId,
      speaker: "learner",
      sampleRate: opts.sampleRate,
      sampleCount,
      durationMs: Math.round((sampleCount / opts.sampleRate) * 1000),
      pcmBase64: opts.pcm.toString("base64"),
      measurements: null,
      createdAt: opts.now,
    }).run();
    return id;
  }

  transition(sessionId: string, to: SessionState, now: number): boolean {
    const row = this.d.select().from(sessions).where(eq(sessions.id, sessionId)).all()[0];
    if (!row || !canTransition(row.status as SessionState, to)) return false;
    this.d.update(sessions).set({ status: to }).where(eq(sessions.id, sessionId)).run();
    if (to === "ANALYZING") this.d.update(sessions).set({ endedAt: now }).where(eq(sessions.id, sessionId)).run();
    return true;
  }

  getRecord(sessionId: string): SessionRecord | null {
    const r = this.d.select().from(sessions).where(eq(sessions.id, sessionId)).all()[0];
    if (!r) return null;
    return {
      id: r.id, state: r.status as SessionState, topic: r.topic ?? "",
      plannedDifficulty: r.plannedDifficulty ?? 0,
      achievedDifficulty: r.achievedDifficulty ?? r.plannedDifficulty ?? 0,
      startedAt: r.startedAt, endedAt: r.endedAt,
      scores: this.readScores(r),
      analysis: tryParseJson<SessionAnalysis>(r.analysis),
      metrics: tryParseJson<SessionMetrics>(r.metrics),
    };
  }

  /**
   * The six scores live in their own columns, so they are rebuilt from the row
   * rather than parsed.
   *
   * Pronunciation is the one dimension that can be unmeasured: it stays null
   * ("not assessed", spec §12.1). The other five are always written together by
   * the analysis worker in a single UPDATE, so a null column there means the
   * row has no scores at all — which the `any` check below catches — and the
   * `?? 0` is a type-level fallback, not a measurement.
   */
  private readScores(r: SessionRow): Scores | null {
    const any = [r.fluencyScore, r.grammarScore, r.vocabularyScore,
      r.pronunciationScore, r.coherenceScore, r.interactionScore].some((v) => v !== null);
    if (!any) return null;
    return {
      fluency: r.fluencyScore ?? 0,
      grammar: r.grammarScore ?? 0,
      vocabulary: r.vocabularyScore ?? 0,
      pronunciation: r.pronunciationScore ?? null,
      coherence: r.coherenceScore ?? 0,
      interaction: r.interactionScore ?? 0,
    };
  }

  getTranscript(sessionId: string): { seq: number; speaker: string; text: string }[] {
    return this.d.select({
      seq: utterances.sequenceNumber, speaker: utterances.speaker, text: utterances.text,
    }).from(utterances).where(eq(utterances.sessionId, sessionId))
      .orderBy(utterances.sequenceNumber).all()
      .map((u) => ({ seq: u.seq, speaker: u.speaker, text: u.text }));
  }

  getLearnerContext(sessionId: string): LearnerContext {
    const s = this.d.select().from(sessions).where(eq(sessions.id, sessionId)).all()[0];
    if (!s) throw new Error(`unknown session ${sessionId}`);
    return buildLearnerContext(this.d, s.learnerId, sessionId, Date.now());
  }

  /**
   * Marks a session as terminally failed. Used when a background job gives up:
   * without it the session sits in ANALYZING forever (spec §5 "worker failures
   * reach a retryable or terminal failure state").
   */
  failSession(sessionId: string, now: number): boolean {
    const row = this.d.select().from(sessions).where(eq(sessions.id, sessionId)).all()[0];
    if (!row) return false;
    if (!canTransition(row.status as SessionState, "FAILED")) return false;
    this.d.update(sessions).set({ status: "FAILED", endedAt: row.endedAt ?? now }).where(eq(sessions.id, sessionId)).run();
    return true;
  }

  endSession(sessionId: string, now: number): { ok: boolean; reason?: string; metrics: SessionMetrics } {
    const row = this.d.select().from(sessions).where(eq(sessions.id, sessionId)).all()[0];
    if (!row) return { ok: false, reason: "not_found", metrics: emptyMetrics() };
    if (["ANALYZING", "COMPLETED", "FAILED"].includes(row.status)) {
      return { ok: false, reason: "already_ended", metrics: emptyMetrics() };
    }
    const turns = this.d.select().from(utterances)
      .where(eq(utterances.sessionId, sessionId)).all()
      .map((u) => ({ speaker: u.speaker as "learner" | "coach", text: u.text, startedAt: u.startedAt ?? 0, endedAt: u.endedAt ?? 0 }))
      .sort((a, b) => a.startedAt - b.startedAt);
    const metrics = computeMetrics(turns, now);
    this.transition(sessionId, "CLOSING", now);
    this.transition(sessionId, "ANALYZING", now);
    this.d.update(sessions).set({
      endedAt: now,
      durationSeconds: Math.round((now - row.startedAt) / 1000),
      metrics: JSON.stringify(metrics),
    }).where(eq(sessions.id, sessionId)).run();
    return { ok: true, metrics };
  }
}

function emptyMetrics(): SessionMetrics {
  return { speakingSeconds: 0, userWordCount: 0, wordsPerMinute: 0, pauseCount: 0, avgPauseMs: 0, longestPauseMs: 0, utteranceCount: 0, avgUtteranceWords: 0 };
}
