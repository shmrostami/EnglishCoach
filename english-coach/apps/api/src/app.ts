import Fastify from "fastify";
import { fastifyWebsocket } from "@fastify/websocket";
import type { SessionService } from "./services/session.js";
import type { Env } from "./env.js";
import { BridgeRegistry } from "./realtime/bridge.js";
import { registerWsRoutes } from "./routes/ws-session.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerLearnerRoutes } from "./routes/learners.js";
import { registerLearningRoutes } from "./routes/learning.js";
import { registerActivityRoutes } from "./routes/activities.js";
import type { SpeechConversationProvider } from "@ec/openai";
import type { DrizzleDb } from "@ec/db";
import { createLogger, type Logger } from "./logger.js";

export interface AppDeps {
  service: SessionService;
  db: DrizzleDb;
  registry: BridgeRegistry;
  selectSpeech: (sessionId: string) => SpeechConversationProvider;
  env: Env;
  queue: (type: "analyze", sessionId: string) => void;
  /** Re-queue an existing failed job. Returns false when there is no job row. */
  retry?: (type: "analyze", sessionId: string) => boolean;
  /** Drop a cached provider so the next session gets a fresh one. */
  releaseSpeech?: (sessionId: string) => void;
  logger?: Logger;
}

export async function buildApp(deps: AppDeps) {
  const app = Fastify({ logger: false });
  const log = deps.logger ?? createLogger();
  await app.register(fastifyWebsocket);
  registerSessionRoutes(app, {
    service: deps.service,
    db: deps.db,
    registry: deps.registry,
    queue: deps.queue,
    retry: deps.retry ?? (() => false),
  });
  registerLearnerRoutes(app, deps.db);
  registerLearningRoutes(app, deps.db);
  registerActivityRoutes(app, deps.db);
  registerWsRoutes(app, { ...deps, logger: log }); // deps includes queue; bridge enqueues analysis on client end
  return app;
}
