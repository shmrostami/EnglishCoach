import type { AnalysisProvider, SpeechConversationProvider } from "./providers/types.js";
import { MockSpeechProvider, MOCK_DEMO_SCRIPT, type MockTurn } from "./mock/speech.js";
import { MockAnalysisProvider } from "./mock/analysis.js";
import { OpenAISpeechProvider } from "./openai/speech.js";
import { OpenAIAnalysisProvider } from "./openai/analysis.js";

export * from "./providers/types.js";
export { MockSpeechProvider, MockAnalysisProvider, OpenAISpeechProvider, OpenAIAnalysisProvider, MOCK_DEMO_SCRIPT };
export type { MockTurn };
export { MODEL_CONFIG } from "./models.js";

export function selectSpeechProvider(
  env: { PROVIDER?: string; OPENAI_API_KEY?: string },
  script?: { turns: MockTurn[] },
): SpeechConversationProvider {
  if (env.PROVIDER === "openai") {
    if (!env.OPENAI_API_KEY) {
      throw new Error("PROVIDER=openai requires OPENAI_API_KEY (set PROVIDER=mock or export the key)");
    }
    return new OpenAISpeechProvider(env.OPENAI_API_KEY);
  }
  return new MockSpeechProvider(script ?? { turns: [] });
}

export function selectAnalysisProvider(
  env: { PROVIDER?: string; OPENAI_API_KEY?: string },
): AnalysisProvider {
  if (env.PROVIDER === "openai") {
    if (!env.OPENAI_API_KEY) {
      throw new Error("PROVIDER=openai requires OPENAI_API_KEY (set PROVIDER=mock or export the key)");
    }
    return new OpenAIAnalysisProvider(env.OPENAI_API_KEY);
  }
  return new MockAnalysisProvider();
}
