import { loadEnv } from "./env.js";
import { openDb, db, migrate, ensureSeed, jobs } from "@ec/db";
import { SessionService } from "./services/session.js";
import { BridgeRegistry } from "./realtime/bridge.js";
import { buildApp, type AppDeps } from "./app.js";
import { selectSpeechProvider, type SpeechConversationProvider } from "@ec/openai";
import { startJobRunner } from "./workers/stopgap.js"; // this file is deleted in Task 7, which adds workers/jobs.ts with retry/backoff
import { randomUUID } from "node:crypto";

async function main() {
  const env = loadEnv();
  const sqlite = openDb(env.DB_PATH);
  migrate(sqlite);
  ensureSeed(sqlite);
  const d = db(sqlite);
  const service = new SessionService(d);
  const registry = new BridgeRegistry();
  const speechProviders = new Map<string, SpeechConversationProvider>();
  const queue: AppDeps["queue"] = (type, sessionId) => {
    try {
      d.insert(jobs).values({
        id: `job-${randomUUID()}`, type, sessionId,
        status: "pending", attempts: 0, maxAttempts: 3,
        nextRunAt: null, createdAt: Date.now(),
      }).run();
    } catch {
      // UNIQUE(session_id, type) — duplicate enqueue is a no-op
    }
  };
  const app = await buildApp({
    service, db: d, registry, env, queue,
    selectSpeech: (sessionId) => {
      const existing = speechProviders.get(sessionId);
      if (existing) return existing;
      const p = selectSpeechProvider({ PROVIDER: env.PROVIDER, OPENAI_API_KEY: env.OPENAI_API_KEY });
      speechProviders.set(sessionId, p);
      return p;
    },
  });
  startJobRunner(d, queue); // stopgap in Task 6b; replaced by JobRunner in Task 7
  await app.listen({ port: env.PORT, host: env.HOST });
  console.log(`english-coach api on ${env.HOST}:${env.PORT} (provider=${env.PROVIDER})`);
}
main();
