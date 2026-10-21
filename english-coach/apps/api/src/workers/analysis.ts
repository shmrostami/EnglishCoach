import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import {
  sessions, utterances, observations, skills, errorPatterns, vocabularyItems,
  learners, jobs, correctedSentences, tryParseJson, type DrizzleDb,
} from "@ec/db";
import type { Scores, SessionAnalysis, SessionMetrics, Observation, SkillState } from "@ec/domain";
import { SessionAnalysisSchema } from "@ec/domain";
import type { AnalysisProvider, TranscriptTurn } from "@ec/openai";
import {
  calculateOverall, updateSkill, trendFromDelta,
  upsertErrorInput, shouldRetire, estimateLevel, deriveFeedback,
  type ErrorPatternInput,
} from "@ec/learning-engine";
import { buildLearnerContext } from "./context.js";

const PERFORMANCE: Record<Observation["type"], (o: Observation) => number> = {
  language_error: (o) => 1 - (o.severity ?? 0.5),
  strength: () => 0.9,
  vocabulary_use: () => 0.8,
  fluency_signal: () => 0.7,
};

export async function runAnalysis(opts: {
  db: DrizzleDb;
  provider: AnalysisProvider;
  sessionId: string;
  now: number;
}): Promise<void> {
  const { db: d, provider, sessionId, now } = opts;
  const session = d.select().from(sessions).where(eq(sessions.id, sessionId)).all()[0];
  if (!session) throw new Error(`unknown session ${sessionId}`);
  if (session.analysis) return; // idempotency: already analyzed

  const turns: TranscriptTurn[] = d.select().from(utterances)
    .where(eq(utterances.sessionId, sessionId))
    .all()
    .map((u) => ({
      speaker: u.speaker as "learner" | "coach",
      text: u.text,
      startedAt: u.startedAt ?? 0,
      endedAt: u.endedAt ?? 0,
    }))
    .sort((a, b) => a.startedAt - b.startedAt);

  const metrics: SessionMetrics = tryParseJson<SessionMetrics>(session.metrics) ?? {
    speakingSeconds: 0, userWordCount: 0, wordsPerMinute: 0, pauseCount: 0,
    avgPauseMs: 0, longestPauseMs: 0, utteranceCount: 0, avgUtteranceWords: 0,
  };
  const learnerContext = buildLearnerContext(d, session.learnerId, sessionId, now);

  const raw = await provider.analyze({
    learnerId: session.learnerId,
    transcript: turns,
    metrics,
    learnerContext,
    sessionTargets: learnerContext.currentSessionTargets,
  });
  const analysis = SessionAnalysisSchema.parse(raw); // throws → job retry/failure, no writes

  // 1) session scores + overall
  // A provider that cannot ground a score in audio must not contribute one:
  // the number is stripped here, not merely discouraged in the prompt
  // (spec §12.1 / §3 principle 7 — no fabricated measurement).
  const scores: Scores = provider.capabilities.pronunciationEvidence
    ? analysis.scores
    : { ...analysis.scores, pronunciation: null };
  const overall = calculateOverall(scores);
  // The stored analysis carries the same stripped scores as the columns, so a
  // reader never sees a pronunciation number the score column denies.
  const stored = { ...analysis, scores };

  // 2) update learner memory (sequential statements; safe to re-run: the
  // idempotency guard at the top plus UNIQUE constraints make a crashed
  // mid-run retry a no-op)
  applyMemory(d, session.learnerId, sessionId, stored, overall, now);

  // 4) persist the reviewable corrections (spec §11.3). Derived from the
  // stored analysis, so a retry writes the same rows; the `any existing` guard
  // means a re-run cannot duplicate them (spec §3 principle 6). Written before
  // the session row is marked analysed: a crash in between must not leave a
  // session that looks analysed but has no corrections, because the idempotency
  // guard at the top would then never run this code again.
  persistCorrections(d, sessionId, stored, now);

  d.update(sessions).set({
    status: "COMPLETED",
    fluencyScore: scores.fluency,
    grammarScore: scores.grammar,
    vocabularyScore: scores.vocabulary,
    pronunciationScore: scores.pronunciation,
    coherenceScore: scores.coherence,
    interactionScore: scores.interaction,
    overallScore: overall,
    analysis: JSON.stringify(stored),
  }).where(eq(sessions.id, sessionId)).run();

  // learner level estimate (longitudinal, spec §31)
  const completedCount = d.select().from(sessions)
    .where(and(eq(sessions.learnerId, session.learnerId), eq(sessions.status, "COMPLETED"))).all().length;
  const { level, confidence } = estimateLevel(overall, completedCount);
  d.update(learners).set({
    estimatedLevel: level,
    estimatedLevelConfidence: confidence,
    updatedAt: now,
  }).where(eq(learners.id, session.learnerId)).run();

  // 3) persist observations rows (evidence trail, spec §23)
  for (const o of analysis.observations) {
    d.insert(observations).values({
      id: `obs-${randomUUID()}`,
      sessionId,
      type: o.type,
      skillCode: o.skill,
      evidence: o.evidence,
      expected: o.expected ?? null,
      actual: o.actual ?? null,
      severity: o.severity ?? null,
      confidence: o.confidence,
      createdAt: now,
    }).run();
  }

  // 5) queue the planner
  try {
    d.insert(jobs).values({
      id: `job-${randomUUID()}`,
      type: "plan_next",
      sessionId,
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
      createdAt: now,
    }).run();
  } catch { /* duplicate no-op */ }
}

