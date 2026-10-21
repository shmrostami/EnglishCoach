import { eq, and, desc, ne, isNotNull } from "drizzle-orm";
import {
  learners, goalsTable, skills, errorPatterns, sessions, learningPlans,
  vocabularyItems, learnerPreferences, type DrizzleDb,
} from "@ec/db";
import type { LearnerContext } from "@ec/domain";

export function buildLearnerContext(
  d: DrizzleDb,
  learnerId: string,
  sessionId: string | null,
  _now: number,
): LearnerContext {
  const learner = d.select().from(learners).where(eq(learners.id, learnerId)).all()[0];
  if (!learner) throw new Error(`unknown learner ${learnerId}`);
  const session = sessionId
    ? d.select().from(sessions).where(eq(sessions.id, sessionId)).all()[0]
    : null;
  const plan = d.select().from(learningPlans)
    .where(and(eq(learningPlans.learnerId, learnerId), eq(learningPlans.status, "active")))
    .orderBy(desc(learningPlans.createdAt)).all()[0];
  const goals = d.select().from(goalsTable)
    .where(and(eq(goalsTable.learnerId, learnerId), eq(goalsTable.status, "active"))).all();
  const recurring = d.select().from(errorPatterns)
    .where(and(eq(errorPatterns.learnerId, learnerId), eq(errorPatterns.status, "active")))
    .all()
    .filter((e) => e.frequency >= 3 && e.confidence >= 0.75)
    .map((e) => e.skillCode);
  const strengths = d.select().from(skills)
    .where(and(eq(skills.learnerId, learnerId), eq(skills.trend, "improving"))).all()
    .map((sk) => sk.code);
  const topicRows = sessionId
    ? d.select().from(sessions)
        .where(and(eq(sessions.learnerId, learnerId), ne(sessions.id, sessionId), isNotNull(sessions.topic)))
        .orderBy(desc(sessions.startedAt)).all()
    : d.select().from(sessions)
        .where(and(eq(sessions.learnerId, learnerId), isNotNull(sessions.topic)))
        .orderBy(desc(sessions.startedAt)).all();
  const recent = topicRows.slice(0, 5).map((x) => x.topic ?? "").filter(Boolean);
  const primary = plan ? safeParse(plan.primaryTargets) : [];
  // Due reviews are a real planning input (spec §7.5), so the words travel with
  // the context instead of being recomputed by every caller. A word is a target
  // when it is due and has not been fully learned.
  const prefs = d.select().from(learnerPreferences)
    .where(eq(learnerPreferences.learnerId, learnerId)).all()[0];
  const vocabularyTargets = d.select().from(vocabularyItems)
    .where(eq(vocabularyItems.learnerId, learnerId)).all()
    .filter((v) => v.productionMastery < 0.8 && (v.nextReviewAt === null || v.nextReviewAt <= _now))
    .sort((a, b) => (a.nextReviewAt ?? 0) - (b.nextReviewAt ?? 0))
    .slice(0, 10)
    .map((v) => v.word);
  return {
    level: learner.estimatedLevel ?? learner.targetLevel ?? "B1",
    goals: goals.map((g) => g.description),
    strengths,
    activeWeaknesses: recurring,
    vocabularyTargets,
    difficulty: plan?.difficulty ?? session?.plannedDifficulty ?? 0.5,
    // A stored preference wins over the seeded row: it is what the learner chose.
    correctionStyle: prefs?.correctionStyle ?? learner.correctionStyle,
    recentTopics: recent,
    currentSessionTargets: primary,
  };
}

function safeParse(s: string | null): string[] {
  if (!s) return [];
  try { return JSON.parse(s) as string[]; } catch { return []; }
}
