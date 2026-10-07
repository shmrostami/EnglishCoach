import { eq, and, desc, ne, isNotNull } from "drizzle-orm";
import {
  learners, goalsTable, skills, errorPatterns, sessions, learningPlans,
  type DrizzleDb,
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
  return {
    level: learner.estimatedLevel ?? learner.targetLevel ?? "B1",
    goals: goals.map((g) => g.description),
    strengths,
    activeWeaknesses: recurring,
    vocabularyTargets: [],
    difficulty: plan?.difficulty ?? session?.plannedDifficulty ?? 0.5,
    correctionStyle: learner.correctionStyle,
    recentTopics: recent,
    currentSessionTargets: primary,
  };
}

function safeParse(s: string | null): string[] {
  if (!s) return [];
  try { return JSON.parse(s) as string[]; } catch { return []; }
}
