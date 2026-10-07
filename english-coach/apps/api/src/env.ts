export interface Env {
  PORT: number;
  HOST: string;
  DB_PATH: string;
  PROVIDER: "mock" | "openai";
  OPENAI_API_KEY: string | undefined;
  WARMUP_MS: number;
  SESSION_TARGET_MS: number;
}

export function loadEnv(env: NodeJS.ProcessEnv = process.env): Env {
  return {
    PORT: Number(env.PORT ?? 3100),
    HOST: env.HOST ?? "127.0.0.1",
    DB_PATH: env.DB_PATH ?? "./data/english-coach.db",
    PROVIDER: (env.PROVIDER as "mock" | "openai") ?? "mock",
    OPENAI_API_KEY: env.OPENAI_API_KEY,
    WARMUP_MS: Number(env.WARMUP_MS ?? 120_000),
    SESSION_TARGET_MS: Number(env.SESSION_TARGET_MS ?? 900_000),
  };
}
