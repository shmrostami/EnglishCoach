import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./client.js";

describe("openDb", () => {
  it("creates the parent directory when it does not exist (cold server start)", () => {
    const root = mkdtempSync(join(tmpdir(), "ec-db-"));
    try {
      const dir = join(root, "nested", "data");
      expect(existsSync(dir)).toBe(false);
      const db = openDb(join(dir, "english-coach.db"));
      db.close();
      expect(existsSync(dir)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still opens :memory: without touching the filesystem", () => {
    const db = openDb(":memory:");
    expect(db.prepare("SELECT 1 AS x").get()).toEqual({ x: 1 });
    db.close();
  });
});
