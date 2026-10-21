import { z } from "zod";
import { isSkillCode } from "./codes.js";

const unit = z.number().min(0).max(1);
const skillCode = z.string().refine(isSkillCode, { message: "unknown skill code" });

export const SkillStateSchema = z.object({
  mastery: unit,
  confidence: unit,
  observationCount: z.number().int().nonnegative(),
  trend: z.enum(["improving", "stable", "declining"]),
});

export const ScoresSchema = z.object({
  fluency: unit, grammar: unit, vocabulary: unit,
  pronunciation: unit.nullable(), coherence: unit, interaction: unit,
});

export const ObservationSchema = z.object({
  type: z.enum(["language_error", "strength", "vocabulary_use", "fluency_signal"]),
  skill: skillCode,
  evidence: z.string(),
  actual: z.string().optional(),
  expected: z.string().optional(),
  severity: unit.optional(),
  confidence: unit,
});

export const SessionAnalysisSchema = z.object({
  scores: ScoresSchema,
  observations: z.array(ObservationSchema),
  recurring_errors: z.array(z.object({ skill: skillCode, pattern: z.string(), confidence: unit })),
  strengths: z.array(z.object({ skill: skillCode, evidence: z.string(), confidence: unit })),
  recommended_targets: z.array(skillCode),
});

export const SessionMetricsSchema = z.object({
  speakingSeconds: z.number().nonnegative(),
  userWordCount: z.number().int().nonnegative(),
  wordsPerMinute: z.number().nonnegative(),
  pauseCount: z.number().int().nonnegative(),
  avgPauseMs: z.number().nonnegative(),
  longestPauseMs: z.number().nonnegative(),
  utteranceCount: z.number().int().nonnegative(),
  avgUtteranceWords: z.number().nonnegative(),
});

export const LearnerContextSchema = z.object({
  level: z.string(),
  goals: z.array(z.string()),
  strengths: z.array(skillCode),
  activeWeaknesses: z.array(skillCode),
  vocabularyTargets: z.array(z.string()),
  difficulty: unit,
  correctionStyle: z.string(),
  recentTopics: z.array(z.string()),
  currentSessionTargets: z.array(skillCode),
});

export const LearnerActionSchema = z.enum(["pending", "accepted", "dismissed"]);

export const CorrectedSentenceSchema = z.object({
  id: z.string(),
  original: z.string(),
  suggested: z.string().nullable(),
  explanation: z.string(),
  skill: skillCode,
  evidence: z.string(),
  confidence: unit,
  learnerAction: LearnerActionSchema,
});

export const SessionFeedbackSchema = z.object({
  sessionId: z.string(),
  topic: z.string(),
  startedAt: z.number(),
  scores: ScoresSchema,
  notAssessed: z.array(z.enum(["fluency", "grammar", "vocabulary", "pronunciation", "coherence", "interaction"])),
  strengths: z.array(z.object({ skill: skillCode, evidence: z.string(), confidence: unit })),
  corrections: z.array(CorrectedSentenceSchema),
  vocabulary: z.array(z.string()),
  next: z.object({ topic: z.string().nullable(), targets: z.array(skillCode), reason: z.string().nullable() }).nullable(),
});

export const PlanDraftSchema = z.object({
  topic: z.string(),
  candidateSkills: z.array(skillCode),
  reason: z.string(),
});
