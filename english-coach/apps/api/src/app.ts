import Fastify from "fastify";
import { fastifyWebsocket } from "@fastify/websocket";
import type { SessionService } from "./services/session.js";
import type { Env } from "./env.js";
import { BridgeRegistry } from "./realtime/bridge.js";
import { registerWsRoutes } from "./routes/ws-session.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerLearnerRoutes } from "./routes/learners.js";
import type { SpeechConversationProvider } from "@ec/openai";
import type { DrizzleDb } from "@ec/db";

export interface AppDeps {
  service: SessionService;
  db: DrizzleDb;
  registry: BridgeRegistry;
  selectSpeech: (sessionId: string) => SpeechConversationProvider;
  env: Env;
  queue: (type: "analyze", sessionId: string) => void;
}

export async function buildApp(deps: AppDeps) {
  const app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  registerSessionRoutes(app, deps.service, deps.queue);
  registerLearnerRoutes(app, deps.db);
  registerWsRoutes(app, deps); // deps includes queue; bridge enqueues analysis on client end
  return app;
}
