import { WebSocket } from "ws";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { BridgeRegistry, RealtimeBridge } from "../realtime/bridge.js";
import type { SessionService } from "../services/session.js";
import type { Env } from "../env.js";
import type { SpeechConversationProvider } from "@ec/openai";
import type { Logger } from "../logger.js";
import type { DrizzleDb } from "@ec/db";

export function registerWsRoutes(
  app: FastifyInstance,
  deps: {
    service: SessionService;
    /** The database, for the read-only tools the coach may call. */
    db: DrizzleDb;
    registry: BridgeRegistry;
    selectSpeech: (sessionId: string) => SpeechConversationProvider;
    env: Env;
    queue: (type: "analyze", sessionId: string) => void;
    /** Drop the cached provider for a session that is over. */
    releaseSpeech?: (sessionId: string) => void;
    logger?: Logger;
  },
): void {
  const log = deps.logger;
  app.get("/ws/session/:sessionId", { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    const sessionId = (req.params as { sessionId: string }).sessionId;
    const existing = deps.registry.get(sessionId);
    if (existing && existing.hasClient()) {
      socket.close(4000, "session already connected");
      return;
    }
    if (existing) {
      existing.attach(socket); // reconnect (Review Focus 4)
      log?.info("ws.reattach", { sessionId, correlationId: req.id });
      return;
    }
    const record = deps.service.getRecord(sessionId);
    if (!record || record.state !== "STARTING") {
      socket.close(4001, "session not in STARTING state");
      log?.warn("ws.reject", { sessionId, correlationId: req.id, reason: "not_starting" });
      return;
    }
    const provider = deps.selectSpeech(sessionId);
    const bridge = new RealtimeBridge({
      sessionId,
      provider,
      service: deps.service,
      // The read-only tools the coach may call (spec §8.3).
      db: deps.db,
      learnerId: record.learnerId,
      learnerContext: deps.service.getLearnerContext(sessionId),
      difficulty: record.plannedDifficulty,
      warmupMs: deps.env.WARMUP_MS,
      sessionTargetMs: deps.env.SESSION_TARGET_MS,
      onEnded: () => deps.queue("analyze", sessionId),
      onCleanup: () => {
        deps.registry.delete(sessionId);
        // The session is over: drop its cached provider so the map does not
        // grow one entry per session (defect C).
        deps.releaseSpeech?.(sessionId);
      },
    });
    deps.registry.set(sessionId, bridge);
    bridge.attach(socket);
    log?.info("ws.attach", { sessionId, correlationId: req.id });
    // On client close the bridge stays alive (reconnect window); the provider
    // closing or the session ending tears it down and the registry entry is
    // removed inside bridge.finish via a registry delete callback (see below).
  });
}
