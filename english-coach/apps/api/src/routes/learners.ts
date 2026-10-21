import type { FastifyInstance } from "fastify";
import { eq, and, desc } from "drizzle-orm";
import {
  learners, goalsTable, skills, learningPlans, sessions, goalMilestones, tryParseJson, type DrizzleDb,
} from "@ec/db";
import { computeTrend, estimateLevel, milestoneMet, suggestMilestones } from "@ec/learning-engine";
import { randomUUID } from "node:crypto";

export function registerLearnerRoutes(app: FastifyInstance, d: DrizzleDb): void {
  app.get("/v1/learners/:id", (req, reply) => {
    const { id } = req.params as { id: string };
    const row = d.select().from(learners).where(eq(learners.id, id)).all()[0];
    if (!row) return reply.code(404).send({ error: "unknown learner" });
    return {
      id: row.id, nativeLanguage: row.nativeLanguage, targetLanguage: row.targetLanguage,
      targetLevel: row.targetLevel, estimatedLevel: row.estimatedLevel,
      estimatedLevelConfidence: row.estimatedLevelConfidence,
      correctionStyle: row.correctionStyle, preferredSessionMinutes: row.preferredSessionMinutes,
    };
  });

  app.get("/v1/learners/:id/skills", (req, reply) => {
    const { id } = req.params as { id: string };
    return d.select().from(skills).where(eq(skills.learnerId, id)).all();
  });

  app.get("/v1/learners/:id/learning-plan", (req, reply) => {
    const { id } = req.params as { id: string };
    const plan = d.select().from(learningPlans)
      .where(and(eq(learningPlans.learnerId, id), eq(learningPlans.status, "active")))
      .orderBy(desc(learningPlans.createdAt)).all()[0];
    // No plan is a valid empty state, not an error: the dashboard must load for
    // a learner who has never completed a session (spec §5).
    if (!plan) return reply.type("application/json").send("null");
    return {
      id: plan.id, difficulty: plan.difficulty,
      primaryTargets: tryParseJson<string[]>(plan.primaryTargets) ?? [],
      secondaryTargets: tryParseJson<string[]>(plan.secondaryTargets) ?? [],
      interventionType: plan.interventionType, topic: plan.topic,
      reasoning: plan.reasoning, status: plan.status, createdAt: plan.createdAt,
    };
  });

  app.get("/v1/learners/:id/progress", (req, reply) => {
    const { id } = req.params as { id: string };
    const rows = d.select().from(sessions)
      .where(and(eq(sessions.learnerId, id), eq(sessions.status, "COMPLETED")))
      .orderBy(desc(sessions.startedAt)).all().slice(0, 10).reverse();
    return rows.map((s) => ({
      id: s.id, startedAt: s.startedAt, topic: s.topic,
      scores: {
        fluency: s.fluencyScore, grammar: s.grammarScore, vocabulary: s.vocabularyScore,
        pronunciation: s.pronunciationScore, coherence: s.coherenceScore, interaction: s.interactionScore,
      },
      overall: s.overallScore,
    }));
  });

  /**
   * Level history (spec §11.1 Progress: "skill history, evidence-backed
   * trends"). `progress` stops at ten sessions; this answers the longer
   * question — where the level and each dimension have actually moved.
   *
   * A dimension is only included in the trend when it has at least two
   * assessed sessions; an unmeasured dimension reports `null`, not a flat line
   * drawn through nulls (spec §3 principle 7).
   */
  app.get("/v1/learners/:id/level-history", (req, reply) => {
    const { id } = req.params as { id: string };
    if (!d.select().from(learners).where(eq(learners.id, id)).all()[0]) {
      return reply.code(404).send({ error: "unknown learner" });
    }
    const rows = d.select().from(sessions)
      .where(and(eq(sessions.learnerId, id), eq(sessions.status, "COMPLETED")))
      .orderBy(sessions.startedAt).all();

    const scores = rows.map((s) => ({
      sessionId: s.id,
      startedAt: s.startedAt,
      overall: s.overallScore,
      fluency: s.fluencyScore,
      grammar: s.grammarScore,
      vocabulary: s.vocabularyScore,
      pronunciation: s.pronunciationScore,
      coherence: s.coherenceScore,
      interaction: s.interactionScore,
    }));

    const dimensions = ["fluency", "grammar", "vocabulary", "pronunciation", "coherence", "interaction"] as const;
    return {
      sessions: scores.length,
      history: scores,
      trends: Object.fromEntries(dimensions.map((dim) => {
        const assessed = scores.map((s) => s[dim]).filter((v): v is number => v !== null);
        // Two points make a direction; one is a sample, none is unmeasured.
        return [dim, assessed.length < 2 ? null : computeTrend(assessed)];
      })),
      // The level itself is a longitudinal estimate, so its history is the
      // estimate recomputed at each point rather than a stored per-session value.
      levels: scores.map((s, i) => {
        const cumulative = scores.slice(0, i + 1).map((x) => x.overall ?? 0).filter(Boolean);
        const mean = cumulative.reduce((a, b) => a + b, 0) / Math.max(1, cumulative.length);
        return { sessionId: s.sessionId, startedAt: s.startedAt, ...estimateLevel(mean, i + 1) };
      }),
    };
  });

  app.get("/v1/learners/:id/goals", (req) => {
    const { id } = req.params as { id: string };
    return d.select().from(goalsTable).where(eq(goalsTable.learnerId, id)).all();
  });

  /**
   * A goal's milestones (spec §6.1). `suggested` is computed from the learner's
   * real weak skills for this goal type, so decomposition starts from evidence
   * rather than an empty list.
   */
  app.get("/v1/learners/:id/goals/:goalId/milestones", (req, reply) => {
    const { id, goalId } = req.params as { id: string; goalId: string };
    const goal = d.select().from(goalsTable)
      .where(and(eq(goalsTable.id, goalId), eq(goalsTable.learnerId, id))).all()[0];
    if (!goal) return reply.code(404).send({ error: "goal not found" });

    // Re-check every milestone against current mastery, so a status is never
    // stale relative to the evidence that decides it.
    const rows = d.select().from(goalMilestones).where(eq(goalMilestones.goalId, goalId)).all();
    const skillRows = d.select().from(skills).where(eq(skills.learnerId, id)).all();
    const masteryOf = new Map(skillRows.map((s) => [s.code, s.mastery]));
    for (const m of rows) {
      if (milestoneMet(m, masteryOf.get(m.targetSkillCode ?? "")) && m.status !== "achieved") {
        d.update(goalMilestones).set({ status: "achieved", achievedAt: Date.now() })
          .where(eq(goalMilestones.id, m.id)).run();
      }
    }
    const current = d.select().from(goalMilestones).where(eq(goalMilestones.goalId, goalId)).all();
    const suggested = suggestMilestones(
      goal.type,
      skillRows.map((s) => ({ code: s.code, mastery: s.mastery })),
    ).filter((sug) => !current.some((m) => m.targetSkillCode === sug.targetSkillCode));

    return {
      milestones: current.map((m) => ({
        id: m.id, title: m.title, description: m.description,
        targetSkillCode: m.targetSkillCode, targetMastery: m.targetMastery,
        status: m.status, dueAt: m.dueAt, achievedAt: m.achievedAt,
      })),
      suggested,
    };
  });

  app.post("/v1/learners/:id/goals/:goalId/milestones", (req, reply) => {
    const { id, goalId } = req.params as { id: string; goalId: string };
    const goal = d.select().from(goalsTable)
      .where(and(eq(goalsTable.id, goalId), eq(goalsTable.learnerId, id))).all()[0];
    if (!goal) return reply.code(404).send({ error: "goal not found" });
    const body = (req.body ?? {}) as {
      title?: string; description?: string;
      targetSkillCode?: string; targetMastery?: number;
    };
    if (!body.title) return reply.code(400).send({ error: "title is required" });
    if (body.targetMastery !== undefined && (body.targetMastery < 0 || body.targetMastery > 1)) {
      return reply.code(400).send({ error: "targetMastery must be between 0 and 1" });
    }
    const milestoneId = `ms-${randomUUID()}`;
    d.insert(goalMilestones).values({
      id: milestoneId, goalId, title: body.title,
      description: body.description ?? null,
      targetSkillCode: body.targetSkillCode ?? null,
      targetMastery: body.targetMastery ?? null,
      status: "planned", createdAt: Date.now(),
    }).run();
    return reply.code(201).send({ id: milestoneId });
  });

  app.post("/v1/learners/:id/goals", (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { type: string; description: string; priority?: number };
    if (!body?.type || !body?.description) return reply.code(400).send({ error: "type and description required" });
    const goalId = `goal-${randomUUID()}`;
    d.insert(goalsTable).values({
      id: goalId, learnerId: id, type: body.type, description: body.description,
      priority: body.priority ?? 0.5, status: "active", createdAt: Date.now(),
    }).run();
    return reply.code(201).send({ id: goalId });
  });

  app.patch("/v1/learners/:id/goals/:goalId", (req, reply) => {
    const { id, goalId } = req.params as { id: string; goalId: string };
    const body = req.body as Partial<{ priority: number; status: string; description: string }>;
    const patch: Record<string, unknown> = {};
    if (typeof body.priority === "number") patch.priority = body.priority;
    if (body.description) patch.description = body.description;
    if (body.status === "active" || body.status === "completed") {
      patch.status = body.status;
      if (body.status === "completed") patch.completedAt = Date.now();
    }
    const res = d.update(goalsTable).set(patch as never)
      .where(and(eq(goalsTable.id, goalId), eq(goalsTable.learnerId, id))).run();
    if (res.changes === 0) return reply.code(404).send({ error: "goal not found" });
    return { ok: true };
  });
}
