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

// Post-session corrections (spec §5 Phase 1, §11.3), derived from the stored
// analysis so a retried analysis writes the same rows.
export const correctedSentences = sqliteTable("corrected_sentences", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => sessions.id),
  original: text("original").notNull(),
  suggested: text("suggested"),
  explanation: text("explanation"),
  skillCode: text("skill_code").notNull(),
  evidence: text("evidence").notNull(),
  confidence: real("confidence").notNull(),
  learnerAction: text("learner_action").notNull().default("pending"),
  createdAt: integer("created_at").notNull(),
});

// Learner-chosen settings (spec §6.1). Never evidence of proficiency; every
// column is nullable so "not set" stays distinguishable from a default.
export const learnerPreferences = sqliteTable("learner_preferences", {
  learnerId: text("learner_id").primaryKey().references(() => learners.id),
  correctionStyle: text("correction_style"),
  preferredSessionMinutes: integer("preferred_session_minutes"),
  preferredFeedbackLanguage: text("preferred_feedback_language"),
  preferredAccent: text("preferred_accent"),
  updatedAt: integer("updated_at").notNull(),
});

// Append-only review attempts (spec §6.5, §7.4): the schedule is derived from
// them, so an attempt is never edited — a re-answer is a new row.
export const reviewAttempts = sqliteTable("review_attempts", {
  id: text("id").primaryKey(),
  learnerId: text("learner_id").notNull().references(() => learners.id),
  vocabularyItemId: text("vocabulary_item_id").references(() => vocabularyItems.id),
  word: text("word").notNull(),
  promptType: text("prompt_type").notNull(),
  outcome: text("outcome").notNull(),
  hintUsed: integer("hint_used").notNull().default(0),
  intervalDays: real("interval_days"),
  schedulerVersion: text("scheduler_version").notNull(),
  createdAt: integer("created_at").notNull(),
});

