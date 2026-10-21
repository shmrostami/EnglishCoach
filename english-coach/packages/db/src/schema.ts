import { sqliteTable, text, integer, real, unique } from "drizzle-orm/sqlite-core";

export const learners = sqliteTable("learners", {
  id: text("id").primaryKey(),
  nativeLanguage: text("native_language").notNull(),
  targetLanguage: text("target_language").notNull().default("en"),
  targetLevel: text("target_level"),
  estimatedLevel: text("estimated_level"),
  estimatedLevelConfidence: real("estimated_level_confidence").notNull().default(0),
  correctionStyle: text("correction_style").notNull().default("moderate"),
  preferredSessionMinutes: integer("preferred_session_minutes").notNull().default(15),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const goalsTable = sqliteTable("learner_goals", {
  id: text("id").primaryKey(),
  learnerId: text("learner_id").notNull().references(() => learners.id),
  type: text("type").notNull(),
  description: text("description").notNull(),
  priority: real("priority").notNull().default(0.5),
  status: text("status").notNull().default("active"),
  createdAt: integer("created_at").notNull(),
  completedAt: integer("completed_at"),
});

export const skills = sqliteTable("skills", {
  id: text("id").primaryKey(),
  learnerId: text("learner_id").notNull().references(() => learners.id),
  code: text("code").notNull(),
  mastery: real("mastery").notNull().default(0.5),
  confidence: real("confidence").notNull().default(0.1),
  trend: text("trend").notNull().default("stable"),
  observationCount: integer("observation_count").notNull().default(0),
  lastAssessedAt: integer("last_assessed_at"),
  nextReviewAt: integer("next_review_at"),
}, (t) => ({ uq_skills_learner_code: unique().on(t.learnerId, t.code) }));

export const errorPatterns = sqliteTable("error_patterns", {
  id: text("id").primaryKey(),
  learnerId: text("learner_id").notNull().references(() => learners.id),
  skillCode: text("skill_code").notNull(),
  pattern: text("pattern").notNull(),
  description: text("description"),
  frequency: integer("frequency").notNull().default(1),
  severity: real("severity").notNull(),
  mastery: real("mastery").notNull().default(0),
  confidence: real("confidence").notNull().default(0.5),
  status: text("status").notNull().default("active"),
  firstSeenAt: integer("first_seen_at").notNull(),
  lastSeenAt: integer("last_seen_at").notNull(),
  nextReviewAt: integer("next_review_at"),
}, (t) => ({ uq_error_patterns: unique().on(t.learnerId, t.skillCode, t.pattern) }));

export const vocabularyItems = sqliteTable("vocabulary_items", {
  id: text("id").primaryKey(),
  learnerId: text("learner_id").notNull().references(() => learners.id),
  word: text("word").notNull(),
  recognitionMastery: real("recognition_mastery").notNull().default(0),
  productionMastery: real("production_mastery").notNull().default(0),
  collocationMastery: real("collocation_mastery").notNull().default(0),
  exposureCount: integer("exposure_count").notNull().default(0),
  productionCount: integer("production_count").notNull().default(0),
  lastUsedAt: integer("last_used_at"),
  nextReviewAt: integer("next_review_at"),
}, (t) => ({ uq_vocabulary_items: unique().on(t.learnerId, t.word) }));

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  learnerId: text("learner_id").notNull().references(() => learners.id),
  status: text("status").notNull(),
  topic: text("topic"),
  plannedDifficulty: real("planned_difficulty"),
  achievedDifficulty: real("achieved_difficulty"),
  durationSeconds: integer("duration_seconds"),
  fluencyScore: real("fluency_score"),
  grammarScore: real("grammar_score"),
  vocabularyScore: real("vocabulary_score"),
  pronunciationScore: real("pronunciation_score"),
  coherenceScore: real("coherence_score"),
  interactionScore: real("interaction_score"),
  overallScore: real("overall_score"),
  analysis: text("analysis"),
  metrics: text("metrics"),
  startedAt: integer("started_at").notNull(),
  endedAt: integer("ended_at"),
});

export const utterances = sqliteTable("utterances", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => sessions.id),
  speaker: text("speaker").notNull(),
  sequenceNumber: integer("sequence_number").notNull(),
  text: text("text").notNull(),
  startedAt: integer("started_at"),
  endedAt: integer("ended_at"),
  durationMs: integer("duration_ms"),
  wordCount: integer("word_count"),
  pauseBeforeMs: integer("pause_before_ms"),
});

export const observations = sqliteTable("observations", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => sessions.id),
  utteranceId: text("utterance_id").references(() => utterances.id),
  type: text("type").notNull(),
  skillCode: text("skill_code"),
  evidence: text("evidence"),
  expected: text("expected"),
  actual: text("actual"),
  severity: real("severity"),
  confidence: real("confidence"),
  createdAt: integer("created_at").notNull(),
});

export const learningPlans = sqliteTable("learning_plans", {
  id: text("id").primaryKey(),
  learnerId: text("learner_id").notNull().references(() => learners.id),
  difficulty: real("difficulty").notNull(),
  primaryTargets: text("primary_targets").notNull(),
  secondaryTargets: text("secondary_targets"),
  interventionType: text("intervention_type"),
  topic: text("topic"),
  reasoning: text("reasoning"),
  status: text("status").notNull().default("active"),
  createdAt: integer("created_at").notNull(),
});

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  sessionId: text("session_id").references(() => sessions.id),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  nextRunAt: integer("next_run_at"),
  error: text("error"),
  createdAt: integer("created_at").notNull(),
  doneAt: integer("done_at"),
}, (t) => ({ uq_jobs_session_type: unique().on(t.sessionId, t.type) }));

// Live coaching actions, kept out of `observations` (spec §23): observations are
// assessment evidence, interventions are what the coach did mid-conversation.
export const interventions = sqliteTable("interventions", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => sessions.id),
  kind: text("kind").notNull(),
  skillCode: text("skill_code"),
  state: text("state"),
  createdAt: integer("created_at").notNull(),
});

// Attempt history: `jobs` keeps only the latest error, so a failed job has no
// history and no error class without this table (spec §10.3).
export const jobAttempts = sqliteTable("job_attempts", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => jobs.id),
  attempt: integer("attempt").notNull(),
  status: text("status").notNull(),
  errorClass: text("error_class"),
  error: text("error"),
  startedAt: integer("started_at").notNull(),
  finishedAt: integer("finished_at"),
});

export type SkillRow = typeof skills.$inferSelect;
export type ErrorRow = typeof errorPatterns.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type PlanRow = typeof learningPlans.$inferSelect;
export type GoalRow = typeof goalsTable.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
export type UtteranceRow = typeof utterances.$inferSelect;
export type ObservationRow = typeof observations.$inferSelect;
export type InterventionRow = typeof interventions.$inferSelect;
export type JobAttemptRow = typeof jobAttempts.$inferSelect;
