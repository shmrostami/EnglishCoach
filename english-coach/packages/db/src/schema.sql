CREATE TABLE learners (
  id TEXT PRIMARY KEY,
  native_language TEXT NOT NULL,
  target_language TEXT NOT NULL DEFAULT 'en',
  target_level TEXT,
  estimated_level TEXT,
  estimated_level_confidence REAL NOT NULL DEFAULT 0,
  correction_style TEXT NOT NULL DEFAULT 'moderate',
  preferred_session_minutes INTEGER NOT NULL DEFAULT 15,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE learner_goals (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  type TEXT NOT NULL,
  description TEXT NOT NULL,
  priority REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  code TEXT NOT NULL,
  mastery REAL NOT NULL DEFAULT 0.5,
  confidence REAL NOT NULL DEFAULT 0.1,
  trend TEXT NOT NULL DEFAULT 'stable',
  observation_count INTEGER NOT NULL DEFAULT 0,
  last_assessed_at INTEGER,
  next_review_at INTEGER,
  UNIQUE (learner_id, code)
);

CREATE TABLE error_patterns (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  skill_code TEXT NOT NULL,
  pattern TEXT NOT NULL,
  description TEXT,
  frequency INTEGER NOT NULL DEFAULT 1,
  severity REAL NOT NULL,
  mastery REAL NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'active',
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  next_review_at INTEGER,
  UNIQUE (learner_id, skill_code, pattern)
);

CREATE TABLE vocabulary_items (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  word TEXT NOT NULL,
  recognition_mastery REAL NOT NULL DEFAULT 0,
  production_mastery REAL NOT NULL DEFAULT 0,
  collocation_mastery REAL NOT NULL DEFAULT 0,
  exposure_count INTEGER NOT NULL DEFAULT 0,
  production_count INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  next_review_at INTEGER,
  UNIQUE (learner_id, word)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  status TEXT NOT NULL,
  topic TEXT,
  planned_difficulty REAL,
  achieved_difficulty REAL,
  duration_seconds INTEGER,
  fluency_score REAL,
  grammar_score REAL,
  vocabulary_score REAL,
  pronunciation_score REAL,
  coherence_score REAL,
  interaction_score REAL,
  overall_score REAL,
  analysis TEXT,
  metrics TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE utterances (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  speaker TEXT NOT NULL,
  sequence_number INTEGER NOT NULL,
  text TEXT NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  duration_ms INTEGER,
  word_count INTEGER,
  pause_before_ms INTEGER
);

CREATE TABLE observations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  utterance_id TEXT REFERENCES utterances(id),
  type TEXT NOT NULL,
  skill_code TEXT,
  evidence TEXT,
  expected TEXT,
  actual TEXT,
  severity REAL,
  confidence REAL,
  created_at INTEGER NOT NULL
);

CREATE TABLE learning_plans (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  difficulty REAL NOT NULL,
  primary_targets TEXT NOT NULL,
  secondary_targets TEXT,
  intervention_type TEXT,
  topic TEXT,
  reasoning TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id),
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_run_at INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  done_at INTEGER,
  UNIQUE (session_id, type)
);

-- Live coaching interventions. Deliberately NOT in `observations`: that table
-- holds assessment observations (language_error/strength/...), while these rows
-- record what the coach did during the conversation (spec §23 separation).
CREATE TABLE interventions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  kind TEXT NOT NULL,
  skill_code TEXT,
  state TEXT,
  created_at INTEGER NOT NULL
);

-- One row per job attempt. `jobs` keeps only the latest error, so without this
-- table a failed job has no history and no error class (spec §10.3).
CREATE TABLE job_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  error_class TEXT,
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);

-- Post-session corrections (spec §5 Phase 1, §11.3). Derived from the stored
-- analysis, so a retried analysis writes the same rows; `learner_action` is
-- persisted so a review survives leaving the session screen.
CREATE TABLE corrected_sentences (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  original TEXT NOT NULL,
  suggested TEXT,
  explanation TEXT,
  skill_code TEXT NOT NULL,
  evidence TEXT NOT NULL,
  confidence REAL NOT NULL,
  learner_action TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);

-- Post-session learner preferences (spec §6.1: "learners must be able to edit
-- them"). Kept as settings on the learners row, never as proof of proficiency.
CREATE TABLE learner_preferences (
  learner_id TEXT PRIMARY KEY REFERENCES learners(id),
  correction_style TEXT,
  preferred_session_minutes INTEGER,
  preferred_feedback_language TEXT,
  preferred_accent TEXT,
  updated_at INTEGER NOT NULL
);

-- One attempt at recalling a vocabulary item (spec §6.5, §7.4). The schedule is
-- derived from these, so an attempt is append-only: a correction is a new row.
CREATE TABLE review_attempts (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  vocabulary_item_id TEXT REFERENCES vocabulary_items(id),
  word TEXT NOT NULL,
  prompt_type TEXT NOT NULL,
  outcome TEXT NOT NULL,
  hint_used INTEGER NOT NULL DEFAULT 0,
  interval_days REAL,
  scheduler_version TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Learning objectives (spec §6.2): what a learner is working toward, separate
-- from a session. `success_criteria` is a JSON object so a rubric can grow
-- without a migration.
CREATE TABLE learning_objectives (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  goal_id TEXT REFERENCES learner_goals(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  skill_codes TEXT NOT NULL,
  success_criteria TEXT,
  priority REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'planned',
  due_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- An exercise the learner can be asked to do (spec §6.3). `type` is the
-- activity kind, `input/output_modality` are JSON arrays of strings.
CREATE TABLE activities (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  version INTEGER NOT NULL DEFAULT 1,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  objective_ids TEXT NOT NULL,
  target_skill_codes TEXT NOT NULL,
  difficulty REAL NOT NULL,
  estimated_minutes INTEGER NOT NULL,
  input_modality TEXT NOT NULL,
  output_modality TEXT NOT NULL,
  rubric_version TEXT,
  success_criteria TEXT,
  -- The prompt the guided-speaking activity asks for. Null for activity types
  -- that generate their own content.
  prompt TEXT,
  created_at INTEGER NOT NULL
);

-- One run through an activity (spec §6.3). Session-backed for speaking
-- activities; `session_id` is null for activities that have no live session.
CREATE TABLE activity_attempts (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  activity_id TEXT NOT NULL REFERENCES activities(id),
  activity_version INTEGER NOT NULL,
  session_id TEXT REFERENCES sessions(id),
  status TEXT NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  -- JSON: the deterministic check result, so a result never has to be
  -- recomputed to be read.
  result TEXT,
  created_at INTEGER NOT NULL
);

-- Diagnostic onboarding (spec §5 Phase 2, backlog item 12). Stored so the
-- placement is auditable and the learner can see what it was based on:
-- `basis` is always 'self_report', never an assessment.
CREATE TABLE diagnostics (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  band TEXT NOT NULL,
  confidence REAL NOT NULL,
  difficulty REAL NOT NULL,
  focus_skills TEXT NOT NULL,
  basis TEXT NOT NULL,
  rubric_version TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
