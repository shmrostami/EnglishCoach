import type { AnalysisProvider, SpeechConversationProvider } from "./providers/types.js";
import { MockSpeechProvider, MOCK_DEMO_SCRIPT, type MockTurn } from "./mock/speech.js";
import { MockAnalysisProvider } from "./mock/analysis.js";
import { OpenAISpeechProvider } from "./openai/speech.js";
import { OpenAIAnalysisProvider } from "./openai/analysis.js";
import { LocalSpeechProvider } from "./local/speech.js";
import { LocalAnalysisProvider } from "./local/analysis.js";
import { VoiceSidecar } from "./local/sidecar.js";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sidecarScriptPath = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "voice_sidecar.py");

export * from "./providers/types.js";
export { MockSpeechProvider, MockAnalysisProvider, OpenAISpeechProvider, OpenAIAnalysisProvider, MOCK_DEMO_SCRIPT, LocalSpeechProvider, LocalAnalysisProvider };
export type { MockTurn };
export { MODEL_CONFIG } from "./models.js";

export function selectSpeechProvider(
  env: {
    PROVIDER?: string;
    OPENAI_API_KEY?: string;
    LLM_BASE_URL?: string;
    LLM_MODEL?: string;
    LLM_API_KEY?: string;
    WHISPER_MODEL?: string;
    PIPER_VOICE?: string;
    PIPER_DATA_DIR?: string;
    TTS_ENGINE?: string;
    KOKORO_VOICE?: string;
    KOKORO_DATA_DIR?: string;
    PYTHON?: string;
  },
  script?: { turns: MockTurn[] },
): SpeechConversationProvider {
  if (env.PROVIDER === "local") {
    if (!existsSync(sidecarScriptPath)) {
      throw new Error(`PROVIDER=local: voice_sidecar.py not found at ${sidecarScriptPath}`);
    }
    const sidecar = new VoiceSidecar({
      python: env.PYTHON ?? "python",
      script: sidecarScriptPath,
      env: {
        WHISPER_MODEL: env.WHISPER_MODEL ?? "small",
        PIPER_VOICE: env.PIPER_VOICE ?? "en_US-ryan-medium",
        PIPER_DATA_DIR: env.PIPER_DATA_DIR ?? "data/piper",
        TTS_ENGINE: env.TTS_ENGINE ?? "piper",
        KOKORO_VOICE: env.KOKORO_VOICE ?? "af_heart",
        KOKORO_DATA_DIR: env.KOKORO_DATA_DIR ?? "data/kokoro",
      },
    });
    return new LocalSpeechProvider({
      llmBaseURL: env.LLM_BASE_URL ?? "http://localhost:11434/v1",
      llmModel: env.LLM_MODEL ?? "llama3.2:3b",
      llmApiKey: env.LLM_API_KEY ?? "",
      sidecar,
    });
  }
  if (env.PROVIDER === "openai") {
    if (!env.OPENAI_API_KEY) {
      throw new Error("PROVIDER=openai requires OPENAI_API_KEY (set PROVIDER=mock or export the key)");
    }
    return new OpenAISpeechProvider(env.OPENAI_API_KEY);
  }
  return new MockSpeechProvider(script ?? { turns: [] });
}

export function selectAnalysisProvider(
  env: {
    PROVIDER?: string;
    OPENAI_API_KEY?: string;
    LLM_BASE_URL?: string;
    LLM_MODEL?: string;
    LLM_API_KEY?: string;
  },
): AnalysisProvider {
  if (env.PROVIDER === "openai") {
    if (!env.OPENAI_API_KEY) {
      throw new Error("PROVIDER=openai requires OPENAI_API_KEY (set PROVIDER=mock or export the key)");
    }
    return new OpenAIAnalysisProvider(env.OPENAI_API_KEY);
  }
  // `local` scores with the same local model the conversation uses. The mock
  // lexicon is only for mock mode: its numbers have no relationship to what the
  // learner said, and scoring a real conversation with them would be invented
  // measurement (spec §3 principle 7).
  if (env.PROVIDER === "local") {
    return new LocalAnalysisProvider({
      baseURL: env.LLM_BASE_URL ?? "http://localhost:11434/v1",
      model: env.LLM_MODEL ?? "llama3.2:3b",
      apiKey: env.LLM_API_KEY ?? "",
    });
  }
  return new MockAnalysisProvider();
}
