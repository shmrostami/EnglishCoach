import type { LearnerContext } from "@ec/domain";
import { SKILL_CODES } from "@ec/domain";
import { eq } from "drizzle-orm";
import {
  errorPatterns, learningObjectives, vocabularyState,
  vocabularyItemsCanonical, type DrizzleDb,
} from "@ec/db";

/**
 * The tool layer (spec §8.3).
 *
 * The design lists nine possible tools. This implements the ones that are
 * safe to hand a model: the READ ones. A model that can read the learner's
 * own state can ground its coaching in what the learner actually struggles
 * with, instead of guessing from the transcript alone.
 *
 * What is deliberately NOT here:
 * - `record_assessment_candidate` — the learning engine writes learner state,
 *   not a model (spec §16.5: "LLM outputs must be schema-validated and
 *   cannot directly mutate authoritative learner state").
 * - `propose_next_activity` — the planner's targets are already chosen by the
 *   deterministic engine; a model proposes the topic only.
 *
 * Every tool here is read-only and takes no arguments the model could use to
 * reach anything it should not: no SQL, no table names, no filters. The
 * learner id is supplied by the caller, never by the model.
 */
export interface ToolContext {
  db: DrizzleDb;
  learnerId: string;
  learnerContext: LearnerContext;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const READ_TOOLS: ToolDefinition[] = [
  {
    name: "get_learner_context",
    description: "The learner's level, goals, strengths, active weaknesses, current targets and correction style.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_due_reviews",
    description: "The vocabulary words that are due for review now, with their mastery.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_active_learning_objectives",
    description: "The objectives the learner is currently working on.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_recurring_errors",
    description: "The error patterns that have recurred, with their frequency and confidence.",
    parameters: { type: "object", properties: {}, required: [] },
  },
];

/**
 * Executes a read tool.
 *
 * Unknown tool names are an error rather than a no-op: a model that invents a
 * tool must not be answered with a fabricated result.
 */
export function runReadTool(ctx: ToolContext, name: string): unknown {
  switch (name) {
    case "get_learner_context":
      return {
        level: ctx.learnerContext.level,
        goals: ctx.learnerContext.goals,
        strengths: ctx.learnerContext.strengths,
        activeWeaknesses: ctx.learnerContext.activeWeaknesses,
        currentTargets: ctx.learnerContext.currentSessionTargets,
        correctionStyle: ctx.learnerContext.correctionStyle,
        vocabularyTargets: ctx.learnerContext.vocabularyTargets,
      };

    case "get_due_reviews": {
      const now = Date.now();
      const rows = ctx.db.select().from(vocabularyState)
        .where(eq(vocabularyState.learnerId, ctx.learnerId)).all()
        .filter((r) => r.dueAt === null || r.dueAt <= now)
        .sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0))
        .slice(0, 10);
      const items = ctx.db.select().from(vocabularyItemsCanonical).all();
      const byId = new Map(items.map((i) => [i.id, i]));
      return rows.map((r) => ({
        word: byId.get(r.vocabularyItemId)?.lemma ?? null,
        recognitionMastery: r.recognitionMastery,
        recallMastery: r.recallMastery,
        productionMastery: r.productionMastery,
      })).filter((r) => r.word !== null);
    }

    case "get_active_learning_objectives":
      return ctx.db.select().from(learningObjectives)
        .where(eq(learningObjectives.learnerId, ctx.learnerId)).all()
        .filter((o) => o.status === "active" || o.status === "planned")
        .map((o) => ({
          title: o.title,
          description: o.description,
          skillCodes: safeParse(o.skillCodes),
          priority: o.priority,
        }));

    case "get_recurring_errors":
      return ctx.db.select().from(errorPatterns)
        .where(eq(errorPatterns.learnerId, ctx.learnerId)).all()
        .filter((e) => e.status === "active" && e.frequency >= 2)
        .sort((a, b) => b.frequency - a.frequency)
        .slice(0, 10)
        .map((e) => ({
          skill: e.skillCode,
          pattern: e.pattern,
          frequency: e.frequency,
          severity: e.severity,
          confidence: e.confidence,
        }));

    default:
      throw new Error(`unknown tool ${name}`);
  }
}

/**
 * The tool schemas in the OpenAI-compatible chat format, plus the grounding
 * context the model would otherwise have to guess at.
 */
export function buildToolMessages(ctx: ToolContext): {
  tools: { type: "function"; function: ToolDefinition }[];
  context: string;
} {
  const tools = READ_TOOLS.map((t) => ({ type: "function" as const, function: t }));
  const context = [
    "LEARNER CONTEXT",
    JSON.stringify(runReadTool(ctx, "get_learner_context")),
    "RECURRING ERRORS",
    JSON.stringify(runReadTool(ctx, "get_recurring_errors")),
    "ACTIVE OBJECTIVES",
    JSON.stringify(runReadTool(ctx, "get_active_learning_objectives")),
    "DUE REVIEWS",
    JSON.stringify(runReadTool(ctx, "get_due_reviews")),
    "VALID SKILL CODES",
    SKILL_CODES.join("\n"),
  ].join("\n\n");
  return { tools, context };
}

function safeParse(s: string | null): string[] {
  if (!s) return [];
  try { return JSON.parse(s) as string[]; } catch { return []; }
}
