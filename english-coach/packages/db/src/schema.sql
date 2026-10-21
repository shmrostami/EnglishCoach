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

-- Goal decomposition (spec §6.1 "decompose user goals into milestones").
-- A milestone is a measurable step under a goal; an objective may point at one.
CREATE TABLE goal_milestones (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES learner_goals(id),
  title TEXT NOT NULL,
  description TEXT,
  target_skill_code TEXT,
  -- Met when the skill's mastery reaches this value, or explicitly.
  target_mastery REAL,
  status TEXT NOT NULL DEFAULT 'planned',
  due_at INTEGER,
  achieved_at INTEGER,
  created_at INTEGER NOT NULL
);

-- Canonical vocabulary item (spec §6.5): the language item itself, separate
-- from any one learner's state of it. `lemma` is the normalized identity;
-- distinct meanings of a polysemous word are separate rows with separate
-- `sense` keys, never merged.
CREATE TABLE vocabulary_items_canonical (
  id TEXT PRIMARY KEY,
  lemma TEXT NOT NULL,
  sense_key TEXT NOT NULL,
  part_of_speech TEXT,
  definition TEXT,
  example_sentences TEXT,
  collocations TEXT,
  register TEXT,
  topic_tags TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (lemma, sense_key)
);

-- Per-learner state of a canonical item (spec §6.5): recognition, recall and
-- production are tracked separately, because knowing a word and using it are
-- different skills.
CREATE TABLE vocabulary_state (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  vocabulary_item_id TEXT NOT NULL REFERENCES vocabulary_items_canonical(id),
  recognition_mastery REAL NOT NULL DEFAULT 0,
  recall_mastery REAL NOT NULL DEFAULT 0,
  production_mastery REAL NOT NULL DEFAULT 0,
  stability REAL NOT NULL DEFAULT 0,
  difficulty REAL NOT NULL DEFAULT 0.5,
  due_at INTEGER,
  last_reviewed_at INTEGER,
  review_count INTEGER NOT NULL DEFAULT 0,
  lapse_count INTEGER NOT NULL DEFAULT 0,
  last_recall_rating TEXT,
  status TEXT NOT NULL DEFAULT 'learning',
  created_at INTEGER NOT NULL,
  UNIQUE (learner_id, vocabulary_item_id)
);

-- The six-part difficulty profile for a session (design.md §10). Stored so the
-- composite the planner used can be explained afterwards, component by
-- component, instead of being a bare number.
CREATE TABLE difficulty_profiles (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  vocabulary_complexity REAL NOT NULL,
  grammatical_complexity REAL NOT NULL,
  speech_speed REAL NOT NULL,
  abstraction REAL NOT NULL,
  interaction_pressure REAL NOT NULL,
  topic_familiarity REAL NOT NULL,
  composite REAL NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (session_id)
);

-- The mode a session runs in (design.md §30). The planner picks it from the
-- learner's difficulty and rotates it, so consecutive sessions are not the
-- same shape of task.
CREATE TABLE session_types_history (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  session_id TEXT REFERENCES sessions(id),
  session_type TEXT NOT NULL,
  cognitive_demand REAL NOT NULL,
  created_at INTEGER NOT NULL
);

-- The learner's audio, kept only when a pronunciation assessment needs it
-- (spec §12.1: a pronunciation score requires audio-grounded evidence).
--
-- Audio is the most sensitive data the app holds, so it is stored per turn,
-- with the measurement it produced, and is deleted with the session. Nothing
-- here is written for a session that did not ask for pronunciation.
CREATE TABLE audio_evidence (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  utterance_id TEXT REFERENCES utterances(id),
  speaker TEXT NOT NULL,
  sample_rate INTEGER NOT NULL,
  sample_count INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  -- Base64 PCM16, or a path to a stored file. Small turns only: the retention
  -- policy is "what was scored, and nothing more".
  pcm_base64 TEXT NOT NULL,
  -- The acoustic measurements taken from this audio, as JSON.
  measurements TEXT,
  created_at INTEGER NOT NULL
);

-- The pronunciation assessment for a turn (spec §24). Every dimension here
-- is derived from `audio_evidence`, never from the transcript.
CREATE TABLE pronunciation_assessments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  audio_evidence_id TEXT NOT NULL REFERENCES audio_evidence(id),
  rubric_version TEXT NOT NULL,
  -- 0..1 per skill, all audio-derived.
  intelligibility REAL,
  stress REAL,
  rhythm REAL,
  -- How much the measurement could be trusted: more audio, cleaner signal.
  confidence REAL NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (audio_evidence_id)
);
