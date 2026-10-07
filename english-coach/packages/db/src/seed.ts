import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { LEARNER_ID } from "@ec/domain";
import { db } from "./client.js";
import { learners, goalsTable } from "./schema.js";

export function ensureSeed(database: Database.Database): void {
  const d = db(database);
  const existing = d.select().from(learners).where(eq(learners.id, LEARNER_ID)).all();
  if (existing.length > 0) return;
  const now = Date.now();
  d.insert(learners).values({
    id: LEARNER_ID,
    nativeLanguage: "fa",
    targetLanguage: "en",
    targetLevel: "B2",
    correctionStyle: "moderate",
    preferredSessionMinutes: 15,
    createdAt: now,
    updatedAt: now,
  }).run();
  d.insert(goalsTable).values([
    { id: "goal-1", learnerId: LEARNER_ID, type: "fluency",
      description: "Speak continuously for 5 minutes", priority: 0.9,
      status: "active", createdAt: now },
    { id: "goal-2", learnerId: LEARNER_ID, type: "grammar",
      description: "Use past tense accurately", priority: 0.7,
      status: "active", createdAt: now },
    { id: "goal-3", learnerId: LEARNER_ID, type: "vocabulary",
      description: "Expand active vocabulary in daily topics", priority: 0.6,
      status: "active", createdAt: now },
  ]).run();
}
