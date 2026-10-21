import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  learners, learningObjectives, activities, activityAttempts, sessions,
  utterances, vocabularyItems, diagnostics, tryParseJson, type DrizzleDb,
} from "@ec/db";
import type { ActivityStatus, SessionMetrics } from "@ec/domain";
import {
  assessGuidedSpeaking, selectObjective, GUIDED_RUBRIC_VERSION,
  runDiagnostic, type DiagnosticAnswers,
} from "@ec/learning-engine";

function hasLearner(d: DrizzleDb, id: string): boolean {
  return d.select().from(learners).where(eq(learners.id, id)).all().length > 0;
}

const WORDS = (s: string | null): string[] => tryParseJson<string[]>(s) ?? [];

/**
 * Activities and objectives (spec §6.2–§6.4, §10.2, backlog item 11).
 *
 * The one implemented type is `guided_speaking`: the learner is given a topic
 * and a short list of target words, speaks in a normal session, and the attempt
 * is scored deterministically against those words and the speaking time.
 */
export function registerActivityRoutes(app: FastifyInstance, d: DrizzleDb): void {
  app.get("/v1/learners/:id/objectives", (req, reply) => {
    const { id } = req.params as { id: string };
    if (!hasLearner(d, id)) return reply.code(404).send({ error: "unknown learner" });
    return d.select().from(learningObjectives)
      .where(eq(learningObjectives.learnerId, id))
      .orderBy(desc(learningObjectives.priority)).all()
      .map(toObjective);
  });

  app.post("/v1/learners/:id/objectives", (req, reply) => {
    const { id } = req.params as { id: string };
    if (!hasLearner(d, id)) return reply.code(404).send({ error: "unknown learner" });
    const body = (req.body ?? {}) as {
      title?: string; description?: string; skillCodes?: string[];
      goalId?: string; priority?: number;
    };
    if (!body.title || !body.description) {
      return reply.code(400).send({ error: "title and description are required" });
    }
    const now = Date.now();
    const objectiveId = `obj-${randomUUID()}`;
    d.insert(learningObjectives).values({
      id: objectiveId,
      learnerId: id,
      goalId: body.goalId ?? null,
      title: body.title,
      description: body.description,
      skillCodes: JSON.stringify(body.skillCodes ?? []),
      priority: body.priority ?? 0.5,
      status: "active",
      createdAt: now,
      updatedAt: now,
    }).run();
    return reply.code(201).send({ id: objectiveId });
  });

  /** The activity recommended now: one generated for the top objective. */
  app.get("/v1/learners/:id/activities/recommended", (req, reply) => {
    const { id } = req.params as { id: string };
    if (!hasLearner(d, id)) return reply.code(404).send({ error: "unknown learner" });
    const objective = selectObjective(
      d.select().from(learningObjectives).where(eq(learningObjectives.learnerId, id)).all(),
    );
    if (!objective) {
      // No objective is a valid empty state, not an error: the learner has not
      // set one yet, and a free conversation is still available.
      return { activity: null, reason: "No active objective — start a free conversation or add one." };
    }
    const activity = ensureGuidedActivity(d, id, objective);
    return {
      activity: toActivity(activity),
      reason: `Targets "${objective.title}" (priority ${Math.round(objective.priority * 100)}%).`,
    };
  });

  app.post("/v1/learners/:id/activities/:activityId/attempts", (req, reply) => {
    const { id, activityId } = req.params as { id: string; activityId: string };
    const row = d.select().from(activities)
      .where(and(eq(activities.id, activityId), eq(activities.learnerId, id))).all()[0];
    if (!row) return reply.code(404).send({ error: "unknown activity" });
    const now = Date.now();
    const attemptId = `att-${randomUUID()}`;
    d.insert(activityAttempts).values({
      id: attemptId,
      learnerId: id,
      activityId,
      activityVersion: row.version,
      sessionId: null,
      status: "in_progress",
      startedAt: now,
      createdAt: now,
    }).run();
    return reply.code(201).send({ attemptId, activityId, status: "in_progress" });
  });

  /**
   * Submit an attempt against a session. The transcript comes from the session,
   * never from the client, so the result cannot be dictated by the caller.
   */
  app.post("/v1/learners/:id/activity-attempts/:attemptId/submit", (req, reply) => {
    const { id, attemptId } = req.params as { id: string; attemptId: string };
    const attempt = d.select().from(activityAttempts)
      .where(and(eq(activityAttempts.id, attemptId), eq(activityAttempts.learnerId, id))).all()[0];
    if (!attempt) return reply.code(404).send({ error: "unknown attempt" });
    if (attempt.status === "completed") return reply.code(409).send({ error: "already_submitted" });

    const body = (req.body ?? {}) as { sessionId?: string };
    const session = body.sessionId
      ? d.select().from(sessions).where(eq(sessions.id, body.sessionId)).all()[0]
      : null;
    if (!session || session.learnerId !== id) return reply.code(400).send({ error: "sessionId must reference this learner's session" });

    const activity = d.select().from(activities)
      .where(eq(activities.id, attempt.activityId)).all()[0];
    const criteria = tryParseJson<{ requiredWords: string[]; targetSeconds: number; skillCode: string }>(
      activity.successCriteria,
    ) ?? { requiredWords: [], targetSeconds: 0, skillCode: "fluency.continuity" };

    const transcript = d.select().from(utterances)
      .where(and(eq(utterances.sessionId, session.id), eq(utterances.speaker, "learner")))
      .all().map((u) => u.text);
    const metrics = tryParseJson<SessionMetrics>(session.metrics) ?? {
      speakingSeconds: 0, userWordCount: 0, wordsPerMinute: 0, pauseCount: 0,
      avgPauseMs: 0, longestPauseMs: 0, utteranceCount: 0, avgUtteranceWords: 0,
    };

    const result = assessGuidedSpeaking({ attemptId, transcript, metrics, criteria });
    const now = Date.now();
    d.update(activityAttempts).set({
      sessionId: session.id,
      status: "completed",
      completedAt: now,
      result: JSON.stringify({ activityAttemptId: attemptId, ...result }),
    }).where(eq(activityAttempts.id, attemptId)).run();
    return { attemptId, status: "completed", result };
  });

  /**
   * Diagnostic onboarding (spec §5 Phase 2). Deterministic and based on the
   * learner's own answers, so the result is labelled `self_report` and carries
   * deliberately low confidence — it places a learner, it does not assess one.
   */
  app.post("/v1/learners/:id/diagnostic", (req, reply) => {
    const { id } = req.params as { id: string };
    if (!hasLearner(d, id)) return reply.code(404).send({ error: "unknown learner" });
    const body = (req.body ?? {}) as Partial<DiagnosticAnswers>;
    const comfort = body.speakingComfort;
    const grammar = body.grammarConfidence;
    const frequency = body.weeklySpeakingFrequency;
    if (
      typeof comfort !== "number" || comfort < 0 || comfort > 1 ||
      typeof grammar !== "number" || grammar < 0 || grammar > 1 ||
      typeof frequency !== "number" || frequency < 0 || frequency > 7
    ) {
      return reply.code(400).send({
        error: "speakingComfort and grammarConfidence must be 0..1; weeklySpeakingFrequency must be 0..7",
      });
    }
    const result = runDiagnostic({
      speakingComfort: comfort,
      grammarConfidence: grammar,
      weeklySpeakingFrequency: frequency,
      focusSkills: Array.isArray(body.focusSkills) ? body.focusSkills : [],
    });
    const now = Date.now();
    d.insert(diagnostics).values({
      id: `diag-${randomUUID()}`,
      learnerId: id,
      band: result.band,
      confidence: result.confidence,
      difficulty: result.difficulty,
      focusSkills: JSON.stringify(result.focusSkills),
      basis: result.basis,
      rubricVersion: result.rubricVersion,
      createdAt: now,
    }).run();
    // The placement seeds the learner row, so the next session starts at the
    // right difficulty instead of the default. It does NOT touch skill mastery:
    // self-report is not assessment evidence.
    d.update(learners).set({
      estimatedLevel: result.band,
      estimatedLevelConfidence: result.confidence,
      updatedAt: now,
    }).where(eq(learners.id, id)).run();
    return reply.code(201).send(result);
  });

  app.get("/v1/learners/:id/diagnostic", (req, reply) => {
    const { id } = req.params as { id: string };
    if (!hasLearner(d, id)) return reply.code(404).send({ error: "unknown learner" });
    const row = d.select().from(diagnostics)
      .where(eq(diagnostics.learnerId, id))
      .orderBy(desc(diagnostics.createdAt)).all()[0];
    // No diagnostic is a valid state: the learner simply has not done onboarding.
    if (!row) return reply.send({ diagnostic: null });
    return {
      diagnostic: {
        band: row.band, confidence: row.confidence, difficulty: row.difficulty,
        focusSkills: WORDS(row.focusSkills), basis: row.basis,
        rubricVersion: row.rubricVersion, createdAt: row.createdAt,
      },
    };
  });

  app.get("/v1/learners/:id/activity-attempts", (req, reply) => {
    const { id } = req.params as { id: string };
    if (!hasLearner(d, id)) return reply.code(404).send({ error: "unknown learner" });
    return d.select().from(activityAttempts)
      .where(eq(activityAttempts.learnerId, id))
      .orderBy(desc(activityAttempts.createdAt)).all()
      .map((a) => ({
        id: a.id, activityId: a.activityId, sessionId: a.sessionId,
        status: a.status as ActivityStatus,
        startedAt: a.startedAt, completedAt: a.completedAt,
        result: tryParseJson<unknown>(a.result),
      }));
  });
}

