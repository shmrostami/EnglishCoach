import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

export function migrate(database: Database.Database): void {
  const sql = readFileSync(fileURLToPath(new URL("./schema.sql", import.meta.url)), "utf8");
  database.exec(sql.replace(/CREATE TABLE/g, "CREATE TABLE IF NOT EXISTS"));
}
