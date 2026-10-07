import type { FastifyInstance } from "fastify";
import type { SessionService } from "../services/session.js";

export function registerSessionRoutes(
  app: FastifyInstance,
  service: SessionService,
  queue: (type: "analyze", sessionId: string) => void,
): void {
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
    queue("analyze", id); // HTTP end path enqueues the analysis job (spec §11)
    return { state: "ANALYZING" };
  });
}