/**
 * One guided-speaking activity per objective, created on demand. Idempotent:
 * asking twice returns the same activity rather than piling up duplicates.
 */
function ensureGuidedActivity(d: DrizzleDb, learnerId: string, objective: {
  id: string; title: string; skillCodes: string; priority: number;
}): typeof activities.$inferSelect {
  const existing = d.select().from(activities)
    .where(and(eq(activities.learnerId, learnerId), eq(activities.type, "guided_speaking"))).all()
    .find((a) => WORDS(a.objectiveIds).includes(objective.id));
  if (existing) return existing;

  const skills = WORDS(objective.skillCodes);
  const primary = skills[0] ?? "fluency.continuity";
  const now = Date.now();
  const id = `act-${randomUUID()}`;
  // The words come from the learner's own vocabulary, taken from their real
  // sessions — never a list invented for the exercise. Ordered by the least
  // secure first, so the activity practises what is actually weak.
  const requiredWords = d.select().from(vocabularyItems)
    .where(eq(vocabularyItems.learnerId, learnerId)).all()
    .filter((v) => v.productionMastery < 0.8)
    .sort((a, b) => a.productionMastery - b.productionMastery)
    .slice(0, 5)
    .map((v) => v.word);

  d.insert(activities).values({
    id,
    learnerId,
    version: 1,
    type: "guided_speaking",
    title: `Guided speaking — ${objective.title}`,
    objectiveIds: JSON.stringify([objective.id]),
    targetSkillCodes: JSON.stringify(skills.length > 0 ? skills : [primary]),
    difficulty: Math.min(0.95, 0.3 + objective.priority * 0.5),
    estimatedMinutes: 3,
    inputModality: JSON.stringify(["audio"]),
    outputModality: JSON.stringify(["audio"]),
    rubricVersion: GUIDED_RUBRIC_VERSION,
    successCriteria: JSON.stringify({ requiredWords, targetSeconds: 90, skillCode: primary }),
    prompt: `Speak for about 90 seconds about: ${objective.title}. Keep going without stopping; the coach will listen and ask one follow-up.`,
    createdAt: now,
  }).run();
  return d.select().from(activities).where(eq(activities.id, id)).all()[0];
}

function toObjective(r: typeof learningObjectives.$inferSelect) {
  return {
    id: r.id, goalId: r.goalId, title: r.title, description: r.description,
    skillCodes: WORDS(r.skillCodes), priority: r.priority, status: r.status,
  };
}

function toActivity(r: typeof activities.$inferSelect) {
  const criteria = tryParseJson<{ requiredWords?: string[] }>(r.successCriteria);
  return {
    id: r.id, version: r.version, type: r.type, title: r.title,
    objectiveIds: WORDS(r.objectiveIds),
    targetSkillCodes: WORDS(r.targetSkillCodes),
    difficulty: r.difficulty,
    estimatedMinutes: r.estimatedMinutes,
    inputModality: WORDS(r.inputModality),
    outputModality: WORDS(r.outputModality),
    prompt: r.prompt,
    targetWords: criteria?.requiredWords ?? [],
    rubricVersion: r.rubricVersion,
    status: "ready" as ActivityStatus,
  };
}
