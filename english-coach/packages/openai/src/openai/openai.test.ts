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

  it("builds LocalSpeechProvider when PROVIDER=local (no key required)", () => {
    const p = selectSpeechProvider({ PROVIDER: "local", PYTHON: "python" });
    expect(p.constructor.name).toBe("LocalSpeechProvider");
    p.close(); // the constructor spawns a real Python sidecar — close it or its child + 180 s ready-timer keep the test worker alive
  });

  it("local works with empty/absent LLM_API_KEY (Ollama ignores auth)", () => {
    const p = selectSpeechProvider({ PROVIDER: "local", LLM_API_KEY: "" });
    expect(p).toBeTruthy();
    p.close(); // ditto — release the spawned sidecar before the test ends
  });

  it("mock and openai selection are unchanged by the local branch", () => {
    expect(selectSpeechProvider({ PROVIDER: "mock" }).constructor.name).toBe("MockSpeechProvider");
    expect(selectSpeechProvider({ PROVIDER: "openai", OPENAI_API_KEY: "sk-x" }).constructor.name).toBe("OpenAISpeechProvider");
  });
});
