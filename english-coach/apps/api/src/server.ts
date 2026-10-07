import { loadEnv } from "./env.js";
import { openDb, db, migrate, ensureSeed } from "@ec/db";
import { SessionService } from "./services/session.js";
import { BridgeRegistry } from "./realtime/bridge.js";
import { buildApp, type AppDeps } from "./app.js";
import { selectSpeechProvider, selectAnalysisProvider, type SpeechConversationProvider, MOCK_DEMO_SCRIPT } from "@ec/openai";
import { JobRunner } from "./workers/jobs.js";
import { runAnalysis } from "./workers/analysis.js";
import { runPlanner } from "./workers/planner.js";

async function main() {
  const env = loadEnv();
  const sqlite = openDb(env.DB_PATH);
  migrate(sqlite);
  ensureSeed(sqlite);
  const d = db(sqlite);
  const service = new SessionService(d);
  const registry = new BridgeRegistry();
  const speechProviders = new Map<string, SpeechConversationProvider>();
  const speechAnalysis = selectAnalysisProvider({ PROVIDER: env.PROVIDER, OPENAI_API_KEY: env.OPENAI_API_KEY });
  const runner = new JobRunner({
    db: d,
    handle: async (job) => {
      if (job.sessionId === null) return;
      if (job.type === "analyze") {
        await runAnalysis({ db: d, provider: speechAnalysis, sessionId: job.sessionId, now: Date.now() });
      } else {
        await runPlanner({ db: d, provider: speechAnalysis, sessionId: job.sessionId, now: Date.now() });
      }
    },
  });
  const queue: AppDeps["queue"] = (type, sessionId) => runner.enqueue(type, sessionId);
  runner.start();
  const app = await buildApp({
    service, db: d, registry, env, queue,
    selectSpeech: (sessionId) => {
      const existing = speechProviders.get(sessionId);
      if (existing) return existing;
      // In mock mode the "learner" is a scripted dialogue (MOCK_DEMO_SCRIPT), so
      // the full Speak→Observe→Diagnose→Remember→Adapt loop runs end-to-end with
      // no API key — the README's promise. selectSpeechProvider only consults the
      // script when PROVIDER=mock; for openai the third arg is ignored.
      const p = selectSpeechProvider(
        { PROVIDER: env.PROVIDER, OPENAI_API_KEY: env.OPENAI_API_KEY },
        env.PROVIDER === "mock" ? MOCK_DEMO_SCRIPT : undefined,
      );
      speechProviders.set(sessionId, p);
      return p;
    },
  });
  await app.listen({ port: env.PORT, host: env.HOST });
  console.log(`english-coach api on ${env.HOST}:${env.PORT} (provider=${env.PROVIDER})`);
}
main();
