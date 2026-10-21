import { loadEnv } from "./env.js";
import { openDb, db, migrate, ensureSeed } from "@ec/db";
import { SessionService } from "./services/session.js";
import { BridgeRegistry } from "./realtime/bridge.js";
import { buildApp, type AppDeps } from "./app.js";
import { selectSpeechProvider, selectAnalysisProvider, type SpeechConversationProvider, MOCK_DEMO_SCRIPT } from "@ec/openai";
import { JobRunner } from "./workers/jobs.js";
import { runAnalysis } from "./workers/analysis.js";
import { runPlanner } from "./workers/planner.js";
import { createLogger } from "./logger.js";

async function main() {
  const env = loadEnv();
  const logger = createLogger({ base: { service: "api" } });
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
    onFailed: (job, error) => {
      // A job that gave up must not leave its session stuck in ANALYZING
      // (spec §5: worker failures reach a terminal failure state).
      logger.error("job.failed", { jobId: job.id, type: job.type, sessionId: job.sessionId, errorClass: error.class, error: error.message });
      if (job.type === "analyze" && job.sessionId) {
        service.failSession(job.sessionId, Date.now());
      }
    },
  });
  const queue: AppDeps["queue"] = (type, sessionId) => runner.enqueue(type, sessionId);
  const retry: AppDeps["retry"] = (type, sessionId) => runner.reset(type, sessionId);
  // The provider cache is per session; a finished session's provider must not
  // stay in memory forever (defect C).
  const releaseSpeech: AppDeps["releaseSpeech"] = (sessionId) => {
    speechProviders.delete(sessionId);
  };
  runner.start();
  const app = await buildApp({
    service, db: d, registry, env, queue, retry, releaseSpeech,
    logger,
    selectSpeech: (sessionId) => {
      const existing = speechProviders.get(sessionId);
      if (existing) return existing;
      // In mock mode the "learner" is a scripted dialogue (MOCK_DEMO_SCRIPT), so
      // the full Speak→Observe→Diagnose→Remember→Adapt loop runs end-to-end with
      // no API key — the README's promise. selectSpeechProvider only consults the
      // script when PROVIDER=mock; for openai the third arg is ignored.
      const p = selectSpeechProvider(
        {
          PROVIDER: env.PROVIDER,
          OPENAI_API_KEY: env.OPENAI_API_KEY,
          LLM_BASE_URL: env.LLM_BASE_URL,
          LLM_MODEL: env.LLM_MODEL,
          LLM_API_KEY: env.LLM_API_KEY,
          WHISPER_MODEL: env.WHISPER_MODEL,
          PIPER_VOICE: env.PIPER_VOICE,
          PIPER_DATA_DIR: env.PIPER_DATA_DIR,
          TTS_ENGINE: env.TTS_ENGINE,
          KOKORO_VOICE: env.KOKORO_VOICE,
          KOKORO_DATA_DIR: env.KOKORO_DATA_DIR,
          PYTHON: env.PYTHON,
        },
        env.PROVIDER === "mock" ? MOCK_DEMO_SCRIPT : undefined,
      );
      speechProviders.set(sessionId, p);
      return p;
    },
  });
  await app.listen({ port: env.PORT, host: env.HOST });
  logger.info("server.listening", { host: env.HOST, port: env.PORT, provider: env.PROVIDER });
}
main();
