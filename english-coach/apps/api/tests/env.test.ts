import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "../src/env.js";

/** Runs `fn` with cwd pointed at a temp dir containing the given .env body. */
function withDotEnv(body: string, fn: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ec-env-"));
  try {
    writeFileSync(join(dir, ".env"), body, "utf8");
    const prev = process.cwd();
    process.chdir(dir);
    try { fn(); } finally { process.chdir(prev); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("loadEnv", () => {
  it("returns defaults when no .env file exists", () => {
    const e = loadEnv({});
    expect(e.PROVIDER).toBe("mock");
    expect(e.PORT).toBe(3100);
    expect(e.LLM_BASE_URL).toBe("http://localhost:11434/v1");
    expect(e.LLM_MODEL).toBe("llama3.2:3b");
    expect(e.LLM_API_KEY).toBe("");
    expect(e.WHISPER_MODEL).toBe("small");
    expect(e.PIPER_VOICE).toBe("en_US-ryan-medium");
    expect(e.PIPER_DATA_DIR).toBe("data/piper");
  });

  it("reads values from .env (the README's cp .env.example .env promise)", () => {
    withDotEnv("PROVIDER=local\nLLM_MODEL=qwen2.5:7b\nWHISPER_MODEL=base\n", () => {
      const e = loadEnv({});
      expect(e.PROVIDER).toBe("local");
      expect(e.LLM_MODEL).toBe("qwen2.5:7b");
      expect(e.WHISPER_MODEL).toBe("base");
    });
  });

  it("strips quotes and skips comments and blank lines", () => {
    withDotEnv('# a comment\n\nLLM_API_KEY="sk-from-file"\n', () => {
      expect(loadEnv({}).LLM_API_KEY).toBe("sk-from-file");
    });
  });

  it("process.env wins over .env", () => {
    withDotEnv("LLM_MODEL=from-file\n", () => {
      expect(loadEnv({ LLM_MODEL: "from-env" }).LLM_MODEL).toBe("from-env");
    });
  });
});