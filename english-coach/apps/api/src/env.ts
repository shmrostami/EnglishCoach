import { readFileSync } from "node:fs";

export interface Env {
  PORT: number;
  HOST: string;
  DB_PATH: string;
  PROVIDER: "mock" | "openai" | "local";
  OPENAI_API_KEY: string | undefined;
  WARMUP_MS: number;
  SESSION_TARGET_MS: number;
  LLM_BASE_URL?: string;
  LLM_MODEL?: string;
  LLM_API_KEY?: string;
  WHISPER_MODEL?: string;
  PIPER_VOICE?: string;
  PIPER_DATA_DIR?: string;
  PYTHON?: string;
}

/**
 * Minimal .env loader (no dependency): KEY=VALUE lines, `#` comments,
 * optional single/double quotes. Files that don't exist are a no-op;
 * real process.env values always win.
 */
function mergeDotEnv(path: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return env;
  }
  const fromFile: NodeJS.ProcessEnv = {};
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    fromFile[key] = val;
  }
  return { ...fromFile, ...env };
}

export function loadEnv(env: NodeJS.ProcessEnv = process.env): Env {
  const e = mergeDotEnv(".env", env);
  return {
    PORT: Number(e.PORT ?? 3100),
    HOST: e.HOST ?? "127.0.0.1",
    DB_PATH: e.DB_PATH ?? "./data/english-coach.db",
    PROVIDER: (e.PROVIDER as Env["PROVIDER"]) ?? "mock",
    OPENAI_API_KEY: e.OPENAI_API_KEY,
    WARMUP_MS: Number(e.WARMUP_MS ?? 120_000),
    SESSION_TARGET_MS: Number(e.SESSION_TARGET_MS ?? 900_000),
    LLM_BASE_URL: e.LLM_BASE_URL ?? "http://localhost:11434/v1",
    LLM_MODEL: e.LLM_MODEL ?? "llama3.2:3b",
    LLM_API_KEY: e.LLM_API_KEY ?? "",
    WHISPER_MODEL: e.WHISPER_MODEL ?? "small",
    PIPER_VOICE: e.PIPER_VOICE ?? "en_US-ryan-medium",
    PIPER_DATA_DIR: e.PIPER_DATA_DIR ?? "data/piper",
    PYTHON: e.PYTHON ?? "python",
  };
}
