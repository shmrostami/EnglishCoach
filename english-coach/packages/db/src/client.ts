import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export type DrizzleDb = BetterSQLite3Database<typeof schema>;

export function openDb(dbPath: string): Database.Database {
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
