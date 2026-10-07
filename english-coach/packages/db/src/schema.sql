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
