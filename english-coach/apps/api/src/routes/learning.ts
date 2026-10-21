import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  learners, errorPatterns, correctedSentences, vocabularyItems, reviewAttempts,
  learnerPreferences, sessions, vocabularyItemsCanonical, vocabularyState,
  difficultyProfiles, type DrizzleDb,
} from "@ec/db";
import type { ErrorPatternView } from "@ec/domain";
import {
  effectiveFrequency, errorTrend, selectReviewQueue,
  nextIntervalDays, applyReviewOutcome, dueAt, SCHEDULER_VERSION,
  type ReviewOutcome,
} from "@ec/learning-engine";

const DAY_MS = 86_400_000;

function hasLearner(d: DrizzleDb, id: string): boolean {
  return d.select().from(learners).where(eq(learners.id, id)).all().length > 0;
}

export function registerLearningRoutes(app: FastifyInstance, d: DrizzleDb): void {
  app.get("/v1/learners/:id/preferences", (req, reply) => {
    const { id } = req.params as { id: string };
    if (!hasLearner(d, id)) return reply.code(404).send({ error: "unknown learner" });
    const row = d.select().from(learnerPreferences)
      .where(eq(learnerPreferences.learnerId, id)).all()[0];
    // No row is a valid state: nothing has been chosen yet. Every field is null
    // rather than a default the learner never picked (spec §6.1).
    return {
      correctionStyle: row?.correctionStyle ?? null,
      preferredSessionMinutes: row?.preferredSessionMinutes ?? null,
      preferredFeedbackLanguage: row?.preferredFeedbackLanguage ?? null,
      preferredAccent: row?.preferredAccent ?? null,
      updatedAt: row?.updatedAt ?? null,
    };
  });

  app.patch("/v1/learners/:id/preferences", (req, reply) => {
    const { id } = req.params as { id: string };
    if (!hasLearner(d, id)) return reply.code(404).send({ error: "unknown learner" });
    const body = (req.body ?? {}) as Partial<{
      correctionStyle: string; preferredSessionMinutes: number;
      preferredFeedbackLanguage: string; preferredAccent: string;
    }>;
    const now = Date.now();
    const patch: Record<string, unknown> = { updatedAt: now };
    if (typeof body.correctionStyle === "string") patch.correctionStyle = body.correctionStyle;
    if (typeof body.preferredFeedbackLanguage === "string") patch.preferredFeedbackLanguage = body.preferredFeedbackLanguage;
    if (typeof body.preferredAccent === "string") patch.preferredAccent = body.preferredAccent;
    if (body.preferredSessionMinutes !== undefined) {
      const m = body.preferredSessionMinutes;
      // A session length the app cannot honour would be a setting that lies.
      if (!Number.isInteger(m) || m < 1 || m > 120) {
        return reply.code(400).send({ error: "preferredSessionMinutes must be an integer between 1 and 120" });
      }
      patch.preferredSessionMinutes = m;
    }

    const existing = d.select().from(learnerPreferences)
      .where(eq(learnerPreferences.learnerId, id)).all()[0];
    if (existing) {
      d.update(learnerPreferences).set(patch as never)
        .where(eq(learnerPreferences.learnerId, id)).run();
    } else {
      d.insert(learnerPreferences).values({ learnerId: id, ...patch } as never).run();
    }
    // The live coach prompt reads correction style off the learners row, so a
    // change here has to reach it or the setting would only be cosmetic.
    if (typeof body.correctionStyle === "string") {
      d.update(learners).set({ correctionStyle: body.correctionStyle, updatedAt: now })
        .where(eq(learners.id, id)).run();
    }
    return { ok: true };
  });

  /**
   * Recurring errors with the evidence a learner can act on (spec §7.2).
   * `trend` is null while only one session carries evidence for the skill — a
   * single observation is not a direction (spec §3 principle 7).
   */
  app.get("/v1/learners/:id/errors", (req, reply) => {
    const { id } = req.params as { id: string };
    if (!hasLearner(d, id)) return reply.code(404).send({ error: "unknown learner" });
    const now = Date.now();
    const rows = d.select().from(errorPatterns)
      .where(eq(errorPatterns.learnerId, id))
      .orderBy(desc(errorPatterns.lastSeenAt)).all();
    const skills = [...new Set(rows.map((r) => r.skillCode))];

    // Per-session counts for the trend, oldest→newest. Corrections are the
    // per-session evidence for a skill, so they are the honest source here.
    const perSkillCounts = new Map<string, number[]>();
    if (skills.length > 0) {
      const completed = d.select().from(sessions)
        .where(and(eq(sessions.learnerId, id), eq(sessions.status, "COMPLETED")))
        .orderBy(sessions.startedAt).all();
      for (const s of completed) {
        const counts = new Map<string, number>();
        for (const c of d.select().from(correctedSentences)
          .where(eq(correctedSentences.sessionId, s.id)).all()) {
          counts.set(c.skillCode, (counts.get(c.skillCode) ?? 0) + 1);
        }
        for (const skill of skills) {
          perSkillCounts.set(skill, [...(perSkillCounts.get(skill) ?? []), counts.get(skill) ?? 0]);
        }
      }
    }

    const views: ErrorPatternView[] = rows.map((r) => {
      const example = d.select().from(correctedSentences)
        .where(eq(correctedSentences.skillCode, r.skillCode)).all()
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      return {
        id: r.id,
        skill: r.skillCode,
        pattern: r.pattern,
        description: r.description ?? null,
        frequency: r.frequency,
        effectiveFrequency: Number(effectiveFrequency(r.frequency, r.lastSeenAt, now).toFixed(2)),
        severity: r.severity,
        confidence: r.confidence,
        status: r.status,
        firstSeenAt: r.firstSeenAt,
        lastSeenAt: r.lastSeenAt,
        trend: errorTrend(perSkillCounts.get(r.skillCode) ?? []),
        example: example ? { original: example.original, suggested: example.suggested } : null,
      };
    });
    return { patterns: views, generatedAt: now };
  });

  /**
   * The learner's vocabulary: canonical items and their state for this
   * learner (spec §6.5). The three masteries are reported separately — a
   * word the learner recognises but has never used is not "known".
   */
  app.get("/v1/learners/:id/vocabulary", (req, reply) => {
    const { id } = req.params as { id: string };
    if (!hasLearner(d, id)) return reply.code(404).send({ error: "unknown learner" });
    const rows = d.select().from(vocabularyState)
      .where(eq(vocabularyState.learnerId, id)).all();
    const items = d.select().from(vocabularyItemsCanonical).all();
    const byId = new Map(items.map((i) => [i.id, i]));
    return rows
      .map((r) => {
        const item = byId.get(r.vocabularyItemId);
        return {
          lemma: item?.lemma ?? null,
          senseKey: item?.senseKey ?? null,
          partOfSpeech: item?.partOfSpeech ?? null,
          definition: item?.definition ?? null,
          recognitionMastery: r.recognitionMastery,
          recallMastery: r.recallMastery,
          productionMastery: r.productionMastery,
          stability: r.stability,
          difficulty: r.difficulty,
          dueAt: r.dueAt,
          lastReviewedAt: r.lastReviewedAt,
          reviewCount: r.reviewCount,
          lapseCount: r.lapseCount,
          status: r.status,
        };
      })
      .sort((a, b) => a.productionMastery - b.productionMastery);
  });

  /** The six-part difficulty profile of a session (design.md §10). */
  app.get("/v1/sessions/:id/difficulty", (req, reply) => {
    const { id } = req.params as { id: string };
    const row = d.select().from(difficultyProfiles)
      .where(eq(difficultyProfiles.sessionId, id)).all()[0];
    // No profile is a valid state: the session has not been analysed yet.
    if (!row) return reply.send({ difficulty: null });
    return {
      difficulty: {
        vocabularyComplexity: row.vocabularyComplexity,
        grammaticalComplexity: row.grammaticalComplexity,
        speechSpeed: row.speechSpeed,
        abstraction: row.abstraction,
        interactionPressure: row.interactionPressure,
        topicFamiliarity: row.topicFamiliarity,
        composite: row.composite,
      },
    };
  });

  /** What is due now, within a review-time budget (spec §7.4). */
  app.get("/v1/learners/:id/review-queue", (req, reply) => {
    const { id } = req.params as { id: string };
    if (!hasLearner(d, id)) return reply.code(404).send({ error: "unknown learner" });
    const q = req.query as { limit?: string };
    const limit = Math.min(50, Math.max(1, Number(q.limit ?? 10) || 10));
    const items = d.select().from(vocabularyItems)
      .where(eq(vocabularyItems.learnerId, id)).all();
    return selectReviewQueue(items, Date.now(), limit).map(({ item, promptType }) => ({
      word: item.word,
      promptType,
      recognitionMastery: item.recognitionMastery,
      productionMastery: item.productionMastery,
      nextReviewAt: item.nextReviewAt,
    }));
  });

  /** Record one review attempt and reschedule the item from it (spec §7.4). */
  app.post("/v1/learners/:id/reviews/:word/attempts", (req, reply) => {
    const { id, word } = req.params as { id: string; word: string };
    const body = (req.body ?? {}) as { outcome?: string; hintUsed?: boolean; promptType?: string };
    if (body.outcome !== "correct" && body.outcome !== "incorrect") {
      return reply.code(400).send({ error: "outcome must be 'correct' or 'incorrect'" });
    }
    const item = d.select().from(vocabularyItems)
      .where(and(eq(vocabularyItems.learnerId, id), eq(vocabularyItems.word, word))).all()[0];
    if (!item) return reply.code(404).send({ error: "unknown vocabulary item" });

    const now = Date.now();
    const outcome = body.outcome as ReviewOutcome;
    const hintUsed = body.hintUsed === true;
    // The interval is re-derived from the last schedule, not from "now", so a
    // second attempt the same day cannot compound the expansion.
    const prevInterval = item.nextReviewAt !== null && item.lastUsedAt !== null
      ? Math.max(1, Math.round((item.nextReviewAt - item.lastUsedAt) / DAY_MS))
      : null;
    const intervalDays = nextIntervalDays(prevInterval, outcome);

    d.insert(reviewAttempts).values({
      id: `rev-${randomUUID()}`,
      learnerId: id,
      vocabularyItemId: item.id,
      word: item.word,
      promptType: body.promptType === "production" ? "production" : "recognition",
      outcome,
      hintUsed: hintUsed ? 1 : 0,
      intervalDays,
      schedulerVersion: SCHEDULER_VERSION,
      createdAt: now,
    }).run();

    const nextReviewAt = dueAt(now, intervalDays);
    d.update(vocabularyItems).set({
      productionMastery: applyReviewOutcome(item.productionMastery, outcome, hintUsed),
      recognitionMastery: applyReviewOutcome(item.recognitionMastery, outcome, hintUsed),
      lastUsedAt: now,
      nextReviewAt,
    }).where(eq(vocabularyItems.id, item.id)).run();

    return { word: item.word, intervalDays, nextReviewAt, schedulerVersion: SCHEDULER_VERSION };
  });
}
