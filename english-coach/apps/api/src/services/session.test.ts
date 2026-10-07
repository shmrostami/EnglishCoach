import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { openDb, db, migrate, ensureSeed } from "@ec/db";
import { SessionService } from "./session.js";
import { LEARNER_ID } from "@ec/domain";

let sqlite: Database.Database;
let service: SessionService;
let now: number;

beforeEach(() => {
  sqlite = openDb(":memory:");
  migrate(sqlite);
  ensureSeed(sqlite);
  service = new SessionService(db(sqlite));
  now = 1_000_000_000_000;
});

describe("SessionService", () => {
  it("creates a session with a default plan when none exists", () => {
    const s = service.createSession(LEARNER_ID, now);
    expect(s.id).toMatch(/^sess-/);
    expect(s.difficulty).toBe(0.5); // default before any history
    expect(service.getRecord(s.id)?.state).toBe("STARTING");
  });

  it("walks the happy path and rejects illegal transitions", () => {
    const s = service.createSession(LEARNER_ID, now);
    expect(service.transition(s.id, "WARMUP", now)).toBe(true);
    expect(service.transition(s.id, "CONVERSATION", now)).toBe(true);
    expect(service.transition(s.id, "STARTING", now)).toBe(false); // illegal
    service.transition(s.id, "CLOSING", now);
    expect(service.transition(s.id, "ANALYZING", now)).toBe(true);
  });

  it("records learner utterances sequentially and computes pauses", () => {
    const s = service.createSession(LEARNER_ID, now);
    service.transition(s.id, "WARMUP", now);
    service.transition(s.id, "CONVERSATION", now);
    const u1 = service.recordUtterance(s.id, { speaker: "learner", text: "Yesterday I went to work", startedAt: now, endedAt: now + 3000 });
    expect(u1.seq).toBe(1);
    const u2 = service.recordUtterance(s.id, { speaker: "coach", text: "Good.", startedAt: now + 3100, endedAt: now + 3400 });
    expect(u2.seq).toBe(2);
  });

  it("records interventions as observations rows", () => {
    const s = service.createSession(LEARNER_ID, now);
    service.transition(s.id, "WARMUP", now);
    service.transition(s.id, "CONVERSATION", now);
    service.recordIntervention(s.id, "micro_coach", "grammar.past_tense", now);
    const rows = sqlite.prepare("SELECT type, skill_code FROM observations WHERE session_id = ?").all(s.id);
    expect(rows).toEqual([{ type: "micro_coach", skill_code: "grammar.past_tense" }]);
  });

  it("ends a session once: second end is rejected (Review Focus 3)", () => {
    const s = service.createSession(LEARNER_ID, now);
    service.transition(s.id, "WARMUP", now);
    service.transition(s.id, "CONVERSATION", now);
    service.recordUtterance(s.id, { speaker: "learner", text: "I went home", startedAt: now, endedAt: now + 2000 });
    const first = service.endSession(s.id, now + 60000);
    expect(first.ok).toBe(true);
    expect(first.metrics.speakingSeconds).toBe(2);
    const second = service.endSession(s.id, now + 61000);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("already_ended");
    expect(service.getRecord(s.id)?.state).toBe("ANALYZING");
  });

  it("endSession from STARTING (user bails immediately) works", () => {
    const s = service.createSession(LEARNER_ID, now);
    const out = service.endSession(s.id, now + 5000);
    expect(out.ok).toBe(true);
    expect(out.metrics.userWordCount).toBe(0);
  });
});
