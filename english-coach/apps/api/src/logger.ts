/**
 * A minimal structured logger: one JSON object per line on stdout.
 *
 * Every line carries a correlation id so a request, its session and the worker
 * job it spawned can be traced together (spec §5 "structured logs, correlation
 * IDs, and worker failure visibility").
 */

import { randomUUID } from "node:crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  level?: LogLevel;
  base?: LogFields;
  /** Sink for the rendered lines. Defaults to stdout. */
  write?: (line: string) => void;
  /** Clock, injectable for tests. */
  now?: () => number;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? "info";
  const base = opts.base ?? {};
  const write = opts.write ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  const now = opts.now ?? (() => Date.now());

  function make(scope: LogFields): Logger {
    const emit = (lvl: LogLevel, msg: string, fields?: LogFields) => {
      if (LEVELS[lvl] < LEVELS[level]) return;
      const line = JSON.stringify({ ts: new Date(now()).toISOString(), level: lvl, msg, ...scope, ...(fields ?? {}) });
      write(line);
    };
    return {
      debug: (m, f) => emit("debug", m, f),
      info: (m, f) => emit("info", m, f),
      warn: (m, f) => emit("warn", m, f),
      error: (m, f) => emit("error", m, f),
      child: (fields) => make({ ...scope, ...fields }),
    };
  }

  return make(base);
}

/** Correlation id for one unit of work: a request, a session, a job. */
export function correlationId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}