function persistCorrections(d: DrizzleDb, sessionId: string, analysis: SessionAnalysis, now: number): void {
  const existing = d.select().from(correctedSentences)
    .where(eq(correctedSentences.sessionId, sessionId)).all();
  if (existing.length > 0) return;
  for (const c of deriveFeedback(analysis).corrections) {
    d.insert(correctedSentences).values({
      id: `corr-${randomUUID()}`,
      sessionId,
      original: c.original,
      suggested: c.suggested,
      explanation: c.explanation,
      skillCode: c.skill,
      evidence: c.evidence,
      confidence: c.confidence,
      learnerAction: "pending",
      createdAt: now,
    }).run();
  }
}

function applyMemory(
  d: DrizzleDb,
  learnerId: string,
  sessionId: string,
  analysis: SessionAnalysis,
  overall: number,
  now: number,
): void {
  // Skills: EMA update per observed skill (only confidence > 0.8 observations count)
  const errorsBySkill = new Map<string, { severity: number; confidence: number }>();
  for (const o of analysis.observations) {
    if (o.confidence <= 0.8) continue;
    if (o.type === "language_error") {
      const cur = errorsBySkill.get(o.skill);
      errorsBySkill.set(o.skill, {
        severity: Math.max(cur?.severity ?? 0, o.severity ?? 0.5),
        confidence: Math.max(cur?.confidence ?? 0, o.confidence),
      });
    }
    const existing = d.select().from(skills)
      .where(and(eq(skills.learnerId, learnerId), eq(skills.code, o.skill))).all()[0];
    if (existing) {
      const prev: SkillState = {
        mastery: existing.mastery, confidence: existing.confidence,
        observationCount: existing.observationCount, trend: existing.trend as SkillState["trend"],
      };
      const next = updateSkill(prev, PERFORMANCE[o.type](o), now);
      d.update(skills).set({
        mastery: next.mastery,
        confidence: next.confidence,
        observationCount: next.observationCount,
        trend: trendFromDelta(prev.mastery, next.mastery),
        lastAssessedAt: now,
      }).where(eq(skills.id, existing.id)).run();
    } else {
      d.insert(skills).values({
        id: `skill-${randomUUID()}`,
        learnerId,
        code: o.skill,
        mastery: 0.5,
        confidence: 0.1,
        trend: "stable",
        observationCount: 0,
        lastAssessedAt: now,
      }).run();
      // then update the fresh row
      const created = d.select().from(skills)
        .where(and(eq(skills.learnerId, learnerId), eq(skills.code, o.skill))).all()[0];
      d.update(skills).set({
        mastery: updateSkill(
          { mastery: 0.5, confidence: 0.1, observationCount: 0, trend: "stable" },
          PERFORMANCE[o.type](o), now,
        ).mastery,
        confidence: 0.15,
        observationCount: 1,
      }).where(eq(skills.id, created.id)).run();
    }
  }

  // Error patterns: upsert per (skill, pattern); pattern = recurring name if flagged, else "other"
  for (const [skill, e] of errorsBySkill) {
    const recurring = analysis.recurring_errors.find((r) => r.skill === skill);
    const pattern = recurring?.pattern ?? "other";
    const prevRow = d.select().from(errorPatterns)
      .where(and(
        eq(errorPatterns.learnerId, learnerId),
        eq(errorPatterns.skillCode, skill),
        eq(errorPatterns.pattern, pattern),
      )).all()[0];
    const prev: ErrorPatternInput | null = prevRow
      ? {
          skill, pattern, frequency: prevRow.frequency, severity: prevRow.severity,
          mastery: prevRow.mastery, confidence: prevRow.confidence, status: prevRow.status as "active" | "mastered",
          firstSeenAt: prevRow.firstSeenAt, lastSeenAt: prevRow.lastSeenAt,
        }
      : null;
    const count = analysis.observations.filter((o) => o.skill === skill && o.type === "language_error").length;
    let next = prev;
    for (let i = 0; i < count; i++) {
      next = upsertErrorInput(next, { skill, pattern, severity: e.severity, confidence: e.confidence }, now);
    }
    if (next) {
      if (prevRow) {
        d.update(errorPatterns).set({
          frequency: next.frequency,
          severity: next.severity,
          confidence: next.confidence,
          lastSeenAt: now,
        }).where(eq(errorPatterns.id, prevRow.id)).run();
      } else {
        d.insert(errorPatterns).values({
          id: `err-${randomUUID()}`,
          learnerId,
          skillCode: skill,
          pattern: next.pattern,
          frequency: next.frequency,
          severity: next.severity,
          confidence: next.confidence,
          firstSeenAt: now,
          lastSeenAt: now,
        }).run();
      }
    }
  }

  // Retirement: mark stale or outgrown patterns mastered (spec §10.3)
  for (const row of d.select().from(errorPatterns)
    .where(and(eq(errorPatterns.learnerId, learnerId), eq(errorPatterns.status, "active"))).all()) {
    const skillRow = d.select().from(skills)
      .where(and(eq(skills.learnerId, learnerId), eq(skills.code, row.skillCode))).all()[0];
    const input: ErrorPatternInput = {
      skill: row.skillCode, pattern: row.pattern, frequency: row.frequency,
      severity: row.severity, mastery: row.mastery, confidence: row.confidence,
      status: "active", firstSeenAt: row.firstSeenAt, lastSeenAt: row.lastSeenAt,
    };
    if (shouldRetire(input, skillRow?.mastery ?? 0, now)) {
      d.update(errorPatterns).set({ status: "mastered" }).where(eq(errorPatterns.id, row.id)).run();
    }
  }

  // Vocabulary: track words from vocabulary_use evidence (longest alpha token), spec §10.4
  for (const o of analysis.observations.filter((x) => x.type === "vocabulary_use")) {
    const word = (o.evidence.match(/[a-zA-Z]{4,}/g) ?? []).sort((a, b) => b.length - a.length)[0];
    if (!word) continue;
    const existing = d.select().from(vocabularyItems)
      .where(and(eq(vocabularyItems.learnerId, learnerId), eq(vocabularyItems.word, word))).all()[0];
    if (existing) {
      d.update(vocabularyItems).set({
        productionCount: existing.productionCount + 1,
        productionMastery: Math.min(0.95, existing.productionMastery + 0.05),
        lastUsedAt: now,
        nextReviewAt: now + Math.max(1, Math.floor(10 * (existing.productionMastery + 0.05))) * 86_400_000,
      }).where(eq(vocabularyItems.id, existing.id)).run();
    } else {
      d.insert(vocabularyItems).values({
        id: `vocab-${randomUUID()}`,
        learnerId, word,
        recognitionMastery: 0.3,
        productionMastery: 0.1,
        collocationMastery: 0,
        exposureCount: 0,
        productionCount: 1,
        lastUsedAt: now,
      }).run();
    }
  }
  void overall; // overall is persisted by the caller; retained for signature stability
}
