import { randomUUID } from "node:crypto";
import { and, eq, ne, isNotNull, desc } from "drizzle-orm";
import {
  learners, goalsTable, skills, errorPatterns,
  sessions, utterances, observations, learningPlans,
} from "@ec/db";
import type { DrizzleDb } from "@ec/db";
import {
  LEARNER_ID, type LearnerContext, type SessionMetrics, type SessionRecord, type SessionState,
} from "@ec/domain";
import { canTransition } from "../stateMachine.js";
import { computeMetrics } from "../metrics.js";

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
    const last = this.d.select().from(utterances)
      .where(and(eq(utterances.sessionId, sessionId), eq(utterances.speaker, "learner")))
      .orderBy(utterances.sequenceNumber).all()
      .filter((u) => u.sequenceNumber % 2 === 1).at(-1);
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
    this.d.insert(observations).values({
      id: `obs-${randomUUID()}`, sessionId, type: kind,
      skillCode: skill, evidence: null,
      severity: null, confidence: 0.9, createdAt: now,
    }).run();
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
      scores: null, analysis: null, metrics: null, // filled by Task 7
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
    const learner = this.d.select().from(learners).where(eq(learners.id, s.learnerId)).all()[0];
    const plan = this.d.select().from(learningPlans)
      .where(and(eq(learningPlans.learnerId, s.learnerId), eq(learningPlans.status, "active")))
      .orderBy(desc(learningPlans.createdAt)).all()[0];
    const goals = this.d.select().from(goalsTable)
      .where(and(eq(goalsTable.learnerId, s.learnerId), eq(goalsTable.status, "active"))).all();
    const recurring = this.d.select().from(errorPatterns)
      .where(and(eq(errorPatterns.learnerId, s.learnerId), eq(errorPatterns.status, "active")))
      .all()
      .filter((e) => e.frequency >= 3 && e.confidence >= 0.75)
      .map((e) => e.skillCode);
    const strengths = this.d.select().from(skills)
      .where(and(eq(skills.learnerId, s.learnerId), eq(skills.trend, "improving"))).all()
      .map((sk) => sk.code);
    const recent = this.d.select().from(sessions)
      .where(and(eq(sessions.learnerId, s.learnerId), ne(sessions.id, s.id), isNotNull(sessions.topic)))
      .orderBy(desc(sessions.startedAt)).all()
      .slice(0, 5).map((x) => x.topic ?? "").filter(Boolean);
    const primary = parsePrimaryTargets(plan);
    return {
      level: learner.estimatedLevel ?? learner.targetLevel ?? "B1",
      goals: goals.map((g) => g.description),
      strengths,
      activeWeaknesses: recurring,
      vocabularyTargets: [],
      difficulty: plan?.difficulty ?? s.plannedDifficulty ?? 0.5,
      correctionStyle: learner.correctionStyle,
      recentTopics: recent,
      currentSessionTargets: primary,
    };
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

function parsePrimaryTargets(plan: { primaryTargets: string | null } | undefined): string[] {
  if (!plan?.primaryTargets) return [];
  try { return JSON.parse(plan.primaryTargets) as string[]; } catch { return []; }
}

function emptyMetrics(): SessionMetrics {
  return { speakingSeconds: 0, userWordCount: 0, wordsPerMinute: 0, pauseCount: 0, avgPauseMs: 0, longestPauseMs: 0, utteranceCount: 0, avgUtteranceWords: 0, rmsEnergyAvg: 0 };
}