// Learning objectives (spec §6.2), separate from a session.
export const learningObjectives = sqliteTable("learning_objectives", {
  id: text("id").primaryKey(),
  learnerId: text("learner_id").notNull().references(() => learners.id),
  goalId: text("goal_id").references(() => goalsTable.id),
  title: text("title").notNull(),
  description: text("description").notNull(),
  skillCodes: text("skill_codes").notNull(),
  successCriteria: text("success_criteria"),
  priority: real("priority").notNull().default(0.5),
  status: text("status").notNull().default("planned"),
  dueAt: integer("due_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// An exercise the learner can be asked to do (spec §6.3).
export const activities = sqliteTable("activities", {
  id: text("id").primaryKey(),
  learnerId: text("learner_id").notNull().references(() => learners.id),
  version: integer("version").notNull().default(1),
  type: text("type").notNull(),
  title: text("title").notNull(),
  objectiveIds: text("objective_ids").notNull(),
  targetSkillCodes: text("target_skill_codes").notNull(),
  difficulty: real("difficulty").notNull(),
  estimatedMinutes: integer("estimated_minutes").notNull(),
  inputModality: text("input_modality").notNull(),
  outputModality: text("output_modality").notNull(),
  rubricVersion: text("rubric_version"),
  successCriteria: text("success_criteria"),
  prompt: text("prompt"),
  createdAt: integer("created_at").notNull(),
});

// One run through an activity (spec §6.3).
export const activityAttempts = sqliteTable("activity_attempts", {
  id: text("id").primaryKey(),
  learnerId: text("learner_id").notNull().references(() => learners.id),
  activityId: text("activity_id").notNull().references(() => activities.id),
  activityVersion: integer("activity_version").notNull(),
  sessionId: text("session_id").references(() => sessions.id),
  status: text("status").notNull(),
  startedAt: integer("started_at"),
  completedAt: integer("completed_at"),
  result: text("result"),
  createdAt: integer("created_at").notNull(),
});

// Diagnostic onboarding (spec §5 Phase 2). `basis` is always 'self_report'.
export const diagnostics = sqliteTable("diagnostics", {
  id: text("id").primaryKey(),
  learnerId: text("learner_id").notNull().references(() => learners.id),
  band: text("band").notNull(),
  confidence: real("confidence").notNull(),
  difficulty: real("difficulty").notNull(),
  focusSkills: text("focus_skills").notNull(),
  basis: text("basis").notNull(),
  rubricVersion: text("rubric_version").notNull(),
  createdAt: integer("created_at").notNull(),
});

// A measurable step under a goal (spec §6.1). Met when its skill reaches
// `targetMastery`, checked deterministically — never marked by a model.
export const goalMilestones = sqliteTable("goal_milestones", {
  id: text("id").primaryKey(),
  goalId: text("goal_id").notNull().references(() => goalsTable.id),
  title: text("title").notNull(),
  description: text("description"),
  targetSkillCode: text("target_skill_code"),
  targetMastery: real("target_mastery"),
  status: text("status").notNull().default("planned"),
  dueAt: integer("due_at"),
  achievedAt: integer("achieved_at"),
  createdAt: integer("created_at").notNull(),
});

// The canonical language item (spec §6.5) — the word itself, not any one
// learner's state of it. `senseKey` keeps polysemous words apart.
export const vocabularyItemsCanonical = sqliteTable("vocabulary_items_canonical", {
  id: text("id").primaryKey(),
  lemma: text("lemma").notNull(),
  senseKey: text("sense_key").notNull(),
  partOfSpeech: text("part_of_speech"),
  definition: text("definition"),
  exampleSentences: text("example_sentences"),
  collocations: text("collocations"),
  register: text("register"),
  topicTags: text("topic_tags"),
  createdAt: integer("created_at").notNull(),
}, (t) => ({ uq_vocab_canonical: unique().on(t.lemma, t.senseKey) }));

// A learner's state of a canonical item: recognition, recall and production
// move independently (spec §6.5).
export const vocabularyState = sqliteTable("vocabulary_state", {
  id: text("id").primaryKey(),
  learnerId: text("learner_id").notNull().references(() => learners.id),
  vocabularyItemId: text("vocabulary_item_id").notNull().references(() => vocabularyItemsCanonical.id),
  recognitionMastery: real("recognition_mastery").notNull().default(0),
  recallMastery: real("recall_mastery").notNull().default(0),
  productionMastery: real("production_mastery").notNull().default(0),
  stability: real("stability").notNull().default(0),
  difficulty: real("difficulty").notNull().default(0.5),
  dueAt: integer("due_at"),
  lastReviewedAt: integer("last_reviewed_at"),
  reviewCount: integer("review_count").notNull().default(0),
  lapseCount: integer("lapse_count").notNull().default(0),
  lastRecallRating: text("last_recall_rating"),
  status: text("status").notNull().default("learning"),
  createdAt: integer("created_at").notNull(),
}, (t) => ({ uq_vocab_state: unique().on(t.learnerId, t.vocabularyItemId) }));

// The six-part difficulty profile of one session (design.md §10).
export const difficultyProfiles = sqliteTable("difficulty_profiles", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => sessions.id),
  vocabularyComplexity: real("vocabulary_complexity").notNull(),
  grammaticalComplexity: real("grammatical_complexity").notNull(),
  speechSpeed: real("speech_speed").notNull(),
  abstraction: real("abstraction").notNull(),
  interactionPressure: real("interaction_pressure").notNull(),
  topicFamiliarity: real("topic_familiarity").notNull(),
  composite: real("composite").notNull(),
  createdAt: integer("created_at").notNull(),
}, (t) => ({ uq_difficulty_session: unique().on(t.sessionId) }));

// Which mode a session ran in (design.md §30), so the planner can rotate.
export const sessionTypesHistory = sqliteTable("session_types_history", {
  id: text("id").primaryKey(),
  learnerId: text("learner_id").notNull().references(() => learners.id),
  sessionId: text("session_id").references(() => sessions.id),
  sessionType: text("session_type").notNull(),
  cognitiveDemand: real("cognitive_demand").notNull(),
  createdAt: integer("created_at").notNull(),
});

// The learner's audio, kept only for a pronunciation assessment (spec §12.1).
export const audioEvidence = sqliteTable("audio_evidence", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => sessions.id),
  utteranceId: text("utterance_id").references(() => utterances.id),
  speaker: text("speaker").notNull(),
  sampleRate: integer("sample_rate").notNull(),
  sampleCount: integer("sample_count").notNull(),
  durationMs: integer("duration_ms").notNull(),
  pcmBase64: text("pcm_base64").notNull(),
  measurements: text("measurements"),
  createdAt: integer("created_at").notNull(),
});

// A pronunciation assessment, every value of it derived from audio.
export const pronunciationAssessments = sqliteTable("pronunciation_assessments", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => sessions.id),
  audioEvidenceId: text("audio_evidence_id").notNull().references(() => audioEvidence.id),
  rubricVersion: text("rubric_version").notNull(),
  intelligibility: real("intelligibility"),
  stress: real("stress"),
  rhythm: real("rhythm"),
  confidence: real("confidence").notNull(),
  createdAt: integer("created_at").notNull(),
}, (t) => ({ uq_pronunciation_evidence: unique().on(t.audioEvidenceId) }));

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
export type CorrectedSentenceRow = typeof correctedSentences.$inferSelect;
export type LearnerPreferenceRow = typeof learnerPreferences.$inferSelect;
export type ReviewAttemptRow = typeof reviewAttempts.$inferSelect;
export type ObjectiveRow = typeof learningObjectives.$inferSelect;
export type ActivityRow = typeof activities.$inferSelect;
export type ActivityAttemptRow = typeof activityAttempts.$inferSelect;
export type DiagnosticRow = typeof diagnostics.$inferSelect;
export type MilestoneRow = typeof goalMilestones.$inferSelect;
export type CanonicalVocabRow = typeof vocabularyItemsCanonical.$inferSelect;
export type VocabStateRow = typeof vocabularyState.$inferSelect;
export type DifficultyProfileRow = typeof difficultyProfiles.$inferSelect;
export type SessionTypeRow = typeof sessionTypesHistory.$inferSelect;
export type AudioEvidenceRow = typeof audioEvidence.$inferSelect;
export type PronunciationRow = typeof pronunciationAssessments.$inferSelect;
