import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { jobs, jobAttempts, type DrizzleDb } from "@ec/db";
import type { SessionService } from "../services/session.js";
import type { BridgeRegistry } from "../realtime/bridge.js";

export interface SessionRouteDeps {
  service: SessionService;
  db: DrizzleDb;
  registry: BridgeRegistry;
  /** Enqueue an analysis job for a session. */
  queue: (type: "analyze", sessionId: string) => void;
  /** Re-queue an existing job that failed, so the operator can retry it. */
  retry: (type: "analyze", sessionId: string) => boolean;
}

export function registerSessionRoutes(app: FastifyInstance, deps: SessionRouteDeps): void {
  const { service, db, registry, queue, retry } = deps;

  app.post("/v1/learners/:id/sessions", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id !== "learner-1") return reply.code(404).send({ error: "unknown learner" });
    const created = service.createSession(id, Date.now());
    return reply.code(201).send({ sessionId: created.id, topic: created.topic, difficulty: created.difficulty, state: created.state });
  });

  app.get("/v1/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = service.getRecord(id);
    if (!record) return reply.code(404).send({ error: "unknown session" });
    const transcript = service.getTranscript(id);
    return { ...record, transcript };
  });

  app.post("/v1/sessions/:id/end", async (req, reply) => {
    const { id } = req.params as { id: string };
    const out = service.endSession(id, Date.now());
    if (!out.ok) return reply.code(409).send({ error: out.reason });
    // Tear the live bridge down: otherwise the provider session keeps running
    // while the DB row says ANALYZING (spec §5 "clean up provider/bridge
    // resources on completion"). `destroy` does not enqueue analysis, so the
    // job below is still enqueued exactly once.
    registry.get(id)?.destroy("ended_over_http");
    queue("analyze", id); // HTTP end path enqueues the analysis job (spec §11)
    return { state: "ANALYZING" };
  });

  /** Retry the analysis of a session whose job failed. */
  app.post("/v1/sessions/:id/analyze", async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = service.getRecord(id);
    if (!record) return reply.code(404).send({ error: "unknown session" });
    if (record.state === "COMPLETED") return reply.code(409).send({ error: "already_analyzed" });
    if (!retry("analyze", id)) {
      // No job row yet: enqueue a fresh one.
      queue("analyze", id);
    }
    return { state: "QUEUED", sessionId: id };
  });

  /** Failed jobs, newest first, with their attempt history. */
  app.get("/v1/jobs/failed", async () => {
    const failed = db.select().from(jobs)
      .where(eq(jobs.status, "failed"))
      .orderBy(desc(jobs.createdAt)).all();
    return failed.map((job) => ({
      id: job.id, type: job.type, sessionId: job.sessionId,
      attempts: job.attempts, error: job.error, createdAt: job.createdAt, doneAt: job.doneAt,
      history: db.select().from(jobAttempts)
        .where(and(eq(jobAttempts.jobId, job.id)))
        .all()
        .map((a) => ({
          attempt: a.attempt, status: a.status, errorClass: a.errorClass,
          error: a.error, startedAt: a.startedAt, finishedAt: a.finishedAt,
        })),
    }));
  });
}
