import { WebSocket } from "ws";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { BridgeRegistry, RealtimeBridge } from "../realtime/bridge.js";
import type { SessionService } from "../services/session.js";
import type { Env } from "../env.js";
import type { SpeechConversationProvider } from "@ec/openai";

export function registerWsRoutes(
  app: FastifyInstance,
  deps: { service: SessionService; registry: BridgeRegistry; selectSpeech: (sessionId: string) => SpeechConversationProvider; env: Env; queue: (type: "analyze", sessionId: string) => void },
): void {
  app.get("/ws/session/:sessionId", { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    const sessionId = (req.params as { sessionId: string }).sessionId;
    const existing = deps.registry.get(sessionId);
    if (existing && existing.hasClient()) {
      socket.close(4000, "session already connected");
      return;
    }
    if (existing) {
      existing.attach(socket); // reconnect (Review Focus 4)
      return;
    }
    const record = deps.service.getRecord(sessionId);
    if (!record || record.state !== "STARTING") {
      socket.close(4001, "session not in STARTING state");
      return;
    }
    const provider = deps.selectSpeech(sessionId);
    const bridge = new RealtimeBridge({
      sessionId,
      provider,
      service: deps.service,
      learnerContext: deps.service.getLearnerContext(sessionId),
      difficulty: record.plannedDifficulty,
      warmupMs: deps.env.WARMUP_MS,
      sessionTargetMs: deps.env.SESSION_TARGET_MS,
      onEnded: () => deps.queue("analyze", sessionId),
      onCleanup: () => deps.registry.delete(sessionId),
    });
    deps.registry.set(sessionId, bridge);
    bridge.attach(socket);
    // On client close the bridge stays alive (reconnect window); the provider
    // closing or the session ending tears it down and the registry entry is
    // removed inside bridge.finish via a registry delete callback (see below).
  });
}
