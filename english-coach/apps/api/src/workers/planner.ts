import { randomUUID } from "node:crypto";
import { eq, and, asc } from "drizzle-orm";
import {
  sessions, skills, errorPatterns, learningPlans, goalsTable, sessionTypesHistory,
  type DrizzleDb,
} from "@ec/db";
import type { PlanDraft, SessionAnalysis } from "@ec/domain";
import { PlanDraftSchema } from "@ec/domain";
import type { AnalysisProvider } from "@ec/openai";
import {
  adjustDifficulty, recentPerformance,
  selectSessionType, renderSessionPrompt, type SessionType,
  effectiveFrequency,
  selectTargets, chooseIntervention, goalRelevanceFor,
  DEFAULT_NO_HISTORY,
  type TargetCandidate,
} from "@ec/learning-engine";
import { buildLearnerContext } from "./context.js";

const DAY = 86_400_000;

export function buildCandidates(
  d: DrizzleDb,
  learnerId: string,
  analysis: SessionAnalysis,
  goalTypes: string[],
  now: number,
): TargetCandidate[] {
  const skillRows = new Map(
    d.select().from(skills).where(and(
      eq(skills.learnerId, learnerId),
    )).all().map((s) => [s.code, s]),
  );
  const errorRows = d.select().from(errorPatterns)
    .where(and(eq(errorPatterns.learnerId, learnerId), eq(errorPatterns.status, "active"))).all();
  const bySkill = new Map<string, typeof errorRows>();
  for (const e of errorRows) {
    bySkill.set(e.skillCode, [...(bySkill.get(e.skillCode) ?? []), e]);
  }

  const skillCodes = new Set<string>([
    ...errorRows.map((e) => e.skillCode),
    ...analysis.recommended_targets,
    ...analysis.observations.filter((o) => o.confidence > 0.8).map((o) => o.skill),
  ]);

  return [...skillCodes].map((code) => {
    const errs = bySkill.get(code) ?? [];
    const recurrence = Math.min(1, (errs.length ? Math.max(...errs.map((e) => effectiveFrequency(e.frequency, e.lastSeenAt, now))) : 0) / 3);
    const severity = errs.length > 0
      ? errs.reduce((a, e) => a + e.severity, 0) / errs.length
      : DEFAULT_NO_HISTORY.severity;
    const mastery = skillRows.get(code)?.mastery ?? 0.5;
    const lastSeen = errs.length > 0 ? Math.max(...errs.map((e) => e.lastSeenAt)) : null;
    return {
      skill: code,
      recurrence,
      severity,
      goalRelevance: goalRelevanceFor(code, goalTypes),
      communicativeImpact: Math.min(1, severity),
      readiness: 1 - mastery,
      forgettingRisk: lastSeen !== null ? 1 - Math.exp(-Math.max(0, (now - lastSeen) / (30 * DAY))) : DEFAULT_NO_HISTORY.forgettingRisk,
      mastery,
    };
  });
}

export async function runPlanner(opts: {
  db: DrizzleDb;
  provider: AnalysisProvider;
  sessionId: string;
  now: number;
}): Promise<void> {
  const { db: d, provider, sessionId, now } = opts;
  const session = d.select().from(sessions).where(eq(sessions.id, sessionId)).all()[0];
  if (!session || !session.analysis) throw new Error("session has no analysis; planner must run after analysis");

  // Idempotency: a plan is only produced once per learner at a time. If an
  // active plan already exists (created for this session by a previous run),
  // supersede it and return without duplicating.
  const existing = d.select().from(learningPlans)
    .where(and(eq(learningPlans.learnerId, session.learnerId), eq(learningPlans.status, "active")))
    .all();
  const planAlreadyExists = existing.some((p) => p.createdAt >= session.startedAt);

  const analysis = JSON.parse(session.analysis) as SessionAnalysis;
  const goalTypes = d.select().from(goalsTable)
    .where(and(eq(goalsTable.learnerId, session.learnerId), eq(goalsTable.status, "active")))
    .all().map((g) => g.type);

  const candidates = buildCandidates(d, session.learnerId, analysis, goalTypes, now);

  // Difficulty: engine math on session history.
  // `recentPerformance` takes the newest five scores, so the rows must arrive
  // oldest→newest (it slices from the end).
  const pastScores = d.select().from(sessions)
    .where(and(eq(sessions.learnerId, session.learnerId), eq(sessions.status, "COMPLETED")))
    .orderBy(asc(sessions.startedAt)).all()
    .map((s) => s.overallScore ?? 0);
  const currentDifficulty = session.plannedDifficulty ?? 0.5;
  const newDifficulty = adjustDifficulty(currentDifficulty, recentPerformance(pastScores.length > 0 ? pastScores : [0.5]));

  const learnerContext = buildLearnerContext(d, session.learnerId, sessionId, now);

  // The mode of the session (design.md §30): chosen from the learner's
  // difficulty and rotated, so three sessions in a row are not the same task.
  const recentTypes = d.select().from(sessionTypesHistory)
    .where(eq(sessionTypesHistory.learnerId, session.learnerId))
    .orderBy(asc(sessionTypesHistory.createdAt)).all()
    .map((r) => r.sessionType as SessionType);
  const typeSpec = selectSessionType({ difficulty: newDifficulty, recentTypes });
  d.insert(sessionTypesHistory).values({
    id: `stype-${randomUUID()}`,
    learnerId: session.learnerId,
    sessionId: null,
    sessionType: typeSpec.type,
    cognitiveDemand: typeSpec.cognitiveDemand,
    createdAt: now,
  }).run();

  const draftRaw = await provider.plan({
    difficulty: newDifficulty,
    candidates: candidates.map((c) => c.skill),
    learnerContext,
  });
  const draft: PlanDraft = PlanDraftSchema.parse(draftRaw);

  // Engine selection is authoritative: rank ALL candidates; LLM output only
  // contributes topic + reasoning. LLM candidates the engine ranks below its own
  // picks are rejected by construction.
  const { primary, secondary } = selectTargets(candidates);
  const interventions = new Map(primary.map((t) => [t.skill, chooseIntervention(t.skill)]));

  if (planAlreadyExists) return; // already planned for this session (re-run)

  // supersede any older active plan
  for (const p of existing) {
    d.update(learningPlans).set({ status: "superseded" }).where(eq(learningPlans.id, p.id)).run();
  }

  d.insert(learningPlans).values({
    id: `plan-${randomUUID()}`,
    learnerId: session.learnerId,
    difficulty: newDifficulty,
    primaryTargets: JSON.stringify(primary.map((t) => t.skill)),
    secondaryTargets: JSON.stringify(secondary.map((t) => t.skill)),
    // The mode's own intervention wins when the engine has no target: the mode
    // is the kind of task, and the mode knows how it should be practised.
    interventionType: primary[0] ? interventions.get(primary[0].skill) : typeSpec.intervention,
    // The topic is rendered through the mode's template, so the learner is
    // told what KIND of task this is — a debate is not a story, and the
    // cognitive demand is what makes it harder.
    topic: renderSessionPrompt(typeSpec, draft.topic),
    reasoning: `${draft.reason} (mode: ${typeSpec.label})`,
    status: "active",
    createdAt: now,
  }).run();

  d.update(sessions).set({ achievedDifficulty: newDifficulty }).where(eq(sessions.id, sessionId)).run();
}
