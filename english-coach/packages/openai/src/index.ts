import type { AnalysisProvider, SpeechConversationProvider } from "./providers/types.js";
import { MockSpeechProvider, type MockTurn } from "./mock/speech.js";
import { MockAnalysisProvider } from "./mock/analysis.js";

export * from "./providers/types.js";
export { MockSpeechProvider, MockAnalysisProvider };
export type { MockTurn };

export function selectSpeechProvider(
  env: { PROVIDER?: string; OPENAI_API_KEY?: string },
  script?: { turns: MockTurn[] },
): SpeechConversationProvider {
  if (env.PROVIDER === "openai" && env.OPENAI_API_KEY) {
    // Real branch lands in Task 10. Until then this combination is a config error.
    throw new Error("Realtime provider not configured for this build; set PROVIDER=mock");
  }
  return new MockSpeechProvider(script ?? { turns: [] });
}

export function selectAnalysisProvider(
  env: { PROVIDER?: string; OPENAI_API_KEY?: string },
): AnalysisProvider {
  if (env.PROVIDER === "openai" && env.OPENAI_API_KEY) {
    throw new Error("Real analysis provider not configured for this build; set PROVIDER=mock");
  }
  return new MockAnalysisProvider();
}
