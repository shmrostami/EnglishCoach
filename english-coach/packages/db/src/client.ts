import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as schema from "./schema.js";

export type DrizzleDb = BetterSQLite3Database<typeof schema>;

export function openDb(dbPath: string): Database.Database {
  // better-sqlite3 refuses to open a file whose parent directory does not
  // exist; the server resolves DB_PATH (default ./data/english-coach.db)
  // relative to its own cwd, so a cold start crashes without this.
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const database = new Database(dbPath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  return database;
}

export function db(database: Database.Database): DrizzleDb {
  return drizzle(database, { schema });
}

export function parseJson<T>(s: string | null): T | null {
  return s === null ? null : (JSON.parse(s) as T);
}
