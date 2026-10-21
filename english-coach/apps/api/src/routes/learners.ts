import type { FastifyInstance } from "fastify";
import { eq, and, desc } from "drizzle-orm";
import { learners, goalsTable, skills, learningPlans, sessions, tryParseJson, type DrizzleDb } from "@ec/db";
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

  app.get("/v1/learners/:id/goals", (req) => {
    const { id } = req.params as { id: string };
    return d.select().from(goalsTable).where(eq(goalsTable.learnerId, id)).all();
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
