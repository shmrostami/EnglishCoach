import { describe, it, expect } from "vitest";
import { selectSpeechProvider, selectAnalysisProvider } from "../index.js";

describe("provider factory", () => {
  it("defaults to the mock provider", () => {
    expect(selectSpeechProvider({ PROVIDER: undefined }).constructor.name).toBe("MockSpeechProvider");
    expect(selectAnalysisProvider({ PROVIDER: "mock" }).constructor.name).toBe("MockAnalysisProvider");
  });

  it("refuses to build a real provider without a key (clear error, no partial start)", () => {
    expect(() => selectSpeechProvider({ PROVIDER: "openai" })).toThrow(/OPENAI_API_KEY/);
    expect(() => selectAnalysisProvider({ PROVIDER: "openai" })).toThrow(/OPENAI_API_KEY/);
  });

  it("builds real providers only when key AND PROVIDER=openai", () => {
    const speech = selectSpeechProvider({ PROVIDER: "openai", OPENAI_API_KEY: "sk-test" }, { turns: [] });
    expect(speech.constructor.name).toBe("OpenAISpeechProvider");
    const analysis = selectAnalysisProvider({ PROVIDER: "openai", OPENAI_API_KEY: "sk-test" });
    expect(analysis.constructor.name).toBe("OpenAIAnalysisProvider");
  });
});
