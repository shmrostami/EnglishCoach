import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDb, db } from "./client.js";
import { ensureSeed } from "./seed.js";
import { learners, goalsTable } from "./schema.js";
import type { Database } from "better-sqlite3";

const SCHEMA_SQL = readFileSync(
  fileURLToPath(new URL("./schema.sql", import.meta.url)), "utf8",
);

let database: Database;

beforeAll(() => {
  database = openDb(":memory:");
  database.exec(SCHEMA_SQL);
  ensureSeed(database);
});

describe("seed", () => {
  it("creates exactly one learner", () => {
    const rows = db(database).select().from(learners).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("learner-1");
    expect(rows[0].targetLanguage).toBe("en");
  });
  it("creates three goals with expected types and priorities", () => {
    const rows = db(database).select().from(goalsTable).all();
    expect(rows).toHaveLength(3);
    const byType = Object.fromEntries(rows.map((g) => [g.type, g.priority]));
    expect(byType).toEqual({ fluency: 0.9, grammar: 0.7, vocabulary: 0.6 });
  });
  it("is idempotent", () => {
    ensureSeed(database);
    expect(db(database).select().from(learners).all()).toHaveLength(1);
  });
});
