# English Coach v1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the full English Coach v1 system — realtime voice conversation, session records, post-session analysis, deterministic learning engine, learner memory, adaptive planning, and a React web client — per the approved spec.

**Architecture:** pnpm monorepo. Fastify API holds the OpenAI Realtime WebSocket (browser streams PCM over a plain WS to the API). A deterministic state machine governs sessions. An in-process job runner drives the post-session pipeline: analysis (LLM, Zod-validated) → pure-function learning engine (all math, no I/O) → SQLite learner memory → next learning plan. The OpenAI backend sits behind provider interfaces; a mock provider implements the same interfaces so everything builds, runs, and is tested with zero API keys.

**Tech Stack:** TypeScript (strict), Node ≥ 22, pnpm workspaces, Fastify 5, better-sqlite3 + Drizzle ORM, Zod, Vite + React 18, Vitest, `openai` SDK (real provider only), `ws` (tests).

**Spec:** `Docs/implementation-spec.md` (all sections referenced below as §N of that file)

## Global Constraints

- TypeScript `strict: true` everywhere; ESM (`"type": "module"`).
- LLMs never write learner memory. Only workers (analysis, planner) call learning-engine functions, and only workers persist engine results. The realtime bridge and routes never call engine functions.
- Every provider output is validated with the domain Zod schemas before any persistence. Invalid output = job failure/retry, never partial writes.
- Workers are idempotent: re-running a completed job is a no-op.
- `packages/learning-engine` is pure: no I/O, no `Date.now()` inside engine functions (callers pass timestamps), no LLM calls.
- No audio files are stored anywhere (spec §6.1).
- API binds `127.0.0.1` only. No auth; single learner (spec §2, scope table).
- `learner_id` = `'learner-1'` (single-learner constant from the domain package).
- Time is stored as unix milliseconds (integer).
- Provider selection is env-driven: `PROVIDER=mock` (default) or `PROVIDER=openai` with `OPENAI_API_KEY`.
- Skill codes come only from `packages/domain/codes.ts` — the single source of truth (spec §5).

## Review Focus

Spec-implied input classes with no task-owned test yet. Each is pinned to a task below.

1. **Malformed / incomplete LLM JSON** (truncated response, wrong field types) — expected: analysis job fails cleanly, marks the job `failed` after 3 retries, and corrupts no learner state. → Task 7.
2. **Provider WebSocket disconnects mid-session** (OpenAI drops the Realtime connection) — expected: the client's WS closes with a `session_ended` message and the session is marked `FAILED`; no orphaned `pending` sessions. → Task 6.
3. **Double session end** (client retries `POST /sessions/:id/end`) — expected: second call is a 409 no-op; exactly one analysis job ever runs for that session. → Task 5.
4. **Client reconnects after a network blip during a live session** — expected: re-WS to the same session re-attaches to the existing bridge (state + audio resume); a second simultaneous client is rejected. → Task 6.
5. **Engine inputs at boundaries** (mastery already 1.0, frequency very large, difficulty at clamp limits) — expected: outputs stay in `[0,1]` / `[0.15,0.95]`, no NaN, no overflow. → Task 4.

---

### Task 1: Monorepo scaffold + git init

**Files:**
- Create: `english-coach/package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `.npmrc`, `vitest.config.ts`
- Create: `apps/api/{package.json,tsconfig.json}`, `apps/web/{package.json,tsconfig.json}`
- Create: `packages/{domain,db,openai,learning-engine,prompts}/{package.json,tsconfig.json,src/index.ts}`

**Interfaces:**
- Produces: workspace layout + root scripts (`pnpm build`, `pnpm test`, `pnpm typecheck`). Every later task depends on these working.

- [ ] **Step 1: Init git at project root**

Repo root is `EnglishTeacher` (holds `Docs/`, `architecture.md`). Monorepo lives inside it:

```bash
cd /d/Projects/Python/Agentic_Coding/EnglishTeacher
git init
mkdir -p english-coach
```

- [ ] **Step 2: Write root files**

`english-coach/package.json`:

```json
{
  "name": "english-coach",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "pnpm -r build",
    "typecheck": "pnpm -r typecheck",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`english-coach/pnpm-workspace.yaml`:

```yaml
packages:
  - apps/*
  - packages/*
```

`english-coach/tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

`english-coach/.npmrc`:

```
engine-strict=false
```

`english-coach/.gitignore`:

```
node_modules/
dist/
*.db
*.db-journal
.env
.env.local
```

`english-coach/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["**/src/**/*.test.ts", "**/tests/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 3: Write workspace manifests**

Each workspace `tsconfig.json` has the same shape:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

Package manifests (name → dependencies):
- `@ec/domain`: `zod`
- `@ec/db`: `better-sqlite3`, `drizzle-orm`, `@ec/domain` (workspace)
- `@ec/openai`: `zod`, `@ec/domain` (workspace), `openai`
- `@ec/learning-engine`: `@ec/domain` (workspace)
- `@ec/prompts`: none (plain text files)
- `@ec/api`: `fastify`, `@fastify/websocket`, `zod`, `better-sqlite3`, `drizzle-orm`, `ws`; workspace deps `@ec/domain`, `@ec/db`, `@ec/openai`, `@ec/learning-engine`; devDeps `@types/better-sqlite3`, `@types/ws`, `drizzle-kit`, `tsx`
- `@ec/web`: `react`, `react-dom`, `react-router`; devDeps `vite`, `@vitejs/plugin-react`, `@types/react`, `@types/react-dom`

Every `package.json` has `"type": "module"` and scripts: `"typecheck": "tsc -p tsconfig.json --noEmit"`, `"build": "tsc -p tsconfig.json"` (packages) or `"vite build"` (web). Packages set `"main": "src/index.ts"` so workspaces resolve source directly under tsx/Vite in dev. Workspace deps use `"workspace:*"`.

- [ ] **Step 4: Placeholder index files**

Create an empty `src/index.ts` in each of the five packages so `tsc` has an input. `apps/api` and `apps/web` get their `src/` in later tasks.

- [ ] **Step 5: Install and verify**

Run:

```bash
cd /d/Projects/Python/Agentic_Coding/EnglishTeacher/english-coach
pnpm install
pnpm typecheck
```

Expected: install succeeds (better-sqlite3 uses prebuilds); typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm monorepo (api, web, domain, db, openai, learning-engine, prompts)"
```

---

### Task 2: Domain package (types, Zod schemas, skill codes)

**Files:**
- Create: `packages/domain/src/codes.ts`, `types.ts`, `schemas.ts`
- Modify: `packages/domain/src/index.ts` (re-exports)
- Test: `packages/domain/src/schemas.test.ts`

**Interfaces:**
- Produces (consumed by every later task):
  - `codes.ts`: `FAMILIES`, `type Family`, `SKILL_CODES: string[]`, `isSkillCode(code: string): boolean`, `familyOf(code: string): Family | null`
  - `types.ts`: `LEARNER_ID`, `type SessionState`, `type Trend`, `type InterventionType`, `interface SkillState`, `Scores`, `Observation`, `RecurringError`, `SkillEvidence`, `SessionAnalysis`, `SessionMetrics`, `LearnerContext`, `LearningTarget`, `LearnerProfile`, `SessionRecord`, `PlanDraft`
  - `schemas.ts`: `SkillStateSchema`, `ScoresSchema`, `ObservationSchema`, `SessionAnalysisSchema`, `SessionMetricsSchema`, `LearnerContextSchema`, `PlanDraftSchema`

- [ ] **Step 1: Write failing test**

`packages/domain/src/schemas.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ScoresSchema, SessionAnalysisSchema } from "./schemas.js";
import { isSkillCode, SKILL_CODES } from "./codes.js";

describe("ScoresSchema", () => {
  it("accepts a valid scores object", () => {
    const ok = ScoresSchema.parse({
      fluency: 0.71, grammar: 0.64, vocabulary: 0.73,
      pronunciation: 0.78, coherence: 0.69, interaction: 0.82,
    });
    expect(ok.fluency).toBe(0.71);
  });
  it("rejects a score above 1", () => {
    expect(() => ScoresSchema.parse({
      fluency: 1.2, grammar: 0.64, vocabulary: 0.73,
      pronunciation: 0.78, coherence: 0.69, interaction: 0.82,
    })).toThrow();
  });
  it("rejects missing fields", () => {
    expect(() => ScoresSchema.parse({ fluency: 0.5 })).toThrow();
  });
});

describe("SessionAnalysisSchema", () => {
  const base = {
    scores: { fluency: 0.7, grammar: 0.6, vocabulary: 0.7, pronunciation: 0.8, coherence: 0.7, interaction: 0.8 },
    recurring_errors: [], strengths: [], recommended_targets: [],
  };
  it("accepts a valid analysis", () => {
    const a = SessionAnalysisSchema.parse({
      ...base,
      observations: [{ type: "language_error", skill: "grammar.past_tense",
        evidence: "Yesterday I go to work", actual: "go", expected: "went",
        severity: 0.61, confidence: 0.97 }],
    });
    expect(a.observations).toHaveLength(1);
  });
  it("rejects an observation with an unknown skill code", () => {
    expect(() => SessionAnalysisSchema.parse({
      ...base,
      observations: [{ type: "language_error", skill: "grammar.nope", evidence: "x", confidence: 0.9 }],
    })).toThrow(/skill/);
  });
});

describe("codes", () => {
  it("knows the canonical codes", () => {
    expect(isSkillCode("grammar.past_tense")).toBe(true);
    expect(isSkillCode("fluency.hesitation")).toBe(true);
    expect(isSkillCode("grammar.wrong_code")).toBe(false);
    expect(SKILL_CODES).toContain("discourse.argumentation");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd english-coach && pnpm vitest run packages/domain`
Expected: FAIL — `./codes.js` / `./schemas.js` missing.

- [ ] **Step 3: Write `codes.ts`**

```ts
export const FAMILIES = ["grammar", "vocabulary", "fluency", "pronunciation", "discourse"] as const;
export type Family = (typeof FAMILIES)[number];

export const SKILL_CODES: string[] = [
  "grammar.past_tense", "grammar.present_perfect", "grammar.conditionals",
  "grammar.articles", "grammar.prepositions", "grammar.word_order",
  "vocabulary.breadth", "vocabulary.precision", "vocabulary.collocations", "vocabulary.retrieval",
  "fluency.continuity", "fluency.hesitation", "fluency.retrieval_speed", "fluency.self_correction",
  "pronunciation.intelligibility", "pronunciation.stress", "pronunciation.rhythm",
  "discourse.coherence", "discourse.storytelling", "discourse.argumentation",
];

export function isSkillCode(code: string): boolean {
  return SKILL_CODES.includes(code);
}

export function familyOf(code: string): Family | null {
  const f = code.split(".")[0];
  return (FAMILIES as readonly string[]).includes(f) ? (f as Family) : null;
}
```

- [ ] **Step 4: Write `types.ts`**

```ts
export const LEARNER_ID = "learner-1";

export type SessionState =
  | "STARTING" | "WARMUP" | "CONVERSATION" | "MICRO_COACH"
  | "TARGET_RETRY" | "CHALLENGE" | "CLOSING" | "ANALYZING"
  | "COMPLETED" | "FAILED";

export type Trend = "improving" | "stable" | "declining";

export type InterventionType =
  | "natural_reuse" | "micro_correction" | "elicitation"
  | "role_play" | "storytelling" | "contrast" | "repetition";

export interface SkillState {
  mastery: number;
  confidence: number;
  observationCount: number;
  trend: Trend;
}

export interface Scores {
  fluency: number; grammar: number; vocabulary: number;
  pronunciation: number; coherence: number; interaction: number;
}

export interface Observation {
  type: "language_error" | "strength" | "vocabulary_use" | "fluency_signal";
  skill: string;
  evidence: string;
  actual?: string;
  expected?: string;
  severity?: number;
  confidence: number;
}

export interface RecurringError { skill: string; pattern: string; confidence: number; }
export interface SkillEvidence { skill: string; evidence: string; confidence: number; }

export interface SessionAnalysis {
  scores: Scores;
  observations: Observation[];
  recurring_errors: RecurringError[];
  strengths: SkillEvidence[];
  recommended_targets: string[];
}

export interface SessionMetrics {
  speakingSeconds: number;
  userWordCount: number;
  wordsPerMinute: number;
  pauseCount: number;
  avgPauseMs: number;
  longestPauseMs: number;
  utteranceCount: number;
  avgUtteranceWords: number;
  rmsEnergyAvg: number;
}

export interface LearnerContext {
  level: string;
  goals: string[];
  strengths: string[];
  activeWeaknesses: string[];
  vocabularyTargets: string[];
  difficulty: number;
  correctionStyle: string;
  recentTopics: string[];
  currentSessionTargets: string[];
}

export interface LearningTarget {
  skillCode: string;
  reason: string;
  priority: number;
  intervention: InterventionType;
  mastery: number;
  confidence: number;
}

export interface LearnerProfile {
  nativeLanguage: string;
  targetLanguage: string;
  targetLevel: string;
  estimatedLevel: string;
  estimatedLevelConfidence: number;
  correctionStyle: string;
  preferredSessionMinutes: number;
}

export interface SessionRecord {
  id: string;
  state: SessionState;
  topic: string;
  plannedDifficulty: number;
  achievedDifficulty: number;
  startedAt: number;
  endedAt: number | null;
  scores: Scores | null;
  analysis: SessionAnalysis | null;
  metrics: SessionMetrics | null;
}

export interface PlanDraft {
  topic: string;
  candidateSkills: string[];
  reason: string;
}
```

- [ ] **Step 5: Write `schemas.ts`**

```ts
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
  pronunciation: unit, coherence: unit, interaction: unit,
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
  rmsEnergyAvg: z.number().nonnegative(),
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

export const PlanDraftSchema = z.object({
  topic: z.string(),
  candidateSkills: z.array(skillCode),
  reason: z.string(),
});
```

- [ ] **Step 6: Update `index.ts`**

```ts
export * from "./codes.js";
export * from "./types.js";
export * from "./schemas.js";
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm vitest run packages/domain`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(domain): types, Zod schemas, canonical skill codes"
```

---
### Task 3: DB package (Drizzle/SQLite schema, client, migrations, seed)

**Files:**
- Create: `packages/db/src/schema.sql`, `schema.ts`, `client.ts`, `migrate.ts`, `seed.ts`, `index.ts`
- Modify: `packages/db/package.json` (add `"db:init": "tsx src/migrate-cli.ts"`, devDep `drizzle-kit`)
- Create: `packages/db/src/migrate-cli.ts`
- Test: `packages/db/src/schema.test.ts`

**Interfaces:**
- Consumes: `@ec/domain` (`LEARNER_ID`)
- Produces:
  - `openDb(dbPath: string): Database.Database` — WAL mode, FKs on; `:memory:` allowed
  - `db(database: Database.Database): DrizzleDb`, `type DrizzleDb`
  - `migrate(database: Database.Database): void` — applies `schema.sql` idempotently (`IF NOT EXISTS`)
  - `ensureSeed(database: Database.Database): void` — idempotent: 1 learner + 3 goals
  - `parseJson<T>(s: string | null): T | null`
  - Table identifiers: `learners`, `goalsTable`, `skills`, `errorPatterns`, `vocabularyItems`, `sessions`, `utterances`, `observations`, `learningPlans`, `jobs`
  - Row types: `SkillRow`, `ErrorRow`, `SessionRow`, `PlanRow`, `GoalRow`, `JobRow`, `UtteranceRow`, `ObservationRow`

- [ ] **Step 1: Write failing test**

`packages/db/src/schema.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDb, db } from "./client.js";
import { ensureSeed } from "./seed.js";
import { learners, goalsTable } from "./schema.js";
import type { Database } from "better-sqlite3";

const SCHEMA_SQL = readFileSync(
  fileURLToPath(new URL("./schema.sql", import.meta.url)), "utf8",
);

let database: Database;

beforeAll(() => {
  database = openDb(":memory:");
  database.exec(SCHEMA_SQL);
  ensureSeed(database);
});

describe("seed", () => {
  it("creates exactly one learner", () => {
    const rows = db(database).select().from(learners).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("learner-1");
    expect(rows[0].targetLanguage).toBe("en");
  });
  it("creates three goals with expected types and priorities", () => {
    const rows = db(database).select().from(goalsTable).all();
    expect(rows).toHaveLength(3);
    const byType = Object.fromEntries(rows.map((g) => [g.type, g.priority]));
    expect(byType).toEqual({ fluency: 0.9, grammar: 0.7, vocabulary: 0.6 });
  });
  it("is idempotent", () => {
    ensureSeed(database);
    expect(db(database).select().from(learners).all()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd english-coach && pnpm vitest run packages/db`
Expected: FAIL — modules missing.

- [ ] **Step 3: Write `schema.sql`**

```sql
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
```

- [ ] **Step 4: Write `schema.ts`** (Drizzle mirrors of the SQL above)

```ts
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
}, (t) => [unique(t.learnerId, t.code)]);

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
}, (t) => [unique(t.learnerId, t.skillCode, t.pattern)]);

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
}, (t) => [unique(t.learnerId, t.word)]);

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
}, (t) => [unique(t.sessionId, t.type)]);

export type SkillRow = typeof skills.$inferSelect;
export type ErrorRow = typeof errorPatterns.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type PlanRow = typeof learningPlans.$inferSelect;
export type GoalRow = typeof goalsTable.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
export type UtteranceRow = typeof utterances.$inferSelect;
export type ObservationRow = typeof observations.$inferSelect;
```

- [ ] **Step 5: Write `client.ts`, `migrate.ts`, `seed.ts`, `migrate-cli.ts`**

`client.ts`:

```ts
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export type DrizzleDb = BetterSQLite3Database<typeof schema>;

export function openDb(dbPath: string): Database.Database {
  const database = new Database(dbPath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  return database;
}

export function db(database: Database.Database): DrizzleDb {
  return drizzle(database, { schema });
}

export function parseJson<T>(s: string | null): T | null {
  return s === null ? null : (JSON.parse(s) as T);
}
```

`migrate.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

export function migrate(database: Database.Database): void {
  const sql = readFileSync(fileURLToPath(new URL("./schema.sql", import.meta.url)), "utf8");
  database.exec(sql.replace(/CREATE TABLE/g, "CREATE TABLE IF NOT EXISTS"));
}
```

`seed.ts`:

```ts
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { LEARNER_ID } from "@ec/domain";
import { db } from "./client.js";
import { learners, goalsTable } from "./schema.js";

export function ensureSeed(database: Database.Database): void {
  const d = db(database);
  const existing = d.select().from(learners).where(eq(learners.id, LEARNER_ID)).all();
  if (existing.length > 0) return;
  const now = Date.now();
  d.insert(learners).values({
    id: LEARNER_ID,
    nativeLanguage: "fa",
    targetLanguage: "en",
    targetLevel: "B2",
    correctionStyle: "moderate",
    preferredSessionMinutes: 15,
    createdAt: now,
    updatedAt: now,
  }).run();
  d.insert(goalsTable).values([
    { id: "goal-1", learnerId: LEARNER_ID, type: "fluency",
      description: "Speak continuously for 5 minutes", priority: 0.9,
      status: "active", createdAt: now },
    { id: "goal-2", learnerId: LEARNER_ID, type: "grammar",
      description: "Use past tense accurately", priority: 0.7,
      status: "active", createdAt: now },
    { id: "goal-3", learnerId: LEARNER_ID, type: "vocabulary",
      description: "Expand active vocabulary in daily topics", priority: 0.6,
      status: "active", createdAt: now },
  ]).run();
}
```

`migrate-cli.ts`:

```ts
import { openDb } from "./client.js";
import { migrate } from "./migrate.js";
import { ensureSeed } from "./seed.js";

const database = openDb(process.env.DB_PATH ?? "./english-coach.db");
migrate(database);
ensureSeed(database);
console.log("db ready");
```

Update `packages/db/package.json`: add `"db:init": "tsx src/migrate-cli.ts"` to scripts and `"drizzle-kit": "^0.28.0"` to devDependencies, then `pnpm install`.

`index.ts`:

```ts
export * from "./schema.js";
export * from "./client.js";
export * from "./migrate.js";
export * from "./seed.js";
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm vitest run packages/db`
Expected: PASS (3 tests). Also run `DB_PATH=/tmp/ec-test.db pnpm --filter @ec/db db:init` twice — second run must not fail (idempotent).

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(db): drizzle/SQLite schema, idempotent migration, seed"
```

---
### Task 4: Learning engine (pure functions)

All math from spec §10. No I/O, no `Date.now()` — callers pass timestamps. No LLM calls.

**Files:**
- Create: `packages/learning-engine/src/scoring.ts`
- Create: `packages/learning-engine/src/mastery.ts`
- Create: `packages/learning-engine/src/errors.ts`
- Create: `packages/learning-engine/src/difficulty.ts`
- Create: `packages/learning-engine/src/prioritization.ts`
- Create: `packages/learning-engine/src/planning.ts`
- Create: `packages/learning-engine/src/index.ts`
- Test: `packages/learning-engine/src/*.test.ts` (one per module, shown below)

**Interfaces:**
- Consumes: `@ec/domain` types only.
- Produces (consumed by Tasks 7, 8, 11):
  - `scoring.ts`: `WEIGHTS: Scores`, `calculateOverall(scores: Scores): number`
  - `mastery.ts`: `updateSkill(prev: SkillState, observation: number, now: number): SkillState`, `computeTrend(history: number[]): Trend`
  - `errors.ts`: `upsertErrorInput(prev: ErrorPatternInput | null, obs: {skill: string; pattern: string; severity: number; confidence: number}, now: number): ErrorPatternInput`, `effectiveFrequency(freq: number, lastSeenAt: number, now: number): number`, `isRecurring(e: ErrorPatternInput): boolean`, `shouldRetire(e: ErrorPatternInput, skillMastery: number, now: number): boolean`
  - `difficulty.ts`: `adjustDifficulty(current: number, recentPerformance: number): number`, `recentPerformance(scores: number[]): number`
  - `prioritization.ts`: `interface TargetCandidate`, `calculatePriority(c: TargetCandidate): number`, `rankCandidates(candidates: TargetCandidate[]): TargetCandidate[]`, `DEFAULT_NO_HISTORY: {recurrence: number; severity: number; forgettingRisk: number}`
  - `planning.ts`: `selectTargets(candidates: TargetCandidate[]): { primary: TargetCandidate[]; secondary: TargetCandidate[] }`, `chooseIntervention(skillCode: string): InterventionType`, `estimateLevel(overall: number, sessionCount: number): { level: string; confidence: number }`

- [ ] **Step 1: Write failing tests (all six modules)**

`packages/learning-engine/src/scoring.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { calculateOverall, WEIGHTS } from "./scoring.js";

describe("calculateOverall", () => {
  it("weights dimensions per spec", () => {
    const s = { fluency: 1, grammar: 1, vocabulary: 1, pronunciation: 1, coherence: 1, interaction: 1 };
    expect(calculateOverall(s)).toBeCloseTo(1);
    const one = { fluency: 1, grammar: 0, vocabulary: 0, pronunciation: 0, coherence: 0, interaction: 0 };
    expect(calculateOverall(one)).toBeCloseTo(0.25);
  });
  it("weights sum to 1", () => {
    const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1);
  });
});
```

`packages/learning-engine/src/mastery.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { updateSkill, computeTrend } from "./mastery.js";
import type { SkillState } from "@ec/domain";

const base: SkillState = { mastery: 0.5, confidence: 0.1, observationCount: 0, trend: "stable" };

describe("updateSkill", () => {
  it("uses alpha 0.25 for the first 5 observations", () => {
    const next = updateSkill(base, 0.9, 0);
    expect(next.mastery).toBeCloseTo(0.5 * 0.75 + 0.9 * 0.25);
    expect(next.observationCount).toBe(1);
    expect(next.confidence).toBeCloseTo(0.15);
  });
  it("switches to alpha 0.15 after 5 observations", () => {
    const prev: SkillState = { mastery: 0.5, confidence: 0.4, observationCount: 5, trend: "stable" };
    const next = updateSkill(prev, 0.9, 0);
    expect(next.mastery).toBeCloseTo(0.5 * 0.85 + 0.9 * 0.15);
  });
  it("caps confidence at 0.95", () => {
    const prev: SkillState = { mastery: 0.5, confidence: 0.94, observationCount: 10, trend: "stable" };
    expect(updateSkill(prev, 0.9, 0).confidence).toBeLessThanOrEqual(0.95);
  });
  it("keeps mastery within [0,1] at boundaries", () => {
    const atOne: SkillState = { mastery: 1, confidence: 0.9, observationCount: 20, trend: "stable" };
    const next = updateSkill(atOne, 0, 0);
    expect(next.mastery).toBeGreaterThanOrEqual(0);
    expect(next.mastery).toBeLessThanOrEqual(1);
  });
});

describe("computeTrend", () => {
  it("detects improving", () => {
    expect(computeTrend([0.42, 0.51, 0.58, 0.71, 0.69])).toBe("improving");
  });
  it("detects declining", () => {
    expect(computeTrend([0.71, 0.62, 0.55, 0.48, 0.41])).toBe("declining");
  });
  it("is stable for flat history", () => {
    expect(computeTrend([0.6, 0.61, 0.59, 0.6])).toBe("stable");
  });
});
```

`packages/learning-engine/src/errors.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  upsertErrorInput, effectiveFrequency, isRecurring, shouldRetire,
  type ErrorPatternInput,
} from "./errors.js";

const DAY = 86_400_000;
const NOW = 1_000_000_000_000;

describe("upsertErrorInput", () => {
  it("creates a pattern on first high-confidence error", () => {
    const e = upsertErrorInput(null,
      { skill: "grammar.past_tense", pattern: "present_after_past_expr", severity: 0.65, confidence: 0.9 }, NOW);
    expect(e.frequency).toBe(1);
    expect(e.confidence).toBe(0.9);
  });
  it("ignores low-confidence observations (no increment, no creation)", () => {
    const e = upsertErrorInput(null,
      { skill: "grammar.articles", pattern: "missing_article", severity: 0.3, confidence: 0.6 }, NOW);
    expect(e).toBeNull();
  });
  it("increments frequency and takes max confidence on repeat", () => {
    const first = upsertErrorInput(null,
      { skill: "grammar.past_tense", pattern: "p", severity: 0.6, confidence: 0.85 }, NOW - DAY)!;
    const second = upsertErrorInput(first,
      { skill: "grammar.past_tense", pattern: "p", severity: 0.7, confidence: 0.92 }, NOW);
    expect(second.frequency).toBe(2);
    expect(second.confidence).toBe(0.92);
  });
});

describe("effectiveFrequency", () => {
  it("decays over time", () => {
    const fresh = effectiveFrequency(6, NOW, NOW);
    const old = effectiveFrequency(6, NOW - 90 * DAY, NOW);
    expect(old).toBeLessThan(fresh);
  });
  it("damps a 90-day-old error below 1", () => {
    expect(effectiveFrequency(3, NOW - 90 * DAY, NOW)).toBeLessThan(1);
  });
});

describe("isRecurring", () => {
  it("requires frequency >= 3 AND confidence >= 0.75", () => {
    expect(isRecurring({ frequency: 2, confidence: 0.9, lastSeenAt: NOW })).toBe(false);
    expect(isRecurring({ frequency: 3, confidence: 0.7 })).toBe(false);
    expect(isRecurring({ frequency: 3, confidence: 0.8 })).toBe(true);
  });
});

describe("shouldRetire", () => {
  it("retires when unseen for 90 days (effective frequency < 1)", () => {
    const e = { frequency: 3, confidence: 0.8, lastSeenAt: NOW - 90 * DAY } as ErrorPatternInput;
    expect(shouldRetire(e, 0.6, NOW)).toBe(true);
  });
  it("retires when the skill is mastered", () => {
    const e = { frequency: 4, confidence: 0.8, lastSeenAt: NOW } as ErrorPatternInput;
    expect(shouldRetire(e, 0.85, NOW)).toBe(true);
  });
  it("keeps active errors", () => {
    const e = { frequency: 4, confidence: 0.8, lastSeenAt: NOW } as ErrorPatternInput;
    expect(shouldRetire(e, 0.4, NOW)).toBe(false);
  });
});
```

`packages/learning-engine/src/difficulty.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { adjustDifficulty, recentPerformance } from "./difficulty.js";

describe("adjustDifficulty", () => {
  it("raises at >= 0.85 by 0.05, capped at 0.95", () => {
    expect(adjustDifficulty(0.6, 0.9)).toBeCloseTo(0.65);
    expect(adjustDifficulty(0.94, 0.9)).toBeCloseTo(0.95);
  });
  it("raises at 0.75..0.85 by 0.02", () => {
    expect(adjustDifficulty(0.6, 0.8)).toBeCloseTo(0.62);
  });
  it("holds at 0.55..0.75", () => {
    expect(adjustDifficulty(0.6, 0.7)).toBe(0.6);
  });
  it("lowers below 0.55 by 0.05, floored at 0.15", () => {
    expect(adjustDifficulty(0.5, 0.3)).toBeCloseTo(0.45);
    expect(adjustDifficulty(0.16, 0.2)).toBeCloseTo(0.15);
  });
  it("never changes by more than 0.05", () => {
    for (const d of [0.15, 0.5, 0.95]) {
      for (const p of [0, 0.4, 0.6, 0.79, 0.86, 1]) {
        const next = adjustDifficulty(d, p);
        expect(Math.abs(next - d)).toBeLessThanOrEqual(0.05 + 1e-9);
      }
    }
  });
});

describe("recentPerformance", () => {
  it("averages the last 5 scores", () => {
    expect(recentPerformance([0.6, 0.7, 0.8, 0.9, 1.0])).toBeCloseTo(0.8);
  });
  it("uses the single score for a first session", () => {
    expect(recentPerformance([0.42])).toBeCloseTo(0.42);
  });
});
```

`packages/learning-engine/src/prioritization.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { calculatePriority, rankCandidates, DEFAULT_NO_HISTORY, type TargetCandidate } from "./prioritization.js";

describe("calculatePriority", () => {
  it("weights per spec (0.25/0.20/0.20/0.15/0.10/0.10)", () => {
    const all = { recurrence: 1, severity: 1, goalRelevance: 1, communicativeImpact: 1, readiness: 1, forgettingRisk: 1 };
    expect(calculatePriority(all)).toBeCloseTo(1);
    const none = { recurrence: 0, severity: 0, goalRelevance: 0, communicativeImpact: 0, readiness: 0, forgettingRisk: 0 };
    expect(calculatePriority(none)).toBeCloseTo(0);
  });
  it("goal relevance breaks ties", () => {
    const a = { skill: "grammar.past_tense", recurrence: 0.5, severity: 0.6, goalRelevance: 1, communicativeImpact: 0.5, readiness: 0.5, forgettingRisk: 0.5 };
    const b = { skill: "vocabulary.precision", recurrence: 0.5, severity: 0.6, goalRelevance: 0.3, communicativeImpact: 0.5, readiness: 0.5, forgettingRisk: 0.5 };
    expect(calculatePriority(a)).toBeGreaterThan(calculatePriority(b));
  });
});

describe("rankCandidates", () => {
  it("sorts descending and never reorders ties arbitrarily (stable)", () => {
    const cands: TargetCandidate[] = [
      { skill: "a", recurrence: 0.1, severity: 0.1, goalRelevance: 0.1, communicativeImpact: 0.1, readiness: 0.1, forgettingRisk: 0.1 },
      { skill: "b", recurrence: 0.9, severity: 0.9, goalRelevance: 0.9, communicativeImpact: 0.9, readiness: 0.9, forgettingRisk: 0.9 },
    ];
    const ranked = rankCandidates(cands);
    expect(ranked[0].skill).toBe("b");
  });
});

describe("DEFAULT_NO_HISTORY", () => {
  it("matches spec §10.6 defaults", () => {
    expect(DEFAULT_NO_HISTORY).toEqual({ recurrence: 0, severity: 0.4, forgettingRisk: 0 });
  });
});
```

`packages/learning-engine/src/planning.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { selectTargets, chooseIntervention, estimateLevel, type TargetCandidate } from "./planning.js";

function cand(skill: string, priority: number): TargetCandidate {
  return { skill, recurrence: priority, severity: priority, goalRelevance: priority,
    communicativeImpact: priority, readiness: priority, forgettingRisk: priority };
}

describe("selectTargets", () => {
  it("picks top 2 primary and at most 1 secondary", () => {
    const out = selectTargets([cand("a", 0.9), cand("b", 0.8), cand("c", 0.7), cand("d", 0.6)]);
    expect(out.primary).toHaveLength(2);
    expect(out.primary.map((t) => t.skill)).toEqual(["a", "b"]);
    expect(out.secondary).toHaveLength(1);
  });
  it("handles fewer candidates than slots", () => {
    const out = selectTargets([cand("a", 0.5)]);
    expect(out.primary).toHaveLength(1);
    expect(out.secondary).toHaveLength(0);
  });
  it("excludes mastered skills passed in with mastery >= 0.8", () => {
    const mastered = { ...cand("a", 0.9), mastery: 0.85 };
    const out = selectTargets([mastered, cand("b", 0.5)]);
    expect(out.primary.map((t) => t.skill)).toEqual(["b"]);
  });
});

describe("chooseIntervention", () => {
  it("maps grammar errors to natural_reuse or micro_correction", () => {
    const i = chooseIntervention("grammar.past_tense");
    expect(["natural_reuse", "micro_correction"]).toContain(i);
  });
  it("maps vocabulary retrieval to repetition", () => {
    expect(chooseIntervention("vocabulary.retrieval")).toBe("repetition");
  });
  it("maps discourse to storytelling", () => {
    expect(chooseIntervention("discourse.storytelling")).toBe("storytelling");
  });
  it("maps fluency to role_play", () => {
    expect(chooseIntervention("fluency.continuity")).toBe("role_play");
  });
});

describe("estimateLevel", () => {
  it("maps score bands to CEFR-ish labels", () => {
    expect(estimateLevel(0.45, 5).level).toBe("B1");
    expect(estimateLevel(0.62, 5).level).toBe("B1+");
    expect(estimateLevel(0.75, 5).level).toBe("B2+");
    expect(estimateLevel(0.85, 5).level).toBe("C1");
  });
  it("confidence grows with session count, capped at 0.95", () => {
    expect(estimateLevel(0.6, 2).confidence).toBeLessThan(estimateLevel(0.6, 12).confidence);
    expect(estimateLevel(0.6, 100).confidence).toBeLessThanOrEqual(0.95);
  });
  it("low confidence before 3 sessions", () => {
    expect(estimateLevel(0.6, 1).confidence).toBeLessThan(0.5);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/learning-engine`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement `scoring.ts`**

```ts
import type { Scores } from "@ec/domain";

export const WEIGHTS: Scores = {
  fluency: 0.25, grammar: 0.2, vocabulary: 0.2,
  pronunciation: 0.15, coherence: 0.1, interaction: 0.1,
};

export function calculateOverall(scores: Scores): number {
  return (
    scores.fluency * WEIGHTS.fluency +
    scores.grammar * WEIGHTS.grammar +
    scores.vocabulary * WEIGHTS.vocabulary +
    scores.pronunciation * WEIGHTS.pronunciation +
    scores.coherence * WEIGHTS.coherence +
    scores.interaction * WEIGHTS.interaction
  );
}
```

- [ ] **Step 4: Implement `mastery.ts`**

```ts
import type { SkillState, Trend } from "@ec/domain";

export function updateSkill(prev: SkillState, observation: number, now: number): SkillState {
  const alpha = prev.observationCount < 5 ? 0.25 : 0.15;
  const mastery = clamp01(prev.mastery * (1 - alpha) + observation * alpha);
  const confidence = Math.min(0.95, prev.confidence + 0.05);
  return {
    mastery,
    confidence,
    observationCount: prev.observationCount + 1,
    trend: prev.trend, // caller updates trend after pushing to its history window
  };
}

const WINDOW = 5;
export function computeTrend(history: number[]): Trend {
  if (history.length < 3) return "stable";
  const recent = history.slice(-WINDOW);
  const half = Math.floor(recent.length / 2);
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  const delta = mean(recent.slice(half)) - mean(recent.slice(0, half));
  if (delta > 0.05) return "improving";
  if (delta < -0.05) return "declining";
  return "stable";
}

export function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}
```

- [ ] **Step 5: Implement `errors.ts`**

```ts
export interface ErrorPatternInput {
  skill: string;
  pattern: string;
  description?: string;
  frequency: number;
  severity: number;
  mastery: number;
  confidence: number;
  status: "active" | "mastered";
  firstSeenAt: number;
  lastSeenAt: number;
}

const CONFIDENCE_GATE = 0.8;

export function upsertErrorInput(
  prev: ErrorPatternInput | null,
  obs: { skill: string; pattern: string; severity: number; confidence: number },
  now: number,
): ErrorPatternInput | null {
  if (obs.confidence < CONFIDENCE_GATE) return prev;
  if (!prev || prev.skill !== obs.skill || prev.pattern !== obs.pattern) {
    return {
      skill: obs.skill, pattern: obs.pattern,
      frequency: 1, severity: obs.severity, mastery: 0,
      confidence: obs.confidence, status: "active",
      firstSeenAt: now, lastSeenAt: now,
    };
  }
  return {
    ...prev,
    frequency: prev.frequency + 1,
    severity: Math.max(prev.severity, obs.severity),
    confidence: Math.max(prev.confidence, obs.confidence),
    lastSeenAt: now,
  };
}

export function effectiveFrequency(freq: number, lastSeenAt: number, now: number): number {
  const days = (now - lastSeenAt) / 86_400_000;
  return freq * Math.exp(-Math.max(0, days) / 30);
}

export function isRecurring(e: ErrorPatternInput): boolean {
  return e.status === "active" && e.frequency >= 3 && e.confidence >= 0.75;
}

export function shouldRetire(e: ErrorPatternInput, skillMastery: number, now: number): boolean {
  if (e.status !== "active") return false;
  if (skillMastery >= 0.8) return true;
  return effectiveFrequency(e.frequency, e.lastSeenAt, now) < 1;
}
```

- [ ] **Step 6: Implement `difficulty.ts`**

```ts
export function adjustDifficulty(current: number, recentPerformance: number): number {
  let next: number;
  if (recentPerformance >= 0.85) next = current + 0.05;
  else if (recentPerformance >= 0.75) next = current + 0.02;
  else if (recentPerformance >= 0.55) next = current;
  else next = current - 0.05;
  return Math.min(0.95, Math.max(0.15, next));
}

export function recentPerformance(sessionScores: number[]): number {
  const last5 = sessionScores.slice(-5);
  return last5.reduce((a, b) => a + b, 0) / last5.length;
}
```

- [ ] **Step 7: Implement `prioritization.ts`**

```ts
import { familyOf } from "@ec/domain";
import { clamp01 } from "./mastery.js";

export interface TargetCandidate {
  skill: string;
  recurrence: number;       // 0..1 normalized effective frequency of its errors
  severity: number;         // 0..1 mean severity of its error patterns
  goalRelevance: number;    // 0..1 — 1 if skill family matches an active goal type, else 0.3
  communicativeImpact: number; // 0..1 from analysis observation severity, capped
  readiness: number;        // 0..1 — 1 - mastery
  forgettingRisk: number;   // 0..1 — 1 - e^(-daysSinceLastReview/30)
  mastery?: number;         // optional; used by selectTargets to exclude mastered skills
}

/** Spec §10.6 defaults for skills with no observation history. */
export const DEFAULT_NO_HISTORY = { recurrence: 0, severity: 0.4, forgettingRisk: 0 } as const;

export function calculatePriority(c: TargetCandidate): number {
  return clamp01(
    0.25 * c.recurrence +
    0.2 * c.severity +
    0.2 * c.goalRelevance +
    0.15 * c.communicativeImpact +
    0.1 * c.readiness +
    0.1 * c.forgettingRisk,
  );
}

export function rankCandidates(candidates: TargetCandidate[]): TargetCandidate[] {
  return [...candidates].sort(
    (a, b) => calculatePriority(b) - calculatePriority(a) || a.skill.localeCompare(b.skill),
  );
}

export function goalRelevanceFor(skill: string, goalTypes: string[]): number {
  const family = familyOf(skill);
  return family && goalTypes.includes(family) ? 1 : 0.3;
}
```

- [ ] **Step 8: Implement `planning.ts`**

```ts
import type { InterventionType } from "@ec/domain";
import { familyOf } from "@ec/domain";
import { rankCandidates, calculatePriority, type TargetCandidate } from "./prioritization.js";

export function selectTargets(candidates: TargetCandidate[]): {
  primary: TargetCandidate[];
  secondary: TargetCandidate[];
} {
  const eligible = candidates.filter((c) => (c.mastery ?? 0) < 0.8);
  const ranked = rankCandidates(eligible);
  return {
    primary: ranked.slice(0, 2),
    secondary: ranked.slice(2, 3),
  };
}

const INTERVENTION_BY_FAMILY: Record<string, InterventionType> = {
  grammar: "natural_reuse",
  vocabulary: "repetition",
  fluency: "role_play",
  discourse: "storytelling",
  pronunciation: "contrast",
};

export function chooseIntervention(skillCode: string): InterventionType {
  const family = familyOf(skillCode);
  if (family === "grammar" && skillCode === "grammar.articles") return "micro_correction";
  return (family && INTERVENTION_BY_FAMILY[family]) ?? "natural_reuse";
}

export function estimateLevel(overall: number, sessionCount: number): { level: string; confidence: number } {
  let level: string;
  if (overall < 0.4) level = "A2";
  else if (overall < 0.55) level = "B1";
  else if (overall < 0.7) level = "B1+";
  else if (overall < 0.82) level = "B2+";
  else level = "C1";
  const confidence = Math.min(0.95, Math.max(0.3, 0.3 + sessionCount * 0.05));
  return { level, confidence };
}
```

- [ ] **Step 9: Write `index.ts`**

```ts
export * from "./scoring.js";
export * from "./mastery.js";
export * from "./errors.js";
export * from "./difficulty.js";
export * from "./prioritization.js";
export * from "./planning.js";
```

- [ ] **Step 10: Run tests to verify they pass**

Run: `pnpm vitest run packages/learning-engine`
Expected: all PASS (including the boundary tests that pin Review-Focus item 5).

- [ ] **Step 11: Commit**

```bash
git add -A && git commit -m "feat(learning-engine): pure scoring, mastery, error, difficulty, priority, planning"
```

---
### Task 5: Prompts package + provider interfaces + mock provider

The provider interface is the seam: real OpenAI (Task 12) and mock (this task) both implement it. Only the real implementation may know OpenAI event names.

**Files:**
- Create: `packages/prompts/prompts/conversation/v1.txt`, `analysis/v1.txt`, `planning/v1.txt`, `memory/v1.txt`
- Create: `packages/prompts/src/index.ts` (loader + registry + `renderPrompt`)
- Create: `packages/openai/src/providers/types.ts`
- Create: `packages/openai/src/mock/speech.ts`
- Create: `packages/openai/src/mock/analysis.ts`
- Create: `packages/openai/src/index.ts`
- Test: `packages/prompts/src/prompts.test.ts`, `packages/openai/src/mock/mock.test.ts`

**Interfaces:**
- Consumes: `@ec/domain` types.
- Produces:
  - `@ec/prompts`: `loadPrompt(name: PromptName): string`, `renderPrompt(name: PromptName, vars: Record<string, string>): string` (replaces `{{var}}` slots), `promptMeta(name): {name; version; model; temperature}`, `type PromptName = "conversation" | "analysis" | "planning" | "memory"`
  - `@ec/openai` (`providers/types.ts`):
    ```ts
    export interface TranscriptTurn {
      speaker: "learner" | "coach";
      text: string;
      startedAt: number;
      endedAt: number;
    }

    /** Normalized events the realtime provider emits. No OpenAI names here. */
    export type ProviderEvent =
      | { t: "connected" }
      | { t: "audio"; data: Buffer; sampleRate: number }
      | { t: "transcript"; turn: TranscriptTurn }
      | { t: "tool_call"; name: "request_micro_coaching" | "request_target_retry"; skill: string; reason?: string }
      | { t: "closed"; reason: string };

    export interface SpeechConversationProvider {
      connect(onEvent: (e: ProviderEvent) => void): Promise<void>;
      sendAudio(pcm16: Buffer): void;
      sendInstruction(text: string): void;   // warmup / challenge / micro-coach directives
      close(): void;
    }

    export interface AnalysisInput {
      learnerId: string;
      transcript: TranscriptTurn[];
      metrics: SessionMetrics;
      learnerContext: LearnerContext;
      sessionTargets: string[];
    }

    export interface PlanInput {
      difficulty: number;
      candidates: string[];   // engine-ranked skill codes
      learnerContext: LearnerContext;
    }

    export interface AnalysisProvider {
      analyze(input: AnalysisInput): Promise<SessionAnalysis>;
      plan(input: PlanInput): Promise<PlanDraft>;
    }
    ```
  - `@ec/openai` (mock): `class MockSpeechProvider implements SpeechConversationProvider`, `class MockAnalysisProvider implements AnalysisProvider`
  - `@ec/openai` index: `selectSpeechProvider(env): SpeechConversationProvider`, `selectAnalysisProvider(env): AnalysisProvider` — factory used by the API (returns mock unless `PROVIDER=openai` AND `OPENAI_API_KEY` set; Task 12 completes the real branch).

- [ ] **Step 1: Write prompt files**

`packages/prompts/prompts/conversation/v1.txt` (base text from spec §7.4 / architecture.md §20; slots `{{learner_context}}`, `{{targets}}`, `{{difficulty}}`):

```text
You are English Coach, an adaptive English-speaking coach.

PRIMARY OBJECTIVE

Improve the learner's spontaneous English communication through
natural conversation.

SESSION OBJECTIVE

Help the learner practice the assigned targets while maintaining
a natural conversation.

RULES

1. Keep the learner speaking.
2. Do not correct every mistake.
3. Prioritize recurring or meaningful errors.
4. Prioritize the current learning targets.
5. Prefer eliciting corrections over explaining grammar.
6. After a correction, return to natural conversation.
7. Reuse target structures naturally.
8. Increase difficulty gradually.
9. Do not overwhelm the learner.
10. Do not praise every answer.
11. Do not make the conversation feel like an exam.
12. Never shame the learner.
13. Do not switch to the native language unless necessary.

CORRECTION

Use a micro-correction when:
- the error is recurring;
- the error affects comprehension;
- the error is a current learning target;
- the learner would clearly benefit from immediate correction.

Otherwise continue the conversation.

Call request_micro_coaching when you decide to make a micro-correction,
and call request_target_retry when you want another practice opportunity
for a target structure.

LEARNER CONTEXT

{{learner_context}}

CURRENT TARGETS

{{targets}}

SESSION DIFFICULTY

{{difficulty}}
```

`packages/prompts/prompts/analysis/v1.txt` (design.md §16 diagnostician + exact output contract):

```text
You are an English-learning diagnostician.

Analyze the learner's speaking session below.

Evaluate:
1. Grammar accuracy
2. Vocabulary breadth
3. Vocabulary precision
4. Collocation usage
5. Fluency
6. Hesitation
7. Sentence complexity
8. Coherence
9. Interaction
10. Pronunciation indicators available from the audio/transcript

Deterministic audio metrics (measured, not to be guessed):
{{metrics}}

LEARNER CONTEXT
{{learner_context}}

SESSION TARGETS
{{targets}}

TRANSCRIPT
{{transcript}}

Do NOT treat isolated mistakes as stable weaknesses.
Identify recurring patterns (3+ high-confidence occurrences).

Return ONLY a JSON object with exactly this shape:
{
  "scores": { "fluency": 0..1, "grammar": 0..1, "vocabulary": 0..1,
               "pronunciation": 0..1, "coherence": 0..1, "interaction": 0..1 },
  "observations": [
    { "type": "language_error|strength|vocabulary_use|fluency_signal",
      "skill": "<skill code>", "evidence": "<quote from transcript>",
      "actual": "<optional>", "expected": "<optional>",
      "severity": 0..1, "confidence": 0..1 }
  ],
  "recurring_errors": [
    { "skill": "<skill code>", "pattern": "<short snake_case pattern name>", "confidence": 0..1 }
  ],
  "strengths": [
    { "skill": "<skill code>", "evidence": "<quote>", "confidence": 0..1 }
  ],
  "recommended_targets": ["<skill code>", ...]
}

Valid skill codes:
{{skill_codes}}

No prose. No markdown. JSON only.
```

`packages/prompts/prompts/planning/v1.txt` (design.md §17 + architecture.md §31 topic generation):

```text
You are the learner's long-term learning planner.

Given the learner profile, candidate skills (already ranked by the
learning engine), and session difficulty, choose:
1. A conversation topic for the next session.
2. Which candidate skills to practice, and why.

Rules:
1. Do not select more than 3 candidate skills.
2. Prefer the highest-ranked candidates unless you have a clear reason not to.
3. Prefer targets that can be practiced naturally in conversation.
4. Do not repeat the previous topic.
5. Match cognitive demand to difficulty (0..1).

LEARNER CONTEXT
{{learner_context}}

DIFFICULTY
{{difficulty}}

CANDIDATE SKILLS (ranked)
{{candidates}}

PREVIOUS TOPICS
{{recent_topics}}

Return ONLY JSON:
{ "topic": "<one sentence task, e.g. 'Tell me about a difficult decision you made at work'>",
  "candidateSkills": ["<skill code>", ...],
  "reason": "<one sentence>" }
```

`packages/prompts/prompts/memory/v1.txt` (design.md §18):

```text
You manage long-term learner memory.

Update learner memory only when the session provides sufficient evidence.

DO NOT store:
- isolated mistakes
- temporary conversational behavior
- irrelevant personal details
- guesses about learner ability

DO store:
- recurring language errors
- demonstrated improvements
- stable preferences
- persistent vocabulary problems
- persistent pronunciation patterns
- learning goals
- meaningful changes in proficiency

Every memory update must include: evidence, confidence, timestamp.
Prefer updating an existing memory over creating a duplicate.

LEARNER STATE
{{learner_state}}

SESSION EVIDENCE
{{evidence}}
```

- [ ] **Step 2: Write failing tests**

`packages/prompts/src/prompts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { loadPrompt, renderPrompt, promptMeta } from "./index.js";

describe("prompt loader", () => {
  it("loads all four versioned prompts", () => {
    for (const name of ["conversation", "analysis", "planning", "memory"] as const) {
      expect(loadPrompt(name).length).toBeGreaterThan(100);
    }
  });
  it("renders slots", () => {
    const rendered = renderPrompt("conversation", {
      learner_context: "LEVEL B1+", targets: "past_tense", difficulty: "0.61",
    });
    expect(rendered).toContain("LEVEL B1+");
    expect(rendered).not.toContain("{{learner_context}}");
  });
  it("keeps unknown slots intact", () => {
    expect(renderPrompt("conversation", { learner_context: "x" })).toContain("{{targets}}");
  });
  it("exposes registry metadata", () => {
    const meta = promptMeta("analysis");
    expect(meta.version).toBe("v1");
    expect(meta.temperature).toBe(0.2);
  });
});
```

`packages/openai/src/mock/mock.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { MockSpeechProvider } from "./speech.js";
import { MockAnalysisProvider } from "./analysis.js";
import { SessionAnalysisSchema } from "@ec/domain";
import type { TranscriptTurn, ProviderEvent } from "../providers/types.js";

describe("MockSpeechProvider", () => {
  it("emits connected, then the scripted turns in order, with tool calls", async () => {
    const seen: string[] = [];
    const provider = new MockSpeechProvider({
      turns: [
        { speaker: "coach", text: "Hi! How was your week?", pauseMs: 40 },
        { speaker: "learner", text: "Yesterday I go to work by train.", pauseMs: 40 },
        { speaker: "coach", text: "Almost — try that again with 'went'.", pauseMs: 40 },
        { speaker: "learner", text: "Yesterday I went to work by train.", pauseMs: 40, toolCall: { name: "request_target_retry", skill: "grammar.past_tense" } },
      ],
    });
    await provider.connect((e) => {
      if (e.t === "connected") seen.push("connected");
      if (e.t === "transcript") seen.push(`${e.turn.speaker}:${e.turn.text.slice(0, 12)}`);
      if (e.t === "tool_call") seen.push(`tool:${e.name}:${e.skill}`);
      if (e.t === "closed") seen.push(`closed:${e.reason}`);
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(seen[0]).toBe("connected");
    expect(seen.filter((s) => s.startsWith("learner:"))).toHaveLength(2);
    expect(seen).toContain("tool:request_target_retry:grammar.past_tense");
    expect(seen[seen.length - 1]).toMatch(/^closed:/);
    provider.close();
  });
});

describe("MockAnalysisProvider", () => {
  const transcript: TranscriptTurn[] = [
    { speaker: "learner", text: "Yesterday I go to work by train.", startedAt: 1000, endedAt: 3000 },
    { speaker: "coach", text: "Tell me about it.", startedAt: 3100, endedAt: 3600 },
    { speaker: "learner", text: "Yesterday I go home late at night.", startedAt: 3700, endedAt: 4500 },
    { speaker: "coach", text: "Good story.", startedAt: 4600, endedAt: 5000 },
    { speaker: "learner", text: "Yesterday I go shopping in the evening.", startedAt: 5100, endedAt: 6000 },
    { speaker: "learner", text: "I go there since five years.", startedAt: 6100, endedAt: 7000 },
  ];

  it("returns schema-valid analysis flagging the recurring past-tense pattern", async () => {
    const analysis = await new MockAnalysisProvider().analyze({
      learnerId: "learner-1",
      transcript,
      metrics: {
        speakingSeconds: 12, userWordCount: 18, wordsPerMinute: 90,
        pauseCount: 1, avgPauseMs: 200, longestPauseMs: 200,
        utteranceCount: 3, avgUtteranceWords: 6, rmsEnergyAvg: 0.2,
      },
      learnerContext: {
        level: "B1+", goals: ["fluency"], strengths: [], activeWeaknesses: [],
        vocabularyTargets: [], difficulty: 0.6, correctionStyle: "moderate",
        recentTopics: [], currentSessionTargets: ["grammar.past_tense"],
      },
      sessionTargets: ["grammar.past_tense"],
    });
    const parsed = SessionAnalysisSchema.parse(analysis); // must not throw
    const pastTense = parsed.observations.filter((o) => o.skill === "grammar.past_tense");
    expect(pastTense.length).toBeGreaterThanOrEqual(3);
    expect(parsed.recurring_errors.some((r) => r.skill === "grammar.past_tense")).toBe(true);
  });
});

describe("MockAnalysisProvider.plan", () => {
  it("returns a plan draft with ranked candidates and a difficulty-appropriate topic", async () => {
    const ctx = {
      level: "B1+", goals: ["grammar"], strengths: [], activeWeaknesses: ["grammar.past_tense"],
      vocabularyTargets: [], difficulty: 0.75, correctionStyle: "moderate",
      recentTopics: ["Your last vacation"], currentSessionTargets: ["grammar.past_tense"],
    };
    const draft = await new MockAnalysisProvider().plan({
      difficulty: 0.75,
      candidates: ["grammar.past_tense", "vocabulary.precision"],
      learnerContext: ctx,
    });
    expect(draft.topic.length).toBeGreaterThan(5);
    expect(draft.topic).not.toBe("Your last vacation");
    expect(draft.candidateSkills[0]).toBe("grammar.past_tense");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run packages/prompts packages/openai`
Expected: FAIL — modules missing.

- [ ] **Step 4: Implement `packages/prompts/src/index.ts`**

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export type PromptName = "conversation" | "analysis" | "planning" | "memory";

export interface PromptVersion {
  name: PromptName;
  version: string;
  model: string;
  temperature: number;
}

const REGISTRY: Record<PromptName, PromptVersion & { file: string }> = {
  conversation: { name: "conversation", version: "v1", model: "realtime", temperature: 0.7, file: "conversation/v1.txt" },
  analysis: { name: "analysis", version: "v1", model: "responses", temperature: 0.2, file: "analysis/v1.txt" },
  planning: { name: "planning", version: "v1", model: "responses", temperature: 0.4, file: "planning/v1.txt" },
  memory: { name: "memory", version: "v1", model: "responses", temperature: 0.1, file: "memory/v1.txt" },
};

export function promptMeta(name: PromptName): PromptVersion {
  const { file: _file, ...meta } = REGISTRY[name];
  return meta;
}

export function loadPrompt(name: PromptName): string {
  return readFileSync(path.join(root, "../prompts", REGISTRY[name].file), "utf8");
}

export function renderPrompt(name: PromptName, vars: Record<string, string>): string {
  return loadPrompt(name).replace(/\{\{(\w+)\}\}/g, (m, key: string) => (key in vars ? vars[key] : m));
}
```

The `@ec/prompts` package stays dependency-free: `{{skill_codes}}` and all other slots are filled by callers (the API worker passes `SKILL_CODES.join("\n")` from `@ec/domain`).

- [ ] **Step 5: Implement `packages/openai/src/providers/types.ts`**

Exactly the interface block quoted in **Interfaces** above (import `SessionMetrics`, `LearnerContext`, `SessionAnalysis`, `PlanDraft` from `@ec/domain`).

- [ ] **Step 6: Implement `packages/openai/src/mock/speech.ts`**

```ts
import type { ProviderEvent, SpeechConversationProvider, TranscriptTurn } from "../providers/types.js";

export interface MockTurn {
  speaker: "learner" | "coach";
  text: string;
  pauseMs?: number;
  toolCall?: { name: "request_micro_coaching" | "request_target_retry"; skill: string; reason?: string };
}

/**
 * Emits a scripted dialogue on connect. `autoClose` (default true) emits a
 * `closed` event when the script is exhausted; pass `{ turns, autoClose: false }`
 * for long-running sessions where the client ends the call.
 */
export class MockSpeechProvider implements SpeechConversationProvider {
  private onEvent: ((e: ProviderEvent) => void) | null = null;
  private closed = false;

  constructor(private readonly script: { turns: MockTurn[]; autoClose?: boolean }) {}

  async connect(onEvent: (e: ProviderEvent) => void): Promise<void> {
    this.onEvent = onEvent;
    onEvent({ t: "connected" });
    this.play(0);
  }

  private async play(i: number): Promise<void> {
    for (; i < this.script.turns.length; i++) {
      if (this.closed) return;
      const turn = this.script.turns[i];
      const pause = turn.pauseMs ?? 150;
      await sleep(pause);
      if (this.closed) return;
      const startedAt = Date.now();
      const durationMs = Math.max(400, turn.text.split(" ").length * 300);
      const turnEvent: TranscriptTurn = {
        speaker: turn.speaker, text: turn.text,
        startedAt, endedAt: startedAt + durationMs,
      };
      this.onEvent?.({ t: "transcript", turn: turnEvent });
      this.onEvent?.({ t: "audio", data: Buffer.alloc(1280), sampleRate: 16000 }); // 40 ms silence @16 kHz
      if (turn.toolCall) {
        await sleep(50);
        this.onEvent?.({ t: "tool_call", name: turn.toolCall.name, skill: turn.toolCall.skill, reason: turn.toolCall.reason });
      }
    }
    if (!this.closed && this.script.autoClose !== false) {
      this.closed = true;
      this.onEvent?.({ t: "closed", reason: "script_finished" });
    }
  }

  sendAudio(_pcm16: Buffer): void { /* mock ignores learner audio */ }
  sendInstruction(_text: string): void { /* mock ignores instructions */ }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onEvent?.({ t: "closed", reason: "client_closed" });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
```

The mock emits 16 kHz-rate audio; the real provider (Task 12) emits 24 kHz. The `sampleRate` field on audio events tells the web client which playback path to use.

- [ ] **Step 7: Implement `packages/openai/src/mock/analysis.ts`**

Deterministic keyword lexicon — the mock is the e2e test oracle, so it must be exact:

```ts
import type { LearnerContext, PlanDraft, SessionAnalysis, SessionMetrics } from "@ec/domain";
import type { AnalysisInput, AnalysisProvider, TranscriptTurn } from "../providers/types.js";

type LexiconEntry = {
  match: (text: string) => boolean;
  skill: string;
  pattern: string;
  actual: string;
  expected: string;
  severity: number;
  confidence: number;
};

const LEXICON: LexiconEntry[] = [
  { match: (t) => /yesterday i go\b/i.test(t) || /\bi go to (work|home)\b/i.test(t) && /yesterday/i.test(t),
    skill: "grammar.past_tense", pattern: "present_form_after_past_time_expression",
    actual: "go", expected: "went", severity: 0.65, confidence: 0.97 },
  { match: (t) => /\bsince (five|three|two|ten) years\b/i.test(t),
    skill: "grammar.present_perfect", pattern: "present_with_since_duration",
    actual: "I go there since five years", expected: "I have been there for five years",
    severity: 0.6, confidence: 0.9 },
  { match: (t) => /\bto hospital\b(?! (a|the))\b/i.test(t) || /\ba hospital\b/i.test(t),
    skill: "grammar.articles", pattern: "missing_or_wrong_article_place",
    actual: "to hospital", expected: "to the hospital",
    severity: 0.4, confidence: 0.92 },
];

export class MockAnalysisProvider implements AnalysisProvider {
  async analyze(input: AnalysisInput): Promise<SessionAnalysis> {
    const learnerTurns = input.transcript.filter((t) => t.speaker === "learner");
    const observations: SessionAnalysis["observations"] = [];
    const perSkill = new Map<string, { count: number; confidence: number }>();

    for (const turn of learnerTurns) {
      for (const entry of LEXICON) {
        if (entry.match(turn.text)) {
          observations.push({
            type: "language_error", skill: entry.skill,
            evidence: turn.text, actual: entry.actual, expected: entry.expected,
            severity: entry.severity, confidence: entry.confidence,
          });
          const cur = perSkill.get(entry.skill) ?? { count: 0, confidence: 0 };
          perSkill.set(entry.skill, { count: cur.count + 1, confidence: Math.max(cur.confidence, entry.confidence) });
        }
      }
    }

    const recurring = [...perSkill.entries()]
      .filter(([, v]) => v.count >= 3)
      .map(([skill, v]) => ({ skill, pattern: LEXICON.find((e) => e.skill === skill)?.pattern ?? skill, confidence: v.confidence }));

    const strengths = input.transcript.some((t) => t.speaker === "learner" && /\bnegotiate\b/i.test(t.text))
      ? [{ skill: "vocabulary.precision", evidence: "used 'negotiate' in context", confidence: 0.8 }]
      : [];

    const recommended = [...new Set([...recurring.map((r) => r.skill), ...input.sessionTargets])];

    return {
      scores: deterministicScores(input.metrics),
      observations,
      recurring_errors: recurring,
      strengths,
      recommended_targets: recommended,
    };
  }

  async plan(input: { difficulty: number; candidates: string[]; learnerContext: LearnerContext }): Promise<PlanDraft> {
    const topic = input.difficulty >= 0.7
      ? "Convince a colleague to accept a policy you both dislike"
      : input.difficulty >= 0.5
        ? "Describe a difficult decision you made at work"
        : "Tell me about your last weekend";
    const avoid = new Set(input.learnerContext.recentTopics);
    const finalTopic = avoid.has(topic) ? "Talk about a book or film that changed your mind" : topic;
    return { topic: finalTopic, candidateSkills: input.candidates.slice(0, 3), reason: "Top-ranked recurring weaknesses selected for the next session." };
  }
}

function deterministicScores(m: SessionMetrics): SessionAnalysis["scores"] {
  const fluency = clamp01(0.5 + (m.wordsPerMinute - 90) / 200 - (m.longestPauseMs > 3000 ? 0.1 : 0));
  return {
    fluency,
    grammar: 0.62,
    vocabulary: 0.7,
    pronunciation: 0.78,
    coherence: 0.7,
    interaction: 0.8,
  };
}

function clamp01(x: number): number { return Math.min(1, Math.max(0, x)); }
```

- [ ] **Step 8: Implement `packages/openai/src/index.ts`**

```ts
import type { AnalysisProvider, SpeechConversationProvider } from "./providers/types.js";
import { MockSpeechProvider, type MockTurn } from "./mock/speech.js";
import { MockAnalysisProvider } from "./mock/analysis.js";

export * from "./providers/types.js";
export { MockSpeechProvider, MockAnalysisProvider };
export type { MockTurn };

export function selectSpeechProvider(
  env: { PROVIDER?: string; OPENAI_API_KEY?: string },
  script?: { turns: MockTurn[] },
): SpeechConversationProvider {
  if (env.PROVIDER === "openai" && env.OPENAI_API_KEY) {
    // Real branch lands in Task 12. Until then this combination is a config error.
    throw new Error("Realtime provider not configured for this build; set PROVIDER=mock");
  }
  return new MockSpeechProvider(script ?? { turns: [] });
}

export function selectAnalysisProvider(
  env: { PROVIDER?: string; OPENAI_API_KEY?: string },
): AnalysisProvider {
  if (env.PROVIDER === "openai" && env.OPENAI_API_KEY) {
    throw new Error("Real analysis provider not configured for this build; set PROVIDER=mock");
  }
  return new MockAnalysisProvider();
}
```

(Task 12 replaces the throw branches with real implementations.)

- [ ] **Step 9: Run tests to verify they pass**

Run: `pnpm vitest run packages/prompts packages/openai`
Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "feat(prompts,openai): versioned prompts, provider interfaces, mock providers"
```

---
### Task 6a: Session state machine + metrics + SessionService

**Files:**
- Create: `apps/api/src/stateMachine.ts`
- Create: `apps/api/src/metrics.ts`
- Create: `apps/api/src/services/session.ts`
- Create: `apps/api/src/env.ts`
- Test: `apps/api/src/stateMachine.test.ts`, `apps/api/src/metrics.test.ts`, `apps/api/src/services/session.test.ts`

**Interfaces:**
- Consumes: `@ec/domain` (types), `@ec/db` (`db`, `openDb`, `sessions`, `utterances`, `observations`, `learningPlans`, `parseJson`, `DrizzleDb`), `@ec/learning-engine` (not yet — only Tasks 7/8).
- Produces:
  - `stateMachine.ts`:
    ```ts
    export type { SessionState } from "@ec/domain";
    export function canTransition(from: SessionState, to: SessionState): boolean;
    export function nextAllowed(from: SessionState): SessionState[];
    ```
  - `metrics.ts`:
    ```ts
    export interface MetricsAccumulator {
      addLearnerUtterance(text: string, startedAt: number, endedAt: number, pauseBeforeMs: number): void;
      finish(now: number): SessionMetrics;   // SessionMetrics from @ec/domain
    }
    export function newAccumulator(): MetricsAccumulator;
    export function computeMetrics(turns: TranscriptTurn[], now: number): SessionMetrics; // pure; for tests + replay
    ```
  - `services/session.ts`:
    ```ts
    export class SessionService {
      constructor(private readonly d: DrizzleDb);
      createSession(learnerId: string, now: number): { id: string; topic: string; difficulty: number; state: SessionState };
      // Loads the active learning plan (or a default plan) for the learner.
      recordUtterance(sessionId: string, turn: { speaker: "learner" | "coach"; text: string; startedAt: number; endedAt: number }): { utteranceId: string; seq: number };
      recordIntervention(sessionId: string, kind: "micro_coach" | "target_retry" | "challenge", skill: string, now: number): void;
      transition(sessionId: string, to: SessionState, now: number): boolean; // false if illegal; persists + returns true otherwise
      getRecord(sessionId: string): SessionRecord | null;
      getLearnerContext(sessionId: string): LearnerContext;  // spec §7.3; used by bridge + workers
      // End path (Task 5's double-end rule):
      //   - only legal from CONVERSATION/MICRO_COACH/TARGET_RETRY/CHALLENGE/CLOSING/STARTING/WARMUP
      //   - second call returns { ok: false, reason: "already_ended" }
      endSession(sessionId: string, now: number): { ok: boolean; reason?: string; metrics: SessionMetrics };
    }
    ```
  - `env.ts`:
    ```ts
    export interface Env { PORT: number; HOST: string; DB_PATH: string; PROVIDER: "mock" | "openai"; OPENAI_API_KEY: string | undefined; WARMUP_MS: number; SESSION_TARGET_MS: number; }
    export function loadEnv(): Env;  // reads process.env with defaults: PORT=3100, HOST=127.0.0.1, DB_PATH=./data/english-coach.db, PROVIDER=mock, WARMUP_MS=120000, SESSION_TARGET_MS=900000
    ```

- [ ] **Step 1: Write failing tests**

`apps/api/src/stateMachine.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { canTransition } from "./stateMachine.js";

describe("state machine", () => {
  it("follows the spec transition table", () => {
    const ok: [Parameters<typeof canTransition>[0], Parameters<typeof canTransition>[1]][] = [
      ["STARTING", "WARMUP"], ["STARTING", "CLOSING"], ["STARTING", "FAILED"],
      ["WARMUP", "CONVERSATION"], ["WARMUP", "CLOSING"], ["WARMUP", "FAILED"],
      ["CONVERSATION", "CONVERSATION"], ["CONVERSATION", "MICRO_COACH"],
      ["CONVERSATION", "TARGET_RETRY"], ["CONVERSATION", "CHALLENGE"], ["CONVERSATION", "CLOSING"],
      ["MICRO_COACH", "CONVERSATION"], ["MICRO_COACH", "TARGET_RETRY"], ["MICRO_COACH", "CLOSING"],
      ["TARGET_RETRY", "CONVERSATION"], ["TARGET_RETRY", "CLOSING"],
      ["CHALLENGE", "CONVERSATION"], ["CHALLENGE", "CLOSING"],
      ["CLOSING", "ANALYZING"], ["ANALYZING", "COMPLETED"], ["ANALYZING", "FAILED"],
    ];
    for (const [from, to] of ok) expect(canTransition(from, to), `${from} -> ${to}`).toBe(true);
  });
  it("rejects illegal transitions", () => {
    expect(canTransition("STARTING", "CONVERSATION")).toBe(false);   // no warmup skip
    expect(canTransition("ANALYZING", "CONVERSATION")).toBe(false);
    expect(canTransition("ANALYZING", "CLOSING")).toBe(false);       // analysis is one-way
    expect(canTransition("COMPLETED", "WARMUP")).toBe(false);
    expect(canTransition("COMPLETED", "ANALYZING")).toBe(false);
    expect(canTransition("FAILED", "WARMUP")).toBe(false);
    expect(canTransition("FAILED", "CLOSING")).toBe(false);
    expect(canTransition("CLOSING", "CONVERSATION")).toBe(false);
  });
});
```

`apps/api/src/metrics.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { newAccumulator, computeMetrics } from "./metrics.js";
import type { TranscriptTurn } from "@ec/openai";

describe("computeMetrics", () => {
  it("computes word count, WPM, and pause stats from learner turns", () => {
    const turns: TranscriptTurn[] = [
      { speaker: "learner", text: "Yesterday I went to work by train", startedAt: 1000, endedAt: 4000 },
      { speaker: "coach", text: "Nice.", startedAt: 4100, endedAt: 4500 },
      { speaker: "learner", text: "It takes about twenty minutes", startedAt: 4900, endedAt: 7000 },
    ];
    const m = computeMetrics(turns, 10_000);
    expect(m.userWordCount).toBe(12);
    expect(m.utteranceCount).toBe(2);
    expect(m.speakingSeconds).toBe(5);              // 3s + 2s of learner speech
    expect(m.wordsPerMinute).toBe(144);            // 12 words / (5s/60) — speaking-time basis
    expect(m.pauseCount).toBe(1);                    // 4900 - 4000 = 900ms gap > 800ms threshold
    expect(m.avgPauseMs).toBe(900);
    expect(m.longestPauseMs).toBe(900);
    expect(m.avgUtteranceWords).toBe(6);
  });
  it("handles a session with no learner speech", () => {
    const m = computeMetrics([{ speaker: "coach", text: "Hello?", startedAt: 0, endedAt: 1000 }], 2000);
    expect(m.userWordCount).toBe(0);
    expect(m.wordsPerMinute).toBe(0);
    expect(m.pauseCount).toBe(0);
  });
});

describe("MetricsAccumulator", () => {
  it("matches computeMetrics on the same data", () => {
    const acc = newAccumulator();
    acc.addLearnerUtterance("Yesterday I went to work by train", 1000, 4000, 0);
    acc.addLearnerUtterance("It takes about twenty minutes", 4900, 7000, 500);
    const m = acc.finish(10_000);
    expect(m.userWordCount).toBe(12);
    expect(m.pauseCount).toBe(1);
    expect(m.speakingSeconds).toBe(5);
  });
});
```

`apps/api/src/services/session.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { openDb, db, migrate, ensureSeed } from "@ec/db";
import { SessionService } from "./session.js";
import { LEARNER_ID } from "@ec/domain";

let sqlite: Database.Database;
let service: SessionService;
let now: number;

beforeEach(() => {
  sqlite = openDb(":memory:");
  migrate(sqlite);
  ensureSeed(sqlite);
  service = new SessionService(db(sqlite));
  now = 1_000_000_000_000;
});

describe("SessionService", () => {
  it("creates a session with a default plan when none exists", () => {
    const s = service.createSession(LEARNER_ID, now);
    expect(s.id).toMatch(/^sess-/);
    expect(s.difficulty).toBe(0.5); // default before any history
    expect(service.getRecord(s.id)?.state).toBe("STARTING");
  });

  it("walks the happy path and rejects illegal transitions", () => {
    const s = service.createSession(LEARNER_ID, now);
    expect(service.transition(s.id, "WARMUP", now)).toBe(true);
    expect(service.transition(s.id, "CONVERSATION", now)).toBe(true);
    expect(service.transition(s.id, "STARTING", now)).toBe(false); // illegal
    service.transition(s.id, "CLOSING", now);
    expect(service.transition(s.id, "ANALYZING", now)).toBe(true);
  });

  it("records learner utterances sequentially and computes pauses", () => {
    const s = service.createSession(LEARNER_ID, now);
    service.transition(s.id, "WARMUP", now);
    service.transition(s.id, "CONVERSATION", now);
    const u1 = service.recordUtterance(s.id, { speaker: "learner", text: "Yesterday I went to work", startedAt: now, endedAt: now + 3000 });
    expect(u1.seq).toBe(1);
    const u2 = service.recordUtterance(s.id, { speaker: "coach", text: "Good.", startedAt: now + 3100, endedAt: now + 3400 });
    expect(u2.seq).toBe(2);
  });

  it("records interventions as observations rows", () => {
    const s = service.createSession(LEARNER_ID, now);
    service.transition(s.id, "WARMUP", now);
    service.transition(s.id, "CONVERSATION", now);
    service.recordIntervention(s.id, "micro_coach", "grammar.past_tense", now);
    const rows = db(sqlite).query(
      `SELECT type, skill_code FROM observations WHERE session_id = ?`,
    ).all(s.id);
    expect(rows).toEqual([{ type: "micro_coach", skill_code: "grammar.past_tense" }]);
  });

  it("ends a session once: second end is rejected (Review Focus 3)", () => {
    const s = service.createSession(LEARNER_ID, now);
    service.transition(s.id, "WARMUP", now);
    service.transition(s.id, "CONVERSATION", now);
    service.recordUtterance(s.id, { speaker: "learner", text: "I went home", startedAt: now, endedAt: now + 2000 });
    const first = service.endSession(s.id, now + 60000);
    expect(first.ok).toBe(true);
    expect(first.metrics.speakingSeconds).toBe(2);
    const second = service.endSession(s.id, now + 61000);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("already_ended");
    expect(service.getRecord(s.id)?.state).toBe("ANALYZING");
  });

  it("endSession from STARTING (user bails immediately) works", () => {
    const s = service.createSession(LEARNER_ID, now);
    const out = service.endSession(s.id, now + 5000);
    expect(out.ok).toBe(true);
    expect(out.metrics.userWordCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd english-coach && pnpm vitest run apps/api`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement `stateMachine.ts`**

```ts
import type { SessionState } from "@ec/domain";

// CLOSING is reachable from every active state so a learner can end the
// session at any time (end path: CLOSING → ANALYZING). FAILED is also
// reachable from every active state (the realtime provider can drop the
// connection mid-session). Terminal states accept no transitions.
const TRANSITIONS: Record<SessionState, SessionState[]> = {
  STARTING: ["WARMUP", "CLOSING", "FAILED"],
  WARMUP: ["CONVERSATION", "CLOSING", "FAILED"],
  CONVERSATION: ["CONVERSATION", "MICRO_COACH", "TARGET_RETRY", "CHALLENGE", "CLOSING", "FAILED"],
  MICRO_COACH: ["CONVERSATION", "TARGET_RETRY", "CLOSING", "FAILED"],
  TARGET_RETRY: ["CONVERSATION", "CLOSING", "FAILED"],
  CHALLENGE: ["CONVERSATION", "CLOSING", "FAILED"],
  CLOSING: ["ANALYZING"],
  ANALYZING: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  FAILED: [],
};

export function canTransition(from: SessionState, to: SessionState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function nextAllowed(from: SessionState): SessionState[] {
  return TRANSITIONS[from] ?? [];
}
```

- [ ] **Step 4: Implement `metrics.ts`**

`avgPauseMs` is computed by `computeMetrics` (which has the full ordered turn list); the live accumulator leaves it 0 — the worker always recomputes from persisted utterances via `computeMetrics`, which is the single source of truth for persisted metrics.

```ts
import type { SessionMetrics } from "@ec/domain";
import type { TranscriptTurn } from "@ec/openai";

const PAUSE_THRESHOLD_MS = 800;

interface Turn { text: string; startedAt: number; endedAt: number; }

export interface MetricsAccumulator {
  addLearnerUtterance(text: string, startedAt: number, endedAt: number, pauseBeforeMs: number): void;
  finish(now: number): SessionMetrics;
}

export function newAccumulator(): MetricsAccumulator {
  const turns: Turn[] = [];
  let pauseSum = 0;
  let longestPause = 0;

  return {
    addLearnerUtterance(text, startedAt, endedAt, pauseBeforeMs) {
      turns.push({ text, startedAt, endedAt });
      if (pauseBeforeMs > 0) {
        pauseSum += pauseBeforeMs;
        longestPause = Math.max(longestPause, pauseBeforeMs);
      }
    },
    finish(now) {
      void now;
      const speakingMs = turns.reduce((s, t) => s + Math.max(0, t.endedAt - t.startedAt), 0);
      const speakingSeconds = Math.round(speakingMs / 1000);
      const userWordCount = turns.reduce((s, t) => s + t.text.split(/\s+/).filter(Boolean).length, 0);
      return {
        speakingSeconds,
        userWordCount,
        wordsPerMinute: speakingSeconds > 0 ? Math.round(userWordCount / (speakingSeconds / 60)) : 0,
        pauseCount: turns.length > 1 && longestPause > 0 ? turns.filter((t, i) => i > 0 && pauseBefore(t, turns[i - 1])).length : 0,
        avgPauseMs: 0,
        longestPauseMs: longestPause,
        utteranceCount: turns.length,
        avgUtteranceWords: turns.length > 0 ? Math.round(userWordCount / turns.length) : 0,
        rmsEnergyAvg: 0,
      };
    },
  };

  function pauseBefore(t: Turn, prev: Turn): boolean {
    return t.startedAt - prev.endedAt > PAUSE_THRESHOLD_MS;
  }
}

export function computeMetrics(turns: TranscriptTurn[], now: number): SessionMetrics {
  const acc = newAccumulator();
  let prevEnd: number | null = null;
  for (const t of turns) {
    if (t.speaker !== "learner") continue;
    const pause = prevEnd !== null && t.startedAt - prevEnd > PAUSE_THRESHOLD_MS ? t.startedAt - prevEnd : 0;
    acc.addLearnerUtterance(t.text, t.startedAt, t.endedAt, pause);
    prevEnd = t.endedAt;
  }
  void now;
  const base = acc.finish(now);
  return {
    ...base,
    avgPauseMs: base.pauseCount > 0 ? Math.round((turns
      .filter((t) => t.speaker === "learner")
      .map((t, i, arr) => i > 0 && t.speaker === "learner"
        ? t.startedAt - prevLearnerEnd(arr, i) : 0)
      .filter((p) => p > PAUSE_THRESHOLD_MS)
      .reduce((a, b) => a + b, 0)) / base.pauseCount) : 0,
  };
  function prevLearnerEnd(arr: TranscriptTurnLike[], i: number): number {
    for (let j = i - 1; j >= 0; j--) if (arr[j].speaker === "learner") return arr[j].endedAt;
    return 0;
  }
}

type TranscriptTurnLike = { speaker: "learner" | "coach"; text: string; startedAt: number; endedAt: number };
```

`avgPauseMs` in the accumulator is left 0 for simplicity; `computeMetrics` (used by the worker, which has the full turn list) computes it properly. Accept this asymmetry — the accumulator is only used live; the worker recomputes from persisted utterances via `computeMetrics` (single source of truth for persisted metrics).

- [ ] **Step 5: Implement `env.ts`**

```ts
export interface Env {
  PORT: number;
  HOST: string;
  DB_PATH: string;
  PROVIDER: "mock" | "openai";
  OPENAI_API_KEY: string | undefined;
  WARMUP_MS: number;
  SESSION_TARGET_MS: number;
}

export function loadEnv(env: NodeJS.ProcessEnv = process.env): Env {
  return {
    PORT: Number(env.PORT ?? 3100),
    HOST: env.HOST ?? "127.0.0.1",
    DB_PATH: env.DB_PATH ?? "./data/english-coach.db",
    PROVIDER: (env.PROVIDER as "mock" | "openai") ?? "mock",
    OPENAI_API_KEY: env.OPENAI_API_KEY,
    WARMUP_MS: Number(env.WARMUP_MS ?? 120_000),
    SESSION_TARGET_MS: Number(env.SESSION_TARGET_MS ?? 900_000),
  };
}
```

- [ ] **Step 6: Implement `services/session.ts`**

```ts
import { randomUUID } from "node:crypto";
import {
  and, eq, inArray, isNull, desc,
} from "drizzle-orm";
import {
  learners, goalsTable, skills, errorPatterns, vocabularyItems,
  sessions, utterances, observations, learningPlans,
} from "@ec/db";
import type { DrizzleDb } from "@ec/db";
import {
  LEARNER_ID, type LearnerContext, type SessionRecord, type SessionState,
} from "@ec/domain";
import { canTransition } from "../stateMachine.js";
import { computeMetrics } from "../metrics.js";

export class SessionService {
  constructor(private readonly d: DrizzleDb) {}

  createSession(learnerId: string, now: number): { id: string; topic: string; difficulty: number; state: SessionState } {
    const plan = this.d.select().from(learningPlans)
      .where(and(eq(learningPlans.learnerId, learnerId), eq(learningPlans.status, "active")))
      .orderBy(desc(learningPlans.createdAt)).all()[0];
    const difficulty = plan ? plan.difficulty : 0.5;
    const topic = plan?.topic ?? "Free conversation about your day";
    const id = `sess-${randomUUID()}`;
    this.d.insert(sessions).values({
      id, learnerId, status: "STARTING", topic,
      plannedDifficulty: difficulty,
      startedAt: now,
    }).run();
    return { id, topic, difficulty, state: "STARTING" };
  }

  recordUtterance(sessionId: string, turn: { speaker: "learner" | "coach"; text: string; startedAt: number; endedAt: number }): { utteranceId: string; seq: number } {
    const last = this.d.select().from(utterances)
      .where(and(eq(utterances.sessionId, sessionId), eq(utterances.speaker, "learner")))
      .orderBy(utterances.sequenceNumber).all()
      .filter((u) => u.sequenceNumber % 2 === 1).at(-1);
    const pauseBeforeMs = last ? Math.max(0, turn.startedAt - (last.endedAt ?? turn.startedAt)) : 0;
    const seq = (this.d.select().from(utterances).where(eq(utterances.sessionId, sessionId)).all().length) + 1;
    const id = `utt-${randomUUID()}`;
    this.d.insert(utterances).values({
      id, sessionId, speaker: turn.speaker, sequenceNumber: seq,
      text: turn.text, startedAt: turn.startedAt, endedAt: turn.endedAt,
      durationMs: turn.endedAt - turn.startedAt,
      wordCount: turn.text.split(/\s+/).filter(Boolean).length,
      pauseBeforeMs: turn.speaker === "learner" ? pauseBeforeMs : 0,
    }).run();
    return { utteranceId: id, seq };
  }

  recordIntervention(sessionId: string, kind: "micro_coach" | "target_retry" | "challenge", skill: string, now: number): void {
    this.d.insert(observations).values({
      id: `obs-${randomUUID()}`, sessionId, type: kind,
      skillCode: skill, evidence: null,
      severity: null, confidence: 0.9, createdAt: now,
    }).run();
  }

  transition(sessionId: string, to: SessionState, now: number): boolean {
    const row = this.d.select().from(sessions).where(eq(sessions.id, sessionId)).all()[0];
    if (!row || !canTransition(row.status as SessionState, to)) return false;
    this.d.update(sessions).set({ status: to, updatedAt: now } as Partial<typeof sessions.$inferSelect> & Record<string, unknown>)
      .where(eq(sessions.id, sessionId)).run();
    if (to === "ANALYZING") this.d.update(sessions).set({ endedAt: now }).where(eq(sessions.id, sessionId)).run();
    return true;
  }

  getRecord(sessionId: string): SessionRecord | null {
    const r = this.d.select().from(sessions).where(eq(sessions.id, sessionId)).all()[0];
    if (!r) return null;
    return {
      id: r.id, state: r.status as SessionState, topic: r.topic ?? "",
      plannedDifficulty: r.plannedDifficulty ?? 0,
      achievedDifficulty: r.achievedDifficulty ?? r.plannedDifficulty ?? 0,
      startedAt: r.startedAt, endedAt: r.endedAt,
      scores: null, analysis: null, metrics: null, // filled by Task 7
    };
  }

  getLearnerContext(sessionId: string): LearnerContext {
    const s = this.d.select().from(sessions).where(eq(sessions.id, sessionId)).all()[0];
    if (!s) throw new Error(`unknown session ${sessionId}`);
    const learner = this.d.select().from(learners).where(eq(learners.id, s.learnerId)).all()[0];
    const plan = this.d.select().from(learningPlans)
      .where(and(eq(learningPlans.learnerId, s.learnerId), eq(learningPlans.status, "active")))
      .orderBy(desc(learningPlans.createdAt)).all()[0];
    const goals = this.d.select().from(goalsTable)
      .where(and(eq(goalsTable.learnerId, s.learnerId), eq(goalsTable.status, "active"))).all();
    const recurring = this.d.select().from(errorPatterns)
      .where(and(eq(errorPatterns.learnerId, s.learnerId), eq(errorPatterns.status, "active")))
      .all()
      .filter((e) => e.frequency >= 3 && e.confidence >= 0.75)
      .map((e) => e.skillCode);
    const strengths = this.d.select().from(skills)
      .where(and(eq(skills.learnerId, s.learnerId), eq(skills.trend, "improving"))).all()
      .map((sk) => sk.code);
    const recent = this.d.select().from(sessions)
      .where(and(eq(sessions.learnerId, s.learnerId), neq(sessions.id, s.id), isNotNull(sessions.topic)))
      .orderBy(desc(sessions.startedAt)).all()
      .slice(0, 5).map((x) => x.topic ?? "").filter(Boolean);
    const primary = parsePrimaryTargets(plan);
    return {
      level: learner.estimatedLevel ?? learner.targetLevel ?? "B1",
      goals: goals.map((g) => g.description),
      strengths,
      activeWeaknesses: recurring,
      vocabularyTargets: [],
      difficulty: plan?.difficulty ?? s.plannedDifficulty ?? 0.5,
      correctionStyle: learner.correctionStyle,
      recentTopics: recent,
      currentSessionTargets: primary,
    };
  }

  endSession(sessionId: string, now: number): { ok: boolean; reason?: string; metrics: import("@ec/domain").SessionMetrics } {
    const row = this.d.select().from(sessions).where(eq(sessions.id, sessionId)).all()[0];
    if (!row) return { ok: false, reason: "not_found", metrics: emptyMetrics() };
    if (["ANALYZING", "COMPLETED", "FAILED"].includes(row.status)) {
      return { ok: false, reason: "already_ended", metrics: emptyMetrics() };
    }
    const turns = this.d.select().from(utterances)
      .where(eq(utterances.sessionId, sessionId)).all()
      .map((u) => ({ speaker: u.speaker as "learner" | "coach", text: u.text, startedAt: u.startedAt ?? 0, endedAt: u.endedAt ?? 0 }))
      .sort((a, b) => a.startedAt - b.startedAt);
    const metrics = computeMetrics(turns, now);
    this.transition(sessionId, "CLOSING", now);
    this.transition(sessionId, "ANALYZING", now);
    this.d.update(sessions).set({
      endedAt: now,
      durationSeconds: Math.round((now - row.startedAt) / 1000),
      metrics: JSON.stringify(metrics),
    }).where(eq(sessions.id, sessionId)).run();
    return { ok: true, metrics };
  }
}

function parsePrimaryTargets(plan: { primaryTargets: string | null } | undefined): string[] {
  if (!plan?.primaryTargets) return [];
  try { return JSON.parse(plan.primaryTargets) as string[]; } catch { return []; }
}

function emptyMetrics(): import("@ec/domain").SessionMetrics {
  return { speakingSeconds: 0, userWordCount: 0, wordsPerMinute: 0, pauseCount: 0, avgPauseMs: 0, longestPauseMs: 0, utteranceCount: 0, avgUtteranceWords: 0, rmsEnergyAvg: 0 };
}
```

Also import `neq` from `drizzle-orm` (used in `getLearnerContext`).

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm vitest run apps/api`
Expected: PASS (state machine + metrics + session service suites).

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(api): session state machine, deterministic metrics, session service"
```

---
### Task 6b: Realtime bridge + WebSocket + HTTP routes + server

The bridge is the only component that talks to a `SpeechConversationProvider`. It translates normalized provider events into the client protocol (spec §8.1) and drives state-machine transitions on tool calls and timers.

**Files:**
- Create: `apps/api/src/realtime/bridge.ts`
- Create: `apps/api/src/routes/ws-session.ts`
- Create: `apps/api/src/routes/sessions.ts`
- Create: `apps/api/src/routes/learners.ts`
- Create: `apps/api/src/server.ts`
- Create: `apps/api/src/app.ts` (buildApp(deps) — export for testing)
- Test: `apps/api/tests/bridge.test.ts`, `apps/api/tests/api.test.ts`

**Interfaces:**
- Consumes: `SessionService` (6a), `@ec/openai` provider types, `@ec/prompts` (`renderPrompt`, `promptMeta`), `@ec/db`, `@ec/domain`.
- Produces:
  - `bridge.ts`:
    ```ts
    export type ClientMessage =
      | { t: "audio"; data: string }                     // base64 PCM16 16kHz mono
      | { t: "control"; action: "start" | "end" | "mute" | "unmute" };
    export type ServerMessage =
      | { t: "audio"; data: string; sampleRate: number }
      | { t: "transcript"; speaker: "learner" | "coach"; text: string; seq: number; startedAt: number; endedAt: number }
      | { t: "state"; state: SessionState }
      | { t: "intervention"; kind: "micro_coach" | "target_retry" | "challenge"; skill: string }
      | { t: "session_ended"; state: SessionState };

    export class RealtimeBridge {
      constructor(opts: {
        sessionId: string;
        provider: SpeechConversationProvider;
        service: SessionService;
        learnerContext: LearnerContext;
        difficulty: number;
        warmupMs: number;
        sessionTargetMs: number;
        onEnded: (result: { state: SessionState }) => void;  // hook for job enqueue
      });
      attach(socket: WebSocket): boolean;   // false if a client is already attached (reject)
      detach(): void;                       // drop the current client (reconnect window opens)
      handleClientMessage(msg: ClientMessage): void;
      destroy(reason: string): void;        // idempotent
      state: SessionState;
      hasClient(): boolean;
    }
    export class BridgeRegistry {
      get(sessionId: string): RealtimeBridge | undefined;
      set(sessionId: string, bridge: RealtimeBridge): void;
      delete(sessionId: string): void;
    }
    ```
  - `app.ts`: `buildApp(deps: { service: SessionService; registry: BridgeRegistry; selectSpeech: (sessionId: string) => SpeechConversationProvider; env: Env; queue: (type: "analyze", sessionId: string) => void }): FastifyInstance`
  - `server.ts`: wires everything for production (env, db, providers, in-process job runner from Task 7) and listens.
  - Routes (spec §13, subset — learners endpoints come with Task 8's LearnerService, but the route file is created here with goals + profile + plan + skills + progress returning data from the DB directly):
    ```
    POST /v1/learners/:id/sessions      → { sessionId, topic, difficulty, state }
    GET  /v1/sessions/:id                → SessionRecord (+ transcript utterances)
    POST /v1/sessions/:id/end            → { ok, reason?, state }  (409 if already ended)
    GET  /v1/learners/:id                → profile
    GET  /v1/learners/:id/skills
    GET  /v1/learners/:id/learning-plan
    GET  /v1/learners/:id/progress
    GET  /v1/learners/:id/goals · POST /v1/learners/:id/goals · PATCH /v1/learners/:id/goals/:goalId
    WS   /ws/session/:sessionId
    ```

Behavior rules (from spec §7, §8):
- On WS attach: if bridge exists and has no client → re-attach (resume); if it has a client → reject with close code 4000; else create bridge, start provider, transition STARTING→WARMUP, send `state` event.
- Provider `transcript` event → `service.recordUtterance` (seq from service), forward `transcript` to client. On the FIRST learner transcript after WARMUP: transition WARMUP→CONVERSATION.
- Provider `tool_call` → `service.recordIntervention` + transition (MICRO_COACH or TARGET_RETRY) + forward `intervention` + `state`.
- Warmup timer: `WARMUP_MS` after start → WARMUP→CONVERSATION (if still in WARMUP).
- Session target timer: `SESSION_TARGET_MS` after start → CONVERSATION→CHALLENGE (once).
- Client `end` → provider.close(), bridge sends `session_ended` after service.endSession, calls `onEnded` (enqueue analyze job), `registry.delete`.
- Provider `closed` (unexpected) → if session not already ended: transition to FAILED (from any live state via CLOSING is NOT allowed — call `service.transition(id, "FAILED", now)` which is legal from STARTING/WARMUP/CONVERSATION/MICRO_COACH/TARGET_RETRY/CHALLENGE per the transition table), forward `session_ended { state: "FAILED" }`, `onEnded` is NOT called for FAILED sessions (no analysis).
- `sendInstruction` is called on state entry: WARMUP ("Keep it light, no corrections"), CHALLENGE ("Raise cognitive demand: ask follow-up why/how, push for elaboration"), MICRO_COACH ("Make one concise correction, then return to conversation").

- [ ] **Step 1: Write failing tests**

`apps/api/tests/bridge.test.ts` (uses `ws` against a real `buildApp` on an ephemeral port — but for bridge unit coverage we test `RealtimeBridge` directly with a fake client socket):

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { openDb, db, migrate, ensureSeed } from "@ec/db";
import { LEARNER_ID } from "@ec/domain";
import { SessionService } from "../src/services/session.js";
import { RealtimeBridge, type ServerMessage } from "../src/realtime/bridge.js";
import { MockSpeechProvider, type MockTurn } from "@ec/openai";

const SESSION_SCRIPT: MockTurn[] = [
  { speaker: "coach", text: "Hi! How was your week?", pauseMs: 30 },
  { speaker: "learner", text: "Yesterday I go to work by train.", pauseMs: 30 },
  { speaker: "coach", text: "Almost. Try again with 'went'.", pauseMs: 30 },
  { speaker: "learner", text: "Yesterday I went to work by train.", pauseMs: 30,
    toolCall: { name: "request_target_retry", skill: "grammar.past_tense" } },
  { speaker: "coach", text: "Good. What did you do at work?", pauseMs: 30 },
];

function setup() {
  const sqlite = openDb(":memory:");
  migrate(sqlite);
  ensureSeed(sqlite);
  const service = new SessionService(db(sqlite));
  const session = service.createSession(LEARNER_ID, Date.now());
  return { sqlite, service, session };
}

function fakeClient() {
  const sent: ServerMessage[] = [];
  return {
    sent,
    send: (msg: string) => { sent.push(JSON.parse(msg) as ServerMessage); },
    readyState: 1,
  };
}

describe("RealtimeBridge", () => {
  let service: SessionService;
  let sessionId: string;

  beforeEach(() => {
    ({ service, session } = setup());
    sessionId = session.id;
  });

  it("starts in WARMUP, moves to CONVERSATION on first learner utterance", async () => {
    const client = fakeClient();
    const provider = new MockSpeechProvider({ turns: SESSION_SCRIPT, autoClose: false });
    const bridge = new RealtimeBridge({
      sessionId, provider, service,
      learnerContext: service.getLearnerContext(sessionId),
      difficulty: 0.5,
      warmupMs: 10, sessionTargetMs: 999_999,
      onEnded: () => {},
    });
    expect(bridge.attach(client as never)).toBe(true);
    expect(bridge.state).toBe("WARMUP");
    await new Promise((r) => setTimeout(r, 400));
    expect(bridge.state).toBe("CONVERSATION");
    const learnerMsgs = client.sent.filter((m) => m.t === "transcript" && m.speaker === "learner");
    expect(learnerMsgs).toHaveLength(2);
    bridge.destroy("test");
  });

  it("logs intervention and transitions on tool_call (Review Focus 2 partial)", async () => {
    const client = fakeClient();
    const provider = new MockSpeechProvider({ turns: SESSION_SCRIPT, autoClose: false });
    const bridge = new RealtimeBridge({
      sessionId, provider, service,
      learnerContext: service.getLearnerContext(sessionId),
      difficulty: 0.5, warmupMs: 10, sessionTargetMs: 999_999, onEnded: () => {},
    });
    bridge.attach(client as never);
    await new Promise((r) => setTimeout(r, 500));
    expect(client.sent.some((m) => m.t === "intervention" && m.kind === "target_retry" && m.skill === "grammar.past_tense")).toBe(true);
    // state passed through TARGET_RETRY and back to CONVERSATION
    expect(bridge.state).toBe("CONVERSATION");
    bridge.destroy("test");
  });

  it("rejects a second simultaneous client (Review Focus 4)", async () => {
    const provider = new MockSpeechProvider({ turns: [], autoClose: false });
    const bridge = new RealtimeBridge({
      sessionId, provider, service,
      learnerContext: service.getLearnerContext(sessionId),
      difficulty: 0.5, warmupMs: 10, sessionTargetMs: 999_999, onEnded: () => {},
    });
    expect(bridge.attach(fakeClient() as never)).toBe(true);
    expect(bridge.attach(fakeClient() as never)).toBe(false);
    bridge.destroy("test");
  });

  it("re-attaches after a client drops", async () => {
    const provider = new MockSpeechProvider({ turns: [], autoClose: false });
    const bridge = new RealtimeBridge({
      sessionId, provider, service,
      learnerContext: service.getLearnerContext(sessionId),
      difficulty: 0.5, warmupMs: 10, sessionTargetMs: 999_999, onEnded: () => {},
    });
    const first = fakeClient();
    expect(bridge.attach(first as never)).toBe(true);
    bridge.detach();                    // simulate network blip
    const second = fakeClient();
    expect(bridge.attach(second as never)).toBe(true);
    bridge.destroy("test");
  });

  it("marks the session FAILED and notifies the client if the provider drops mid-session (Review Focus 2)", async () => {
    const client = fakeClient();
    // autoClose=true so the mock fires `closed` right after a single turn
    const provider = new MockSpeechProvider({ turns: [
      { speaker: "coach", text: "Hello?", pauseMs: 20 },
    ] });
    let endedState: string | null = null;
    const bridge = new RealtimeBridge({
      sessionId, provider, service,
      learnerContext: service.getLearnerContext(sessionId),
      difficulty: 0.5, warmupMs: 999_999, sessionTargetMs: 999_999,
      onEnded: () => { endedState = "ANALYZING"; },
    });
    bridge.attach(client as never);
    await new Promise((r) => setTimeout(r, 300)); // script runs out -> provider closed
    expect(bridge.state).toBe("FAILED");
    expect(client.sent.some((m) => m.t === "session_ended" && m.state === "FAILED")).toBe(true);
    expect(endedState).toBeNull(); // no analysis job for a FAILED session
    bridge.destroy("test");
  });
});
```

(`attach` needs a public `detach()` for this; add `detach(): void` to the bridge interface — declare it in the `RealtimeBridge` type block in the **Interfaces** section: `attach(socket: WebSocket): boolean; detach(): void;`.)

`apps/api/tests/api.test.ts` (HTTP + WS through the full app):

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocket } from "ws";
import { buildApp } from "../src/app.js";
import { openDb, db, migrate, ensureSeed } from "@ec/db";
import { SessionService } from "../src/services/session.js";
import { BridgeRegistry } from "../src/realtime/bridge.js";
import { MockSpeechProvider, type MockTurn } from "@ec/openai";
import { LEARNER_ID } from "@ec/domain";

const SCRIPT: MockTurn[] = [
  { speaker: "coach", text: "Hello there?", pauseMs: 30 },
  { speaker: "learner", text: "Yesterday I go to the market.", pauseMs: 30 },
  { speaker: "coach", text: "Good.", pauseMs: 30 },
];

let app: Awaited<ReturnType<typeof buildApp>>;
let url: string;
let endedSessions: string[] = [];

beforeAll(async () => {
  const sqlite = openDb(":memory:");
  migrate(sqlite);
  ensureSeed(sqlite);
  const service = new SessionService(db(sqlite));
  const registry = new BridgeRegistry();
  app = buildApp({
    service,
    db: db(sqlite),
    registry,
    selectSpeech: () => new MockSpeechProvider({ turns: SCRIPT, autoClose: false }),
    env: { PORT: 0, HOST: "127.0.0.1", DB_PATH: ":memory:", PROVIDER: "mock", WARMUP_MS: 50, SESSION_TARGET_MS: 60_000, OPENAI_API_KEY: undefined },
    queue: (type, sessionId) => { if (type === "analyze") endedSessions.push(sessionId); },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
});

afterAll(async () => { await app.close(); });

describe("HTTP API", () => {
  it("creates a session and rejects unknown learner ids", async () => {
    const ok = await app.inject({ method: "POST", url: `/v1/learners/${LEARNER_ID}/sessions` });
    expect(ok.statusCode).toBe(201);
    expect((ok.json() as { sessionId: string }).sessionId).toMatch(/^sess-/);
    const bad = await app.inject({ method: "POST", url: "/v1/learners/nobody/sessions" });
    expect(bad.statusCode).toBe(404);
  });

  it("ends a session exactly once: second end is 409 (Review Focus 3)", async () => {
    const created = (await app.inject({ method: "POST", url: `/v1/learners/${LEARNER_ID}/sessions` })).json() as { sessionId: string };
    const first = await app.inject({ method: "POST", url: `/v1/sessions/${created.sessionId}/end` });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "POST", url: `/v1/sessions/${created.sessionId}/end` });
    expect(second.statusCode).toBe(409);
    expect(endedSessions.filter((s) => s === created.sessionId)).toHaveLength(1);
  });

  it("returns session state and transcript via GET", async () => {
    const created = (await app.inject({ method: "POST", url: `/v1/learners/${LEARNER_ID}/sessions` })).json() as { sessionId: string };
    const res = await app.inject({ method: "GET", url: `/v1/sessions/${created.sessionId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("state");
  });
});

describe("WebSocket session protocol", () => {
  it("streams transcript events and state changes, then session_ended", async () => {
    const created = (await app.inject({ method: "POST", url: `/v1/learners/${LEARNER_ID}/sessions` })).json() as { sessionId: string };
    const messages: any[] = [];
    const ws = new WebSocket(`${url.replace("http", "ws")}/ws/session/${created.sessionId}`);
    ws.on("message", (raw) => {
      messages.push(JSON.parse(String(raw)));
    });
    await new Promise<void>((resolve) => {
      ws.on("open", () => resolve());
    });
    // wait for the script to play out
    await new Promise((r) => setTimeout(r, 600));
    expect(messages.some((m) => m.t === "state" && m.state === "WARMUP")).toBe(true);
    expect(messages.some((m) => m.t === "transcript" && m.speaker === "learner")).toBe(true);
    ws.send(JSON.stringify({ t: "control", action: "end" }));
    await new Promise((r) => setTimeout(r, 200));
    expect(messages.some((m) => m.t === "session_ended" && m.state === "ANALYZING")).toBe(true);
    ws.close();
  }, 10_000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run apps/api/tests`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement `realtime/bridge.ts`**

```ts
import type WebSocket from "ws";
import type { SessionState, LearnerContext } from "@ec/domain";
import type { SpeechConversationProvider, ProviderEvent, TranscriptTurn } from "@ec/openai";
import { renderPrompt } from "@ec/prompts";
import type { SessionService } from "../services/session.js";

export type ClientMessage =
  | { t: "audio"; data: string }
  | { t: "control"; action: "start" | "end" | "mute" | "unmute" };

export type ServerMessage =
  | { t: "audio"; data: string; sampleRate: number }
  | { t: "transcript"; speaker: "learner" | "coach"; text: string; seq: number; startedAt: number; endedAt: number }
  | { t: "state"; state: SessionState }
  | { t: "intervention"; kind: "micro_coach" | "target_retry" | "challenge"; skill: string }
  | { t: "session_ended"; state: SessionState };

interface BridgeOpts {
  sessionId: string;
  provider: SpeechConversationProvider;
  service: SessionService;
  learnerContext: LearnerContext;
  difficulty: number;
  warmupMs: number;
  sessionTargetMs: number;
  onEnded: (result: { state: SessionState }) => void;
  onCleanup?: (sessionId: string) => void;
}

export class RealtimeBridge {
  state: SessionState = "STARTING";
  private client: WebSocket | null = null;
  private closed = false;
  private timers: NodeJS.Timeout[] = [];
  private seq = 0;
  private muted = false;

  constructor(private readonly opts: BridgeOpts) {}

  hasClient(): boolean { return this.client !== null; }

  attach(socket: WebSocket): boolean {
    if (this.client) return false;
    this.client = socket;
    this.start();
    socket.on("close", () => { this.client = null; });
    socket.on("message", (raw) => {
      try { this.handleClientMessage(JSON.parse(String(raw)) as ClientMessage); } catch { /* ignore malformed */ }
    });
    this.send({ t: "state", state: this.state });
    return true;
  }

  detach(): void { this.client = null; }

  private start(): void {
    void this.opts.provider.connect((e) => this.handleProviderEvent(e));
    const instructions = renderPrompt("conversation", {
      learner_context: JSON.stringify(this.opts.learnerContext),
      targets: this.opts.learnerContext.currentSessionTargets.join(", ") || "none",
      difficulty: String(this.opts.difficulty),
    });
    this.opts.provider.sendInstruction(instructions);
    this.transition("WARMUP");
    this.opts.provider.sendInstruction("Warmup: keep it light, no corrections, get the learner talking.");
    this.timers.push(setTimeout(() => this.maybeTransition("WARMUP", "CONVERSATION"), this.opts.warmupMs));
    this.timers.push(setTimeout(() => this.maybeTransition("CONVERSATION", "CHALLENGE", "challenge"), this.opts.sessionTargetMs));
  }

  private handleProviderEvent(e: ProviderEvent): void {
    if (this.closed) return;
    switch (e.t) {
      case "audio":
        if (!this.muted) this.send({ t: "audio", data: e.data.toString("base64"), sampleRate: e.sampleRate });
        break;
      case "transcript":
        this.handleTranscript(e.turn);
        break;
      case "tool_call":
        this.handleToolCall(e);
        break;
      case "closed":
        this.finish("FAILED", e.reason);
        break;
      case "connected":
        break;
    }
  }

  private handleTranscript(turn: TranscriptTurn): void {
    const { seq } = this.opts.service.recordUtterance(this.opts.sessionId, {
      speaker: turn.speaker, text: turn.text, startedAt: turn.startedAt, endedAt: turn.endedAt,
    });
    this.seq = seq;
    this.send({ t: "transcript", speaker: turn.speaker, text: turn.text, seq, startedAt: turn.startedAt, endedAt: turn.endedAt });
    if (turn.speaker === "learner") this.maybeTransition("WARMUP", "CONVERSATION");
    if ((this.state === "MICRO_COACH" || this.state === "TARGET_RETRY") && turn.speaker === "learner") {
      this.transition("CONVERSATION");
    }
  }

  private handleToolCall(e: Extract<ProviderEvent, { t: "tool_call" }>): void {
    const kind = e.name === "request_micro_coaching" ? "micro_coach" : "target_retry";
    const to = e.name === "request_micro_coaching" ? "MICRO_COACH" : "TARGET_RETRY";
    if (!this.opts.service.transition(this.opts.sessionId, to, Date.now())) return;
    this.state = to;
    this.opts.service.recordIntervention(this.opts.sessionId, kind, e.skill, Date.now());
    this.send({ t: "intervention", kind, skill: e.skill });
    this.send({ t: "state", state: this.state });
    if (kind === "micro_coach") {
      this.opts.provider.sendInstruction(`Micro-coach the ${e.skill} issue (${e.reason ?? "observed error"}): one concise correction, then return to conversation.`);
    } else {
      this.opts.provider.sendInstruction(`Create a new situation where the learner must use the ${e.skill} structure naturally, then let them try it.`);
    }
  }

  private maybeTransition(from: SessionState, to: SessionState, intervention?: "challenge"): void {
    if (this.state !== from) return;
    if (!this.opts.service.transition(this.opts.sessionId, to, Date.now())) return;
    this.state = to;
    this.send({ t: "state", state: to });
    if (to === "CHALLENGE") {
      this.send({ t: "intervention", kind: "challenge", skill: "discourse.argumentation" });
      this.opts.provider.sendInstruction("Challenge: raise cognitive demand — ask follow-up why/how questions, ask the learner to elaborate and justify.");
    }
    void intervention;
  }

  private transition(to: SessionState): void {
    if (this.opts.service.transition(this.opts.sessionId, to, Date.now())) this.state = to;
  }

  private handleClientMessage(msg: ClientMessage): void {
    if (this.closed) return;
    if (msg.t === "audio") {
      if (!this.muted) this.opts.provider.sendAudio(Buffer.from(msg.data, "base64"));
    } else if (msg.t === "control") {
      if (msg.action === "mute") this.muted = true;
      if (msg.action === "unmute") this.muted = false;
      if (msg.action === "end") this.clientEnd();
    }
  }

  private clientEnd(): void {
    if (this.closed) return;
    const out = this.opts.service.endSession(this.opts.sessionId, Date.now());
    if (out.ok) this.finish("ANALYZING", "ended");
  }

  private finish(state: SessionState, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.opts.provider.close();
    // Persist the terminal state. The ANALYZING path is already in the DB
    // (endSession transitioned CLOSING->ANALYZING before calling finish);
    // the FAILED path (provider dropped mid-session) is not, so transition it.
    if (state === "FAILED") {
      this.opts.service.transition(this.opts.sessionId, "FAILED", Date.now());
    }
    this.state = state;
    this.send({ t: "session_ended", state });
    if (state === "ANALYZING") this.opts.onEnded({ state });
    this.client?.close();
    this.client = null;
    this.opts.onCleanup?.(this.opts.sessionId);
    void reason;
  }

  destroy(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.opts.provider.close();
    this.client?.close(1000, reason);
    this.client = null;
    this.opts.onCleanup?.(this.opts.sessionId);
  }

  private send(msg: ServerMessage): void {
    if (this.client && this.client.readyState === 1) this.client.send(JSON.stringify(msg));
  }
}

export class BridgeRegistry {
  private bridges = new Map<string, RealtimeBridge>();
  get(sessionId: string): RealtimeBridge | undefined { return this.bridges.get(sessionId); }
  set(sessionId: string, bridge: RealtimeBridge): void { this.bridges.set(sessionId, bridge); }
  delete(sessionId: string): void { this.bridges.delete(sessionId); }
}
```

Note: `finish("ANALYZING")` is only reachable when `endSession` returned ok; if the provider disconnects mid-session, `finish("FAILED")` skips `onEnded` (no analysis job) per spec. The `service.transition` to FAILED from live states is legal per the state table (each live state lists FAILED? — verify: STARTING and WARMUP list FAILED; CONVERSATION/MICRO_COACH/TARGET_RETRY/CHALLENGE do NOT). Fix: in `stateMachine.ts`, add `"FAILED"` to the allowed lists of `CONVERSATION`, `MICRO_COACH`, `TARGET_RETRY`, `CHALLENGE`. Update `stateMachine.test.ts` accordingly (add these four cases to the `ok` list).

- [ ] **Step 4: Implement `routes/ws-session.ts`, `routes/sessions.ts`, `routes/learners.ts`, `app.ts`, `server.ts`**

`routes/ws-session.ts`:

```ts
import { WebSocket } from "ws";
import { fastifyWebsocket } from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import { BridgeRegistry, RealtimeBridge } from "../realtime/bridge.js";
import type { SessionService } from "../services/session.js";
import type { Env } from "../env.js";
import type { SpeechConversationProvider } from "@ec/openai";

export function registerWsRoutes(
  app: FastifyInstance,
  deps: { service: SessionService; registry: BridgeRegistry; selectSpeech: (sessionId: string) => SpeechConversationProvider; env: Env; queue: (type: "analyze", sessionId: string) => void },
): void {
  app.get("/ws/session/:sessionId", { websocket: true }, (socket: WebSocket) => {
    const sessionId = (socket as unknown as { params: { sessionId: string } }).params.sessionId;
    const existing = deps.registry.get(sessionId);
    if (existing && existing.hasClient()) {
      socket.close(4000, "session already connected");
      return;
    }
    if (existing) {
      existing.attach(socket); // reconnect (Review Focus 4)
      return;
    }
    const record = deps.service.getRecord(sessionId);
    if (!record || record.state !== "STARTING") {
      socket.close(4001, "session not in STARTING state");
      return;
    }
    const provider = deps.selectSpeech(sessionId);
    const bridge = new RealtimeBridge({
      sessionId,
      provider,
      service: deps.service,
      learnerContext: deps.service.getLearnerContext(sessionId),
      difficulty: record.plannedDifficulty,
      warmupMs: deps.env.WARMUP_MS,
      sessionTargetMs: deps.env.SESSION_TARGET_MS,
      onEnded: () => deps.queue("analyze", sessionId),
      onCleanup: () => deps.registry.delete(sessionId),
    });
    deps.registry.set(sessionId, bridge);
    bridge.attach(socket);
    // On client close the bridge stays alive (reconnect window); the provider
    // closing or the session ending tears it down and the registry entry is
    // removed inside bridge.finish via a registry delete callback (see below).
  });
}
```

The bridge must remove itself from the registry on finish: pass `onCleanup: (sessionId: string) => void` into `RealtimeBridge` opts and call it from `finish()` and `destroy()`. `registerWsRoutes` supplies `onCleanup: () => deps.registry.delete(sessionId)`.

`routes/sessions.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { sessions, utterances, parseJson } from "@ec/db";
import type { SessionService } from "../services/session.js";

export function registerSessionRoutes(app: FastifyInstance, service: SessionService): void {
  app.post("/v1/learners/:id/sessions", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id !== "learner-1") return reply.code(404).send({ error: "unknown learner" });
    const created = service.createSession(id, Date.now());
    return reply.code(201).send(created);
  });

  app.get("/v1/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = service.getRecord(id);
    if (!record) return reply.code(404).send({ error: "unknown session" });
    const transcript = service.getTranscript(id);
    return { ...record, transcript };
  });

  app.post("/v1/sessions/:id/end", async (req, reply) => {
    const { id } = req.params as { id: string };
    const out = service.endSession(id, Date.now());
    if (!out.ok) return reply.code(409).send({ error: out.reason });
    return { state: "ANALYZING" };
  });
}
```

`service.getTranscript(sessionId): { seq: number; speaker: string; text: string }[]` — add to `SessionService` (select utterances ordered by sequenceNumber). Remove the unused `profile` line.

`routes/learners.ts` (goals/profile/plan/skills/progress — data reads only; engine-driven values arrive in Task 8):

```ts
import type { FastifyInstance } from "fastify";
import { eq, and, desc } from "drizzle-orm";
import { learners, goalsTable, skills, learningPlans, sessions, errorPatterns, parseJson, type DrizzleDb } from "@ec/db";
import { randomUUID } from "node:crypto";

export function registerLearnerRoutes(app: FastifyInstance, d: DrizzleDb): void {
  app.get("/v1/learners/:id", (req, reply) => {
    const { id } = req.params as { id: string };
    const row = d.select().from(learners).where(eq(learners.id, id)).all()[0];
    if (!row) return reply.code(404).send({ error: "unknown learner" });
    return {
      id: row.id, nativeLanguage: row.nativeLanguage, targetLanguage: row.targetLanguage,
      targetLevel: row.targetLevel, estimatedLevel: row.estimatedLevel,
      estimatedLevelConfidence: row.estimatedLevelConfidence,
      correctionStyle: row.correctionStyle, preferredSessionMinutes: row.preferredSessionMinutes,
    };
  });

  app.get("/v1/learners/:id/skills", (req, reply) => {
    const { id } = req.params as { id: string };
    return d.select().from(skills).where(eq(skills.learnerId, id)).all();
  });

  app.get("/v1/learners/:id/learning-plan", (req, reply) => {
    const { id } = req.params as { id: string };
    const plan = d.select().from(learningPlans)
      .where(and(eq(learningPlans.learnerId, id), eq(learningPlans.status, "active")))
      .orderBy(desc(learningPlans.createdAt)).all()[0];
    if (!plan) return reply.code(404).send({ error: "no active plan" });
    return {
      id: plan.id, difficulty: plan.difficulty,
      primaryTargets: JSON.parse(plan.primaryTargets),
      secondaryTargets: plan.secondaryTargets ? JSON.parse(plan.secondaryTargets) : [],
      interventionType: plan.interventionType, topic: plan.topic,
      reasoning: plan.reasoning, status: plan.status, createdAt: plan.createdAt,
    };
  });

  app.get("/v1/learners/:id/progress", (req, reply) => {
    const { id } = req.params as { id: string };
    const rows = d.select().from(sessions)
      .where(and(eq(sessions.learnerId, id), eq(sessions.status, "COMPLETED")))
      .orderBy(desc(sessions.startedAt)).all().slice(0, 10).reverse();
    return rows.map((s) => ({
      id: s.id, startedAt: s.startedAt, topic: s.topic,
      scores: {
        fluency: s.fluencyScore, grammar: s.grammarScore, vocabulary: s.vocabularyScore,
        pronunciation: s.pronunciationScore, coherence: s.coherenceScore, interaction: s.interactionScore,
      },
      overall: s.overallScore,
    }));
  });

  app.get("/v1/learners/:id/goals", (req) => {
    const { id } = req.params as { id: string };
    return d.select().from(goalsTable).where(eq(goalsTable.learnerId, id)).all();
  });

  app.post("/v1/learners/:id/goals", (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { type: string; description: string; priority?: number };
    if (!body?.type || !body?.description) return reply.code(400).send({ error: "type and description required" });
    const goalId = `goal-${randomUUID()}`;
    d.insert(goalsTable).values({
      id: goalId, learnerId: id, type: body.type, description: body.description,
      priority: body.priority ?? 0.5, status: "active", createdAt: Date.now(),
    }).run();
    return reply.code(201).send({ id: goalId });
  });

  app.patch("/v1/learners/:id/goals/:goalId", (req, reply) => {
    const { id, goalId } = req.params as { id: string; goalId: string };
    const body = req.body as Partial<{ priority: number; status: string; description: string }>;
    const patch: Record<string, unknown> = {};
    if (typeof body.priority === "number") patch.priority = body.priority;
    if (body.description) patch.description = body.description;
    if (body.status === "active" || body.status === "completed") {
      patch.status = body.status;
      if (body.status === "completed") patch.completedAt = Date.now();
    }
    const res = d.update(goalsTable).set(patch as never)
      .where(and(eq(goalsTable.id, goalId), eq(goalsTable.learnerId, id))).run();
    if (res.changes === 0) return reply.code(404).send({ error: "goal not found" });
    return { ok: true };
  });
}
```

`app.ts`:

```ts
import Fastify from "fastify";
import { fastifyWebsocket } from "@fastify/websocket";
import type { SessionService } from "./services/session.js";
import type { Env } from "./env.js";
import { BridgeRegistry } from "./realtime/bridge.js";
import { registerWsRoutes } from "./routes/ws-session.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerLearnerRoutes } from "./routes/learners.js";
import type { SpeechConversationProvider } from "@ec/openai";
import type { DrizzleDb } from "@ec/db";

export interface AppDeps {
  service: SessionService;
  db: DrizzleDb;
  registry: BridgeRegistry;
  selectSpeech: (sessionId: string) => SpeechConversationProvider;
  env: Env;
  queue: (type: "analyze", sessionId: string) => void;
}

export async function buildApp(deps: AppDeps) {
  const app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  registerSessionRoutes(app, deps.service);
  registerLearnerRoutes(app, deps.db);
  registerWsRoutes(app, deps); // deps includes queue; bridge enqueues analysis on client end
  return app;
}
```

`server.ts`:

```ts
import { loadEnv } from "./env.js";
import { openDb, db, migrate, ensureSeed } from "@ec/db";
import { SessionService } from "./services/session.js";
import { BridgeRegistry } from "./realtime/bridge.js";
import { buildApp } from "./app.js";
import { selectSpeechProvider, type SpeechConversationProvider } from "@ec/openai";
import { startJobRunner } from "./workers/stopgap.js"; // this file is deleted in Task 7, which adds workers/jobs.ts with retry/backoff

async function main() {
  const env = loadEnv();
  const sqlite = openDb(env.DB_PATH);
  migrate(sqlite);
  ensureSeed(sqlite);
  const d = db(sqlite);
  const service = new SessionService(d);
  const registry = new BridgeRegistry();
  const speechProviders = new Map<string, SpeechConversationProvider>();
  const queue: AppDeps["queue"] = () => { /* JobRunner wires this in Task 7 */ };
  const app = await buildApp({
    service, db: d, registry, env, queue,
    selectSpeech: (sessionId) => {
      const existing = speechProviders.get(sessionId);
      if (existing) return existing;
      const p = selectSpeechProvider({ PROVIDER: env.PROVIDER, OPENAI_API_KEY: env.OPENAI_API_KEY });
      speechProviders.set(sessionId, p);
      return p;
    },
  });
  startJobRunner(d, queue); // stopgap in Task 6b; replaced by JobRunner in Task 7
  await app.listen({ port: env.PORT, host: env.HOST });
  console.log(`english-coach api on ${env.HOST}:${env.PORT} (provider=${env.PROVIDER})`);
}
main();
```

Stopgap `workers/stopgap.ts` (replaced wholesale in Task 7 — keep it minimal):

```ts
import { eq, and, isNull } from "drizzle-orm";
import { jobs, sessions, parseJson, type DrizzleDb } from "@ec/db";
import { SessionAnalysisSchema, type SessionAnalysis, type Scores } from "@ec/domain";

/**
 * Stopgap job runner: polls the jobs table and runs the analysis pipeline
 * inline. Task 7 replaces this file with workers/jobs.ts (retry/backoff)
 * and workers/analysis.ts (memory updates). Interface is identical.
 */
export function startJobRunner(d: DrizzleDb, queue: (type: "analyze", sessionId: string) => void): { stop(): void } {
  const timer = setInterval(() => { void poll(); }, 1000);
  async function poll() {
    const now = Date.now();
    const due = d.select().from(jobs)
      .where(eq(jobs.status, "pending"))
      .all()
      .filter((j) => j.nextRunAt === null || j.nextRunAt <= now);
    for (const job of due) {
      try {
        runAnalyze(job);
      } catch (err) {
        console.error("analysis failed", err);
      }
    }
  }
  function runAnalyze(job: { id: string; sessionId: string | null }) {
    // Task 7's analysis worker is a superset of this; the stopgap only marks the session done.
    if (!job.sessionId) return;
    const session = d.select().from(sessions).where(eq(sessions.id, job.sessionId)).all()[0];
    if (!session || session.analysis) return; // idempotency
    d.update(jobs).set({ status: "done", doneAt: Date.now() }).where(eq(jobs.id, job.id)).run();
    d.update(sessions).set({ status: "COMPLETED", achievedDifficulty: session.plannedDifficulty })
      .where(eq(sessions.id, job.sessionId)).run();
  }
  return { stop: () => clearInterval(timer) };
}
```

The `queue` function in `server.ts` must actually enqueue: fix by making the queue real in `server.ts` (it is 4 lines, no placeholder):

```ts
import { randomUUID } from "node:crypto";
const queue: (type: "analyze", sessionId: string) => void = (type, sessionId) => {
  try {
    d.insert(jobs).values({
      id: `job-${randomUUID()}`, type, sessionId,
      status: "pending", attempts: 0, maxAttempts: 3,
      nextRunAt: null, createdAt: Date.now(),
    }).run();
  } catch (e) {
    // UNIQUE(session_id, type) — duplicate enqueue is a no-op
  }
};
```

- [ ] **Step 5: Confirm the transition table already handles mid-session failure**

The Task 6a table already allows `FAILED` and `CLOSING` from every active state, which is what `RealtimeBridge.finish("FAILED")` (provider dropped mid-session) and any-time `endSession` rely on. Do **not** re-edit `stateMachine.ts` here — verify `pnpm vitest run apps/api/src/stateMachine.test.ts` passes as-is; if it fails, the Task 6a table was not updated and must be fixed there, not here.

- [ ] **Step 6: Add `getTranscript` to `SessionService`**

```ts
getTranscript(sessionId: string): { seq: number; speaker: string; text: string }[] {
  return this.d.select({
    seq: utterances.sequenceNumber, speaker: utterances.speaker, text: utterances.text,
  }).from(utterances).where(eq(utterances.sessionId, sessionId))
    .orderBy(utterances.sequenceNumber).all()
    .map((u) => ({ seq: u.seq, speaker: u.speaker, text: u.text }));
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm vitest run apps/api`
Expected: all PASS. Note: WS tests are timing-sensitive (mock provider 30–40 ms pauses); if flaky on a slow machine, raise the `setTimeout` waits in the tests by 2×, not the provider speed.

- [ ] **Step 8: Smoke check**

Run:

```bash
cd english-coach/apps/api
DB_PATH=:memory: pnpm db:init  # no-op sanity: schema.sql loads
pnpm --filter @ec/api dev &   # start server
curl -s -X POST http://127.0.0.1:3100/v1/learners/learner-1/sessions
# → {"sessionId":"sess-...","topic":"Free conversation about your day","difficulty":0.5,"state":"STARTING"}
kill %1
```

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat(api): realtime bridge, ws protocol, session/learner routes, server bootstrap"
```

---
### Task 7: Job runner + analysis worker + planner worker (post-session pipeline)

Replaces the Task 6b stopgap. All pipeline side effects are idempotent and run in a single SQLite transaction per job.

**Files:**
- Delete: `apps/api/src/workers/stopgap.ts`
- Create: `apps/api/src/workers/jobs.ts` (JobRunner)
- Create: `apps/api/src/workers/context.ts` (shared `buildLearnerContext`)
- Create: `apps/api/src/workers/analysis.ts`
- Create: `apps/api/src/workers/planner.ts`
- Modify: `apps/api/src/server.ts` (JobRunner replaces stopgap; `queue` = `runner.enqueue`)
- Modify: `apps/api/src/services/session.ts` (`getLearnerContext` delegates to `workers/context.ts`)
- Modify: `packages/learning-engine/src/mastery.ts` (add `trendFromDelta`)
- Test: `apps/api/tests/worker.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–6.
- Produces:
  - `jobs.ts`:
    ```ts
    export class JobRunner {
      constructor(opts: { db: DrizzleDb; pollMs?: number; handle: (job: JobRow) => Promise<void> });
      enqueue(type: "analyze" | "plan_next", sessionId: string): void; // idempotent via UNIQUE(session_id, type); duplicate → no-op
      start(): void;
      stop(): void;
      processOne(jobId: string): Promise<void>; // for tests: loads job, marks running, calls handle, marks done/failed with backoff
    }
    export function defaultBackoffMs(attempts: number): number; // 2^attempts * 5000, capped 30000
    ```
  - `context.ts`: `buildLearnerContext(d: DrizzleDb, learnerId: string, sessionId: string | null, now: number): LearnerContext` — same logic as `SessionService.getLearnerContext` (move the body here; the service method delegates: `getLearnerContext(sessionId) { const s = ...; return buildLearnerContext(this.d, s.learnerId, sessionId, Date.now()); }`).
  - `analysis.ts`:
    ```ts
    export async function runAnalysis(opts: { db: DrizzleDb; provider: AnalysisProvider; sessionId: string; now: number }): Promise<void>;
    ```
    Skill-observation value rule (deterministic, documented here):
    | observation type | performance value fed to updateSkill |
    | --- | --- |
    | language_error | `1 - (severity ?? 0.5)` |
    | strength | `0.9` |
    | vocabulary_use | `0.8` |
    | fluency_signal | `0.7` |
  - `planner.ts`:
    ```ts
    export async function runPlanner(opts: { db: DrizzleDb; provider: AnalysisProvider; sessionId: string; now: number }): Promise<void>;
    export function buildCandidates(d: DrizzleDb, learnerId: string, analysis: SessionAnalysis, goalTypes: string[], now: number): TargetCandidate[];
    ```

- [ ] **Step 1: Add `trendFromDelta` to the learning engine**

Append to `packages/learning-engine/src/mastery.ts`:

```ts
/** Worker-side trend rule: compare previous mastery with the new one (deadband 0.02). */
export function trendFromDelta(oldMastery: number, newMastery: number): Trend {
  const d = newMastery - oldMastery;
  if (d > 0.02) return "improving";
  if (d < -0.02) return "declining";
  return "stable";
}
```

No test change needed (the existing `computeTrend` suite covers the history variant).

- [ ] **Step 2: Write failing tests**

`apps/api/tests/worker.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { eq, and } from "drizzle-orm";
import {
  openDb, db, migrate, ensureSeed, sessions, utterances, skills, errorPatterns,
  learningPlans, jobs, learners,
} from "@ec/db";
import type { DrizzleDb } from "@ec/db";
import { LEARNER_ID } from "@ec/domain";
import { SessionService } from "../src/services/session.js";
import { JobRunner, defaultBackoffMs } from "../src/workers/jobs.js";
import { runAnalysis } from "../src/workers/analysis.js";
import { runPlanner, buildCandidates } from "../src/workers/planner.js";
import { MockAnalysisProvider, type AnalysisProvider } from "@ec/openai";
import { isRecurring } from "@ec/learning-engine";

const NOW = 1_700_000_000_000;

/** Seeds a finished ANALYZING session whose learner utterances hit the mock lexicon 3× for past tense. */
function seedAnalyzableSession(d: DrizzleDb, service: SessionService, sessionId: string): void {
  d.update(sessions).set({ status: "ANALYZING", metrics: JSON.stringify({
    speakingSeconds: 12, userWordCount: 20, wordsPerMinute: 100, pauseCount: 1,
    avgPauseMs: 300, longestPauseMs: 900, utteranceCount: 4, avgUtteranceWords: 5, rmsEnergyAvg: 0.2,
  }) }).where(eq(sessions.id, sessionId)).run();
  const turns: { speaker: "learner" | "coach"; text: string; startedAt: number; endedAt: number }[] = [
    { speaker: "coach", text: "Hi, tell me about yesterday.", startedAt: NOW, endedAt: NOW + 2000 },
    { speaker: "learner", text: "Yesterday I go to work by train.", startedAt: NOW + 2100, endedAt: NOW + 4500 },
    { speaker: "coach", text: "And later?", startedAt: NOW + 4600, endedAt: NOW + 5200 },
    { speaker: "learner", text: "Yesterday I go home late at night.", startedAt: NOW + 5300, endedAt: NOW + 7600 },
    { speaker: "learner", text: "Yesterday I go shopping in the evening.", startedAt: NOW + 7900, endedAt: NOW + 9500 },
    { speaker: "learner", text: "I go there since five years, it is my office.", startedAt: NOW + 9800, endedAt: NOW + 12000 },
  ];
  for (const t of turns) {
    service.recordUtterance(sessionId, t);
  }
}

function makeFixture() {
  const sqlite = openDb(":memory:");
  migrate(sqlite);
  ensureSeed(sqlite);
  const d = db(sqlite);
  const service = new SessionService(d);
  const session = service.createSession(LEARNER_ID, NOW);
  service.transition(session.id, "WARMUP", NOW);
  service.transition(session.id, "CONVERSATION", NOW);
  seedAnalyzableSession(d, service, session.id);
  return { sqlite, d, service, sessionId: session.id };
}

describe("JobRunner", () => {
  it("enqueue is idempotent per (session, type)", () => {
    const { d } = makeFixture();
    const runner = new JobRunner({ db: d, handle: async () => {} });
    runner.enqueue("analyze", "sess-x");
    runner.enqueue("analyze", "sess-x");
    const rows = d.select().from(jobs).where(eq(jobs.type, "analyze")).all();
    expect(rows.filter((r) => r.sessionId === "sess-x")).toHaveLength(1);
  });

  it("retries with backoff then marks failed after max attempts (Review Focus 1)", async () => {
    const { d } = makeFixture();
    let calls = 0;
    const runner = new JobRunner({
      db: d, pollMs: 1,
      handle: async () => { calls += 1; throw new Error("boom"); },
    });
    runner.enqueue("analyze", "sess-fail");
    const jobId = d.select().from(jobs).where(eq(jobs.sessionId, "sess-fail")).all()[0].id;
    for (let i = 0; i < 3; i++) {
      await runner.processOne(jobId);
    }
    const job = d.select().from(jobs).where(eq(jobs.id, jobId)).all()[0];
    expect(calls).toBe(3);
    expect(job.status).toBe("failed");
    expect(job.attempts).toBe(3);
    expect(job.error).toContain("boom");
  });

  it("backoff grows exponentially and caps at 30s", () => {
    expect(defaultBackoffMs(1)).toBe(10000);
    expect(defaultBackoffMs(2)).toBe(20000);
    expect(defaultBackoffMs(5)).toBe(30000);
  });
});

describe("runAnalysis (mock provider)", () => {
  let d: DrizzleDb;
  let sessionId: string;

  beforeEach(() => {
    const f = makeFixture();
    d = f.d;
    sessionId = f.sessionId;
  });

  it("persists scores, analysis JSON, skill updates, and a recurring error pattern", async () => {
    await runAnalysis({ db: d, provider: new MockAnalysisProvider(), sessionId, now: NOW + 120000 });
    const session = d.select().from(sessions).where(eq(sessions.id, sessionId)).all()[0];
    expect(session.status).toBe("COMPLETED");
    expect(session.analysis).toBeTruthy();
    expect(session.grammarScore).not.toBe(null);
    expect(session.overallScore!).toBeGreaterThan(0.4);

    const skill = d.select().from(skills).where(and(eq(skills.learnerId, LEARNER_ID), eq(skills.code, "grammar.past_tense"))).all()[0];
    expect(skill).toBeTruthy();
    expect(skill.observationCount).toBe(3);
    expect(skill.mastery).toBeLessThan(0.5); // three errors pull mastery below the 0.5 prior

    const err = d.select().from(errorPatterns)
      .where(and(eq(errorPatterns.learnerId, LEARNER_ID), eq(errorPatterns.skillCode, "grammar.past_tense")))
      .all()[0];
    expect(err.frequency).toBeGreaterThanOrEqual(2);
    expect(isRecurring({ frequency: err.frequency, confidence: err.confidence, lastSeenAt: err.lastSeenAt })).toBe(true);

    // learner level estimate updated
    const learner = d.select().from(learners).where(eq(learners.id, LEARNER_ID)).all()[0];
    expect(learner.estimatedLevel).toBeTruthy();
    expect(learner.estimatedLevelConfidence).toBeGreaterThan(0);
  });

  it("is idempotent: a second run changes nothing (Review Focus 3/worker idempotency)", async () => {
    await runAnalysis({ db: d, provider: new MockAnalysisProvider(), sessionId, now: NOW + 120000 });
    const snapshot = d.select().from(skills).all();
    await runAnalysis({ db: d, provider: new MockAnalysisProvider(), sessionId, now: NOW + 121000 });
    const after = d.select().from(skills).all();
    expect(after).toEqual(snapshot);
  });

  it("invalid provider output fails the job without touching learner state (Review Focus 1)", async () => {
    const bad: AnalysisProvider = {
      analyze: async () => { throw new Error("upstream rejected: expected object, got string"); },
      plan: async () => { throw new Error("unused"); },
    };
    const before = d.select().from(skills).all();
    await expect(runAnalysis({ db: d, provider: bad, sessionId, now: NOW + 120000 }))
      .rejects.toThrow(/upstream rejected/);
    expect(d.select().from(skills).all()).toEqual(before);
    expect(d.select().from(sessions).where(eq(sessions.id, sessionId)).all()[0].status).toBe("ANALYZING");
  });
});

describe("runPlanner", () => {
  let d: DrizzleDb;
  let sessionId: string;

  async function analyzed(): Promise<void> {
    await runAnalysis({ db: d, provider: new MockAnalysisProvider(), sessionId, now: NOW + 120000 });
  }

  beforeEach(async () => {
    const f = makeFixture();
    d = f.d;
    sessionId = f.sessionId;
    await analyzed();
  });

  it("creates a plan targeting the recurring weakness with adjusted difficulty", async () => {
    await runPlanner({ db: d, provider: new MockAnalysisProvider(), sessionId, now: NOW + 121000 });
    const plan = d.select().from(learningPlans)
      .where(and(eq(learningPlans.learnerId, LEARNER_ID), eq(learningPlans.status, "active"))).all()[0];
    expect(plan).toBeTruthy();
    const primary = JSON.parse(plan.primaryTargets) as string[];
    expect(primary[0]).toBe("grammar.past_tense");
    expect(primary.length).toBeLessThanOrEqual(2);
    expect(plan.difficulty).toBeGreaterThanOrEqual(0.15);
    expect(plan.difficulty).toBeLessThanOrEqual(0.95);
    expect(plan.topic).toBeTruthy();
  });

  it("is idempotent: re-running does not create a second active plan", async () => {
    await runPlanner({ db: d, provider: new MockAnalysisProvider(), sessionId, now: NOW + 121000 });
    await runPlanner({ db: d, provider: new MockAnalysisProvider(), sessionId, now: NOW + 122000 });
    const active = d.select().from(learningPlans)
      .where(and(eq(learningPlans.learnerId, LEARNER_ID), eq(learningPlans.status, "active"))).all();
    expect(active).toHaveLength(1);
  });

  it("buildCandidates applies no-history defaults to engine-unknown skills", () => {
    const analysis = d.select().from(sessions).where(eq(sessions.id, sessionId)).all()[0];
    const parsed = JSON.parse(analysis.analysis!) as import("@ec/domain").SessionAnalysis;
    const candidates = buildCandidates(d, LEARNER_ID, parsed, ["fluency", "grammar", "vocabulary"], NOW + 121000);
    const unknown = candidates.find((c) => c.skill === "discourse.argumentation");
    if (unknown) {
      expect(unknown.recurrence).toBe(0);
      expect(unknown.severity).toBe(0.4);
    }
    expect(candidates.some((c) => c.skill === "grammar.past_tense")).toBe(true);
  });
});
```

(The test file needs `import { learners } from "@ec/db"` — add it to the import list; the `learners()` calls in the test are a typo: use the imported table `learners` directly.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run apps/api/tests/worker.test.ts`
Expected: FAIL — `../src/workers/jobs.js` etc. missing.

- [ ] **Step 4: Implement `workers/jobs.ts`**

```ts
import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { jobs, type DrizzleDb, type JobRow } from "@ec/db";

export function defaultBackoffMs(attempts: number): number {
  return Math.min(30_000, 2 ** attempts * 5_000);
}

export class JobRunner {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: {
    db: DrizzleDb;
    pollMs?: number;
    handle: (job: JobRow) => Promise<void>;
  }) {}

  enqueue(type: "analyze" | "plan_next", sessionId: string): void {
    try {
      this.opts.db.insert(jobs).values({
        id: `job-${randomUUID()}`,
        type,
        sessionId,
        status: "pending",
        attempts: 0,
        maxAttempts: 3,
        nextRunAt: null,
        createdAt: Date.now(),
      }).run();
    } catch {
      // UNIQUE(session_id, type) violation → duplicate enqueue, no-op
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.poll(); }, this.opts.pollMs ?? 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    const now = Date.now();
    const due = this.opts.db.select().from(jobs)
      .where(eq(jobs.status, "pending"))
      .all()
      .filter((j) => j.nextRunAt === null || j.nextRunAt <= now);
    for (const job of due) {
      await this.processOne(job.id);
    }
  }

  async processOne(jobId: string): Promise<void> {
    const job = this.opts.db.select().from(jobs).where(eq(jobs.id, jobId)).all()[0];
    if (!job || job.status !== "pending") return;
    this.opts.db.update(jobs).set({ status: "running" }).where(eq(jobs.id, jobId)).run();
    try {
      await this.opts.handle(job);
      this.opts.db.update(jobs).set({ status: "done", doneAt: Date.now() }).where(eq(jobs.id, jobId)).run();
    } catch (err) {
      const attempts = job.attempts + 1;
      const message = err instanceof Error ? err.message : String(err);
      if (attempts >= job.maxAttempts) {
        this.opts.db.update(jobs)
          .set({ status: "failed", attempts, error: message })
          .where(eq(jobs.id, jobId)).run();
      } else {
        this.opts.db.update(jobs)
          .set({ status: "pending", attempts, error: message, nextRunAt: Date.now() + defaultBackoffMs(attempts) })
          .where(eq(jobs.id, jobId)).run();
      }
    }
  }
}
```

- [ ] **Step 5: Implement `workers/context.ts`**

Move the body of `SessionService.getLearnerContext` into this module (it reads the session row to find `learnerId` + plan; here `sessionId` is optional — when null, `currentSessionTargets` come from the active plan only and `recentTopics` from all past sessions):

```ts
import { eq, and, desc, neq, isNotNull } from "drizzle-orm";
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
        .where(and(eq(sessions.learnerId, learnerId), neq(sessions.id, sessionId), isNotNull(sessions.topic)))
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
    currentSessionTargets: session ? primary : primary,
  };
}

function safeParse(s: string | null): string[] {
  if (!s) return [];
  try { return JSON.parse(s) as string[]; } catch { return []; }
}
```

Then in `services/session.ts` replace the `getLearnerContext` body with:

```ts
getLearnerContext(sessionId: string): LearnerContext {
  const s = this.d.select().from(sessions).where(eq(sessions.id, sessionId)).all()[0];
  if (!s) throw new Error(`unknown session ${sessionId}`);
  return buildLearnerContext(this.d, s.learnerId, sessionId, Date.now());
}
```

and remove the now-unused local code/imports.

- [ ] **Step 6: Implement `workers/analysis.ts`**

```ts
import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import {
  sessions, utterances, observations, skills, errorPatterns, vocabularyItems,
  learners, jobs, parseJson, type DrizzleDb,
} from "@ec/db";
import type { SessionAnalysis, SessionMetrics, Observation, SkillState } from "@ec/domain";
import { SessionAnalysisSchema } from "@ec/domain";
import type { AnalysisProvider, TranscriptTurn } from "@ec/openai";
import {
  calculateOverall, updateSkill, trendFromDelta,
  upsertErrorInput, shouldRetire, effectiveFrequency, estimateLevel,
  type ErrorPatternInput,
} from "@ec/learning-engine";
import { buildLearnerContext } from "./context.js";

const PERFORMANCE: Record<Observation["type"], (o: Observation) => number> = {
  language_error: (o) => 1 - (o.severity ?? 0.5),
  strength: () => 0.9,
  vocabulary_use: () => 0.8,
  fluency_signal: () => 0.7,
};

export async function runAnalysis(opts: {
  db: DrizzleDb;
  provider: AnalysisProvider;
  sessionId: string;
  now: number;
}): Promise<void> {
  const { db: d, provider, sessionId, now } = opts;
  const session = d.select().from(sessions).where(eq(sessions.id, sessionId)).all()[0];
  if (!session) throw new Error(`unknown session ${sessionId}`);
  if (session.analysis) return; // idempotency: already analyzed

  const turns: TranscriptTurn[] = d.select().from(utterances)
    .where(eq(utterances.sessionId, sessionId))
    .all()
    .map((u) => ({
      speaker: u.speaker as "learner" | "coach",
      text: u.text,
      startedAt: u.startedAt ?? 0,
      endedAt: u.endedAt ?? 0,
    }))
    .sort((a, b) => a.startedAt - b.startedAt);

  const metrics: SessionMetrics = parseJson<SessionMetrics>(session.metrics) ?? {
    speakingSeconds: 0, userWordCount: 0, wordsPerMinute: 0, pauseCount: 0,
    avgPauseMs: 0, longestPauseMs: 0, utteranceCount: 0, avgUtteranceWords: 0, rmsEnergyAvg: 0,
  };
  const learnerContext = buildLearnerContext(d, session.learnerId, sessionId, now);

  const raw = await provider.analyze({
    learnerId: session.learnerId,
    transcript: turns,
    metrics,
    learnerContext,
    sessionTargets: learnerContext.currentSessionTargets,
  });
  const analysis = SessionAnalysisSchema.parse(raw); // throws → job retry/failure, no writes

  // 1) session scores + overall
  const scores = analysis.scores;
  const overall = calculateOverall(scores);

  // 2) update learner memory (sequential statements; safe to re-run: the
  // idempotency guard at the top plus UNIQUE constraints make a crashed
  // mid-run retry a no-op)
  applyMemory(d, session.learnerId, sessionId, analysis, overall, now);

  d.update(sessions).set({
    status: "COMPLETED",
    fluencyScore: scores.fluency,
    grammarScore: scores.grammar,
    vocabularyScore: scores.vocabulary,
    pronunciationScore: scores.pronunciation,
    coherenceScore: scores.coherence,
    interactionScore: scores.interaction,
    overallScore: overall,
    analysis: JSON.stringify(analysis),
  }).where(eq(sessions.id, sessionId)).run();

  // learner level estimate (longitudinal, spec §31)
  const completedCount = d.select().from(sessions)
    .where(and(eq(sessions.learnerId, session.learnerId), eq(sessions.status, "COMPLETED"))).all().length;
  const { level, confidence } = estimateLevel(overall, completedCount);
  d.update(learners).set({
    estimatedLevel: level,
    estimatedLevelConfidence: confidence,
    updatedAt: now,
  }).where(eq(learners.id, session.learnerId)).run();

  // 3) persist observations rows (evidence trail, spec §23)
  for (const o of analysis.observations) {
    d.insert(observations).values({
      id: `obs-${randomUUID()}`,
      sessionId,
      type: o.type,
      skillCode: o.skill,
      evidence: o.evidence,
      expected: o.expected ?? null,
      actual: o.actual ?? null,
      severity: o.severity ?? null,
      confidence: o.confidence,
      createdAt: now,
    }).run();
  }

  // 4) queue the planner
  try {
    d.insert(jobs).values({
      id: `job-${randomUUID()}`,
      type: "plan_next",
      sessionId,
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
      createdAt: now,
    }).run();
  } catch { /* duplicate no-op */ }
}

function applyMemory(
  d: DrizzleDb,
  learnerId: string,
  sessionId: string,
  analysis: SessionAnalysis,
  overall: number,
  now: number,
): void {
  // Skills: EMA update per observed skill (only confidence > 0.8 observations count)
  const errorsBySkill = new Map<string, { severity: number; confidence: number }>();
  for (const o of analysis.observations) {
    if (o.confidence <= 0.8) continue;
    if (o.type === "language_error") {
      const cur = errorsBySkill.get(o.skill);
      errorsBySkill.set(o.skill, {
        severity: Math.max(cur?.severity ?? 0, o.severity ?? 0.5),
        confidence: Math.max(cur?.confidence ?? 0, o.confidence),
      });
    }
    const existing = d.select().from(skills)
      .where(and(eq(skills.learnerId, learnerId), eq(skills.code, o.skill))).all()[0];
    if (existing) {
      const prev: SkillState = {
        mastery: existing.mastery, confidence: existing.confidence,
        observationCount: existing.observationCount, trend: existing.trend as SkillState["trend"],
      };
      const next = updateSkill(prev, PERFORMANCE[o.type](o), now);
      d.update(skills).set({
        mastery: next.mastery,
        confidence: next.confidence,
        observationCount: next.observationCount,
        trend: trendFromDelta(prev.mastery, next.mastery),
        lastAssessedAt: now,
      }).where(eq(skills.id, existing.id)).run();
    } else {
      d.insert(skills).values({
        id: `skill-${randomUUID()}`,
        learnerId,
        code: o.skill,
        mastery: 0.5,
        confidence: 0.1,
        trend: "stable",
        observationCount: 0,
        lastAssessedAt: now,
      }).run();
      // then update the fresh row
      const created = d.select().from(skills)
        .where(and(eq(skills.learnerId, learnerId), eq(skills.code, o.skill))).all()[0];
      d.update(skills).set({
        mastery: updateSkill(
          { mastery: 0.5, confidence: 0.1, observationCount: 0, trend: "stable" },
          PERFORMANCE[o.type](o), now,
        ).mastery,
        confidence: 0.15,
        observationCount: 1,
      }).where(eq(skills.id, created.id)).run();
    }
  }

  // Error patterns: upsert per (skill, pattern); pattern = recurring name if flagged, else "other"
  for (const [skill, e] of errorsBySkill) {
    const recurring = analysis.recurring_errors.find((r) => r.skill === skill);
    const pattern = recurring?.pattern ?? "other";
    const prevRow = d.select().from(errorPatterns)
      .where(and(
        eq(errorPatterns.learnerId, learnerId),
        eq(errorPatterns.skillCode, skill),
        eq(errorPatterns.pattern, pattern),
      )).all()[0];
    const prev: ErrorPatternInput | null = prevRow
      ? {
          skill, pattern, frequency: prevRow.frequency, severity: prevRow.severity,
          mastery: prevRow.mastery, confidence: prevRow.confidence, status: prevRow.status as "active" | "mastered",
          firstSeenAt: prevRow.firstSeenAt, lastSeenAt: prevRow.lastSeenAt,
        }
      : null;
    const count = analysis.observations.filter((o) => o.skill === skill && o.type === "language_error").length;
    let next = prev;
    for (let i = 0; i < count; i++) {
      next = upsertErrorInput(next, { skill, pattern, severity: e.severity, confidence: e.confidence }, now);
    }
    if (next) {
      if (prevRow) {
        d.update(errorPatterns).set({
          frequency: next.frequency,
          severity: next.severity,
          confidence: next.confidence,
          lastSeenAt: now,
        }).where(eq(errorPatterns.id, prevRow.id)).run();
      } else {
        d.insert(errorPatterns).values({
          id: `err-${randomUUID()}`,
          learnerId,
          skillCode: skill,
          pattern: next.pattern,
          frequency: next.frequency,
          severity: next.severity,
          confidence: next.confidence,
          firstSeenAt: now,
          lastSeenAt: now,
        }).run();
      }
    }
  }

  // Retirement: mark stale or outgrown patterns mastered (spec §10.3)
  for (const row of d.select().from(errorPatterns)
    .where(and(eq(errorPatterns.learnerId, learnerId), eq(errorPatterns.status, "active"))).all()) {
    const skillRow = d.select().from(skills)
      .where(and(eq(skills.learnerId, learnerId), eq(skills.code, row.skillCode))).all()[0];
    const input: ErrorPatternInput = {
      skill: row.skillCode, pattern: row.pattern, frequency: row.frequency,
      severity: row.severity, mastery: row.mastery, confidence: row.confidence,
      status: "active", firstSeenAt: row.firstSeenAt, lastSeenAt: row.lastSeenAt,
    };
    if (shouldRetire(input, skillRow?.mastery ?? 0, now)) {
      d.update(errorPatterns).set({ status: "mastered" }).where(eq(errorPatterns.id, row.id)).run();
    }
  }

  // Vocabulary: track words from vocabulary_use evidence (longest alpha token), spec §10.4
  for (const o of analysis.observations.filter((x) => x.type === "vocabulary_use")) {
    const word = (o.evidence.match(/[a-zA-Z]{4,}/g) ?? []).sort((a, b) => b.length - a.length)[0];
    if (!word) continue;
    const existing = d.select().from(vocabularyItems)
      .where(and(eq(vocabularyItems.learnerId, learnerId), eq(vocabularyItems.word, word))).all()[0];
    if (existing) {
      d.update(vocabularyItems).set({
        productionCount: existing.productionCount + 1,
        productionMastery: Math.min(0.95, existing.productionMastery + 0.05),
        lastUsedAt: now,
        nextReviewAt: now + Math.max(1, Math.floor(10 * (existing.productionMastery + 0.05))) * 86_400_000,
      }).where(eq(vocabularyItems.id, existing.id)).run();
    } else {
      d.insert(vocabularyItems).values({
        id: `vocab-${randomUUID()}`,
        learnerId, word,
        recognitionMastery: 0.3,
        productionMastery: 0.1,
        collocationMastery: 0,
        exposureCount: 0,
        productionCount: 1,
        lastUsedAt: now,
      }).run();
    }
  }
  void overall; // overall is persisted by the caller; retained for signature stability
}
```

Implementer note: `effectiveFrequency` is not used in this file — remove it from the import list.

- [ ] **Step 7: Implement `workers/planner.ts`**

```ts
import { randomUUID } from "node:crypto";
import { eq, and, desc } from "drizzle-orm";
import {
  learners, sessions, skills, errorPatterns, learningPlans, goalsTable,
  type DrizzleDb,
} from "@ec/db";
import type { LearnerContext, PlanDraft, SessionAnalysis } from "@ec/domain";
import { PlanDraftSchema } from "@ec/domain";
import type { AnalysisProvider } from "@ec/openai";
import {
  adjustDifficulty, recentPerformance, shouldRetire, effectiveFrequency,
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

  const maxEff = Math.max(1, ...[...skillCodes].map((code) =>
    Math.max(0, ...(bySkill.get(code) ?? []).map((e) => effectiveFrequency(e.frequency, e.lastSeenAt, now))
      .concat([0]),
  ));

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

  // Difficulty: engine math on session history
  const pastScores = d.select().from(sessions)
    .where(and(eq(sessions.learnerId, session.learnerId), eq(sessions.status, "COMPLETED")))
    .orderBy(desc(sessions.startedAt)).all()
    .map((s) => s.overallScore ?? 0);
  const currentDifficulty = session.plannedDifficulty ?? 0.5;
  const newDifficulty = adjustDifficulty(currentDifficulty, recentPerformance(pastScores.length > 0 ? pastScores : [0.5]));

  const learnerContext = buildLearnerContext(d, session.learnerId, sessionId, now);

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
    interventionType: primary[0] ? interventions.get(primary[0].skill) : null,
    topic: draft.topic,
    reasoning: draft.reason,
    status: "active",
    createdAt: now,
  }).run();

  d.update(sessions).set({ achievedDifficulty: newDifficulty }).where(eq(sessions.id, sessionId)).run();
  void learner;
}
```

Fix before committing: `goalTypesTable` → import `goalsTable` from `@ec/db` and use it in the `goalTypes` query; delete the two stray lines around it (`const goals = ...`, comment).

- [ ] **Step 8: Update `server.ts`**

Replace the stopgap import/usage with:

```ts
import { JobRunner } from "./workers/jobs.js";
import { runAnalysis } from "./workers/analysis.js";
import { runPlanner } from "./workers/planner.js";
// delete: import { startJobRunner } from "./workers/stopgap.js";
// delete: fs workers/stopgap.ts

  const speechAnalysis = selectAnalysisProvider({ PROVIDER: env.PROVIDER, OPENAI_API_KEY: env.OPENAI_API_KEY });
  const runner = new JobRunner({
    db: d,
    handle: async (job) => {
      if (job.sessionId === null) return;
      if (job.type === "analyze") {
        await runAnalysis({ db: d, provider: speechAnalysis, sessionId: job.sessionId, now: Date.now() });
      } else {
        await runPlanner({ db: d, provider: speechAnalysis, sessionId: job.sessionId, now: Date.now() });
      }
    },
  });
  const queue: (type: "analyze" | "plan_next", sessionId: string) => void = (type, sessionId) => runner.enqueue(type, sessionId);
  runner.start();
```

(`queue` was previously declared before `buildApp` — move its declaration above the `buildApp` call as above.)

- [ ] **Step 9: Run all API tests**

Run: `pnpm vitest run apps/api`
Expected: worker suite + all earlier suites PASS.

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "feat(api): job runner with backoff, analysis + planner workers, learner memory updates"
```

---
### Task 8: End-to-end pipeline test + synthetic learner evaluation

The engine golden cases from spec §11.1 are already pinned by Task 4's unit tests (same inputs/expectations, inlined rather than as `fixtures/*.json` — a separate fixture directory would duplicate the test data without adding coverage). This task adds the two remaining spec test layers: the full pipeline e2e (§11.3) and the synthetic-learner longitudinal check (§11.2).

**Files:**
- Create: `apps/api/tests/e2e/pipeline.test.ts`
- Create: `tests/learning/synthetic-learners.test.ts` (at repo root `english-coach/tests/learning/`)

**Interfaces:**
- Consumes: everything from Tasks 3–7.
- Produces: no new production code. Both test files are regression gates for the shipped system.

- [ ] **Step 1: Write the e2e pipeline test**

`english-coach/apps/api/tests/e2e/pipeline.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { eq, and } from "drizzle-orm";
import {
  openDb, db, migrate, ensureSeed, sessions, skills, errorPatterns,
  learningPlans, jobs,
} from "@ec/db";
import type { DrizzleDb } from "@ec/db";
import { LEARNER_ID } from "@ec/domain";
import { MockSpeechProvider, type MockTurn } from "@ec/openai";
import { SessionService } from "../../src/services/session.js";
import { RealtimeBridge } from "../../src/realtime/bridge.js";
import { JobRunner } from "../../src/workers/jobs.js";
import { runAnalysis } from "../../src/workers/analysis.js";
import { runPlanner } from "../../src/workers/planner.js";
import { MockAnalysisProvider } from "@ec/openai";

const NOW = 1_700_000_000_000;

/** A 3-turn session: the learner makes the same past-tense error three times. */
const SCRIPT: MockTurn[] = [
  { speaker: "coach", text: "Hi! Tell me about yesterday.", pauseMs: 25 },
  { speaker: "learner", text: "Yesterday I go to work by train.", pauseMs: 25 },
  { speaker: "coach", text: "And what did you do after work?", pauseMs: 25 },
  { speaker: "learner", text: "Yesterday I go home and I eat dinner.", pauseMs: 25 },
  { speaker: "coach", text: "Was it a good dinner?", pauseMs: 25 },
  { speaker: "learner", text: "Yesterday I go to a restaurant with my friend.", pauseMs: 25,
    toolCall: { name: "request_micro_coaching", skill: "grammar.past_tense", reason: "recurring present-form-after-past-time" } },
];

function fakeClient() {
  const sent: any[] = [];
  return { sent, send: (m: string) => sent.push(JSON.parse(m)), readyState: 1 };
}

describe("full pipeline (mock provider, spec 11.3)", () => {
  let d: DrizzleDb;
  let service: SessionService;
  let runner: JobRunner;

  beforeEach(() => {
    const sqlite = openDb(":memory:");
    migrate(sqlite);
    ensureSeed(sqlite);
    d = db(sqlite);
    service = new SessionService(d);
    runner = new JobRunner({
      db: d, pollMs: 5,
      handle: async (job) => {
        if (!job.sessionId) return;
        if (job.type === "analyze") {
          await runAnalysis({ db: d, provider: new MockAnalysisProvider(), sessionId: job.sessionId, now: Date.now() });
        } else {
          await runPlanner({ db: d, provider: new MockAnalysisProvider(), sessionId: job.sessionId, now: Date.now() });
        }
      },
    });
  });

  it("session → utterances → analysis → memory → next plan, and the next session reflects it", async () => {
    const s = service.createSession(LEARNER_ID, NOW);

    // live session
    const bridge = new RealtimeBridge({
      sessionId: s.id,
      provider: new MockSpeechProvider({ turns: SCRIPT }),
      service,
      learnerContext: service.getLearnerContext(s.id),
      difficulty: 0.5,
      warmupMs: 5,
      sessionTargetMs: 600_000,
      onEnded: () => runner.enqueue("analyze", s.id),
    });
    bridge.attach(fakeClient() as never);
    await new Promise((r) => setTimeout(r, 500));
    bridge.destroy("e2e");

    // end + persist. In production the WS client's "end" control message
    // triggers bridge.onEnded → enqueue; destroy() is a test-only teardown,
    // so we enqueue the same way the HTTP /end route would.
    const end = service.endSession(s.id, NOW + 120_000);
    expect(end.ok).toBe(true);
    runner.enqueue("analyze", s.id);

    // run the queued jobs in order (runner.poll would too; processOne is deterministic)
    const analyzeJob = d.select().from(jobs)
      .where(and(eq(jobs.type, "analyze"), eq(jobs.sessionId, s.id))).all()[0];
    await runner.processOne(analyzeJob.id);

    const planJob = d.select().from(jobs)
      .where(and(eq(jobs.type, "plan_next"), eq(jobs.sessionId, s.id))).all()[0];
    expect(planJob).toBeTruthy();
    await runner.processOne(planJob.id);

    // assertions: memory changed
    const skill = d.select().from(skills).where(
      and(eq(skills.learnerId, LEARNER_ID), eq(skills.code, "grammar.past_tense")),
    ).all()[0];
    expect(skill.observationCount).toBe(3);
    expect(skill.mastery).toBeLessThan(0.5);

    const err = d.select().from(errorPatterns).where(
      and(eq(errorPatterns.learnerId, LEARNER_ID), eq(errorPatterns.skillCode, "grammar.past_tense")),
    ).all()[0];
    expect(err.frequency).toBe(3);
    expect(err.confidence).toBeGreaterThanOrEqual(0.9);

    // assertions: next session reflects the evidence (spec 11.3 exit criterion)
    const plan = d.select().from(learningPlans).where(
      and(eq(learningPlans.learnerId, LEARNER_ID), eq(learningPlans.status, "active")),
    ).all()[0];
    const primary = JSON.parse(plan.primaryTargets) as string[];
    expect(primary[0]).toBe("grammar.past_tense");

    const next = service.createSession(LEARNER_ID, NOW + 3_600_000);
    expect(next.difficulty).toBeCloseTo(plan.difficulty, 2);
    const ctx = service.getLearnerContext(next.id);
    expect(ctx.currentSessionTargets[0]).toBe("grammar.past_tense");
    expect(ctx.activeWeaknesses).toContain("grammar.past_tense");
    expect(ctx.recentTopics).toContain(s.topic);

    const sessionRow = d.select().from(sessions).where(eq(sessions.id, s.id)).all()[0];
    expect(sessionRow.status).toBe("COMPLETED");
  }, 15_000);
});
```

Implementer: replace the awkward `import("@ec/db").jobs` / `__importJobs()` constructs with a plain top-level `jobs` import (already in the import list — add `jobs` to it) and delete the `__importJobs` helper and the `sessionRow.utterance_check()` no-op line.

- [ ] **Step 2: Write the synthetic-learner evaluation (spec 11.2)**

`english-coach/tests/learning/synthetic-learners.test.ts` — drives the engine directly (no DB): feeds 10 simulated sessions of observations per profile through `updateSkill` / `upsertErrorInput` / `rankCandidates` / `selectTargets` / `adjustDifficulty` and asserts the spec's four behaviors.

```ts
import { describe, it, expect } from "vitest";
import {
  updateSkill, trendFromDelta,
  upsertErrorInput, shouldRetire, isRecurring,
  rankCandidates, selectTargets, calculatePriority,
  adjustDifficulty, recentPerformance,
  type TargetCandidate, type ErrorPatternInput,
} from "@ec/learning-engine";
import type { SkillState } from "@ec/domain";

const DAY = 86_400_000;

interface Profile {
  name: string;
  // per skill: initial mastery and per-session performance series (10 sessions)
  skills: Record<string, { mastery: number; perf: number[] }>;
  // error patterns observed in specific sessions
  errors: Record<string, { sessions: number[]; pattern: string; severity: number; confidence: number }>;
}

function simulate(p: Profile) {
  const skills = new Map<string, SkillState>();
  const errors = new Map<string, ErrorPatternInput>();
  const planPerSession: string[][] = [];
  const difficulties: number[] = [0.5];
  const scores: number[] = [];

  for (let s = 0; s < 10; s++) {
    const now = s * 3 * DAY;
    for (const [code, sp] of Object.entries(p.skills)) {
      const prev = skills.get(code) ?? { mastery: sp.mastery, confidence: 0.1, observationCount: 0, trend: "stable" };
      const next = updateSkill(prev, sp.perf[s] ?? 0.5, now);
      skills.set(code, { ...next, trend: trendFromDelta(prev.mastery, next.mastery) });
    }
    for (const [code, e] of Object.entries(p.errors)) {
      if (e.sessions.includes(s)) {
        const prev = errors.get(code) ?? null;
        const next = upsertErrorInput(prev, {
          skill: code, pattern: e.pattern, severity: e.severity, confidence: e.confidence,
        }, now);
        if (next) errors.set(code, next);
      }
    }
    // difficulty step
    scores.push(Math.min(...[...Object.entries(p.skills)].map(([c, sp]) => sp.perf[s] ?? 0.5)));
    difficulties.push(adjustDifficulty(difficulties[difficulties.length - 1], recentPerformance(scores)));
    // target selection
    const goalTypes = ["grammar", "fluency"];
    const candidates: TargetCandidate[] = [...new Set([
      ...[...errors.entries()].filter(([c, e]) => e.status === "active").map(([c]) => c),
      ...Object.keys(p.skills).filter((c) => (skills.get(c)?.mastery ?? 0.5) < 0.5),
    ])].map((code) => {
      const e = errors.get(code);
      const m = skills.get(code)?.mastery ?? 0.5;
      return {
        skill: code,
        recurrence: e ? Math.min(1, e.frequency / 3) : 0,
        severity: e?.severity ?? 0.4,
        goalRelevance: goalTypes.includes(code.split(".")[0]) ? 1 : 0.3,
        communicativeImpact: e ? Math.min(1, e.severity) : 0.4,
        readiness: 1 - m,
        forgettingRisk: e ? 0.5 : 0,
        mastery: m,
      };
    });
    const { primary } = selectTargets(candidates);
    planPerSession.push(primary.map((t) => t.skill));
  }
  return { skills, errors, planPerSession, difficulties };
}

const A: Profile = {
  name: "A: strong vocabulary, weak grammar, good fluency",
  skills: {
    "vocabulary.breadth": { mastery: 0.8, perf: [0.85, 0.86, 0.84, 0.87, 0.85, 0.86, 0.88, 0.86, 0.87, 0.88] },
    "grammar.past_tense": { mastery: 0.4, perf: [0.3, 0.35, 0.34, 0.4, 0.42, 0.45, 0.5, 0.52, 0.55, 0.6] },
    "fluency.continuity": { mastery: 0.75, perf: [0.8, 0.78, 0.8, 0.82, 0.8, 0.8, 0.82, 0.8, 0.82, 0.8] },
  },
  errors: {
    "grammar.past_tense": { sessions: [0, 1, 2, 3], pattern: "present_after_past_expr", severity: 0.65, confidence: 0.9 },
  },
};

const B: Profile = {
  name: "B: strong grammar, weak fluency, frequent hesitation",
  skills: {
    "grammar.past_tense": { mastery: 0.85, perf: [0.9, 0.88, 0.9, 0.9, 0.88, 0.9, 0.9, 0.88, 0.9, 0.9] },
    "fluency.hesitation": { mastery: 0.3, perf: [0.25, 0.28, 0.3, 0.32, 0.35, 0.38, 0.4, 0.42, 0.45, 0.48] },
  },
  errors: {
    "fluency.hesitation": { sessions: [0, 2, 4, 6, 8], pattern: "filler_heaviness", severity: 0.4, confidence: 0.85 },
  },
};

const C: Profile = {
  name: "C: strong comprehension, poor vocabulary retrieval",
  skills: {
    "vocabulary.retrieval": { mastery: 0.25, perf: [0.2, 0.22, 0.25, 0.28, 0.3, 0.33, 0.35, 0.38, 0.4, 0.42] },
    "vocabulary.breadth": { mastery: 0.7, perf: [0.7, 0.72, 0.7, 0.72, 0.7, 0.72, 0.7, 0.72, 0.7, 0.72] },
  },
  errors: {
    "vocabulary.retrieval": { sessions: [0, 1, 3, 5, 7, 9], pattern: "word_search_pauses", severity: 0.5, confidence: 0.88 },
  },
};

for (const p of [A, B, C]) {
  describe(`profile ${p.name}`, () => {
    const out = simulate(p);

    it("selects the profile's weak skill as a target while it is weak", () => {
      const weak = p.name.startsWith("A") ? "grammar.past_tense"
        : p.name.startsWith("B") ? "fluency.hesitation"
        : "vocabulary.retrieval";
      const planned = out.planPerSession.filter((plan) => plan.includes(weak));
      expect(planned.length).toBeGreaterThanOrEqual(3);
    });

    it("does NOT overreact to isolated errors (no non-recurring skill targeted)", () => {
      // no profile has an isolated error; assert no target ever appears from a skill
      // whose error frequency < 3 and mastery >= 0.7
      for (const plan of out.planPerSession) {
        for (const skill of plan) {
          const e = out.errors.get(skill);
          const m = out.skills.get(skill)?.mastery ?? 0.5;
          if ((e?.frequency ?? 0) < 3 && m >= 0.7) {
            expect(plan, `isolated-error skill ${skill} should not be targeted`).not.toContain(skill);
          }
        }
      }
    });

    it("stops targeting a skill once it is mastered", () => {
      const final = out.planPerSession[9];
      for (const skill of final) {
        expect(out.skills.get(skill)?.mastery ?? 0.5).toBeLessThan(0.8);
      }
    });

    it("adjusts difficulty within bounds, monotonically non-chaotic", () => {
      for (const d of out.difficulties) {
        expect(d).toBeGreaterThanOrEqual(0.15);
        expect(d).toBeLessThanOrEqual(0.95);
      }
      for (let i = 1; i < out.difficulties.length; i++) {
        expect(Math.abs(out.difficulties[i] - out.difficulties[i - 1])).toBeLessThanOrEqual(0.051);
      }
    });
  });
}
```

- [ ] **Step 3: Run both test files**

Run: `cd english-coach && pnpm vitest run apps/api/tests/e2e tests/learning`
Expected: PASS. If the e2e test is timing-flaky (mock provider 25 ms pauses), raise the wait to 800 ms — do not speed up the provider.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "test: end-to-end pipeline (mock) + synthetic learner evaluation"
```

---
### Task 9: Web client (Vite + React SPA)

The voice path splits into **pure modules** (unit-tested under node) and **browser-only modules** (correctness checked by `vite build` + typecheck, since AudioWorklet/AudioContext can't run in node). The WS message types are re-declared locally in the web package (the web does not depend on `@ec/api`); keep them in sync with `apps/api/src/realtime/bridge.ts` — a protocol change touches both.

**Files:**
- Create: `apps/web/index.html`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/App.tsx`
- Create: `apps/web/src/types/messages.ts`
- Create: `apps/web/src/audio/pcm.ts`
- Create: `apps/web/src/audio/wsClient.ts`
- Create: `apps/web/src/audio/capture.ts`
- Create: `apps/web/src/audio/player.ts`
- Create: `apps/web/src/audio/worklet.js`
- Create: `apps/web/src/state/transcript.ts`
- Create: `apps/web/src/api/client.ts`
- Create: `apps/web/src/views/SessionView.tsx`
- Create: `apps/web/src/views/DashboardView.tsx`
- Create: `apps/web/src/views/GoalsView.tsx`
- Test: `apps/web/src/audio/pcm.test.ts`, `wsClient.test.ts`, `state/transcript.test.ts`

**Interfaces:**
- Consumes: nothing from other packages (self-contained; talks to the API over HTTP/WS).
- Produces: a buildable SPA. Tested units: `pcm.ts` (`floatToPcm16`, `pcm16ToFloat`, `resampleLinear`, `bytesToBase64`, `base64ToBytes`), `wsClient.ts` (`SessionSocket`), `state/transcript.ts` (`applyTranscript`, `initialTranscript`).

- [ ] **Step 1: Write failing tests (pure modules only)**

`apps/web/src/audio/pcm.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { floatToPcm16, pcm16ToFloat, resampleLinear, bytesToBase64, base64ToBytes } from "./pcm.js";

describe("pcm16 round trip", () => {
  it("encodes and decodes with quantization error < 1/32768", () => {
    const input = new Float32Array([0, 0.5, -0.5, 1, -1, 0.123, -0.987]);
    const pcm = floatToPcm16(input);
    const back = pcm16ToFloat(pcm);
    for (let i = 0; i < input.length; i++) {
      expect(Math.abs(back[i] - input[i])).toBeLessThan(1 / 32768 + 1e-9);
    }
  });
  it("clamps out-of-range input", () => {
    const pcm = floatToPcm16(new Float32Array([2.0, -3.0]));
    expect(pcm[0]).toBe(0x7fff);
    expect(pcm[1]).toBe(-0x8000);
  });
});

describe("resampleLinear", () => {
  it("returns a copy at equal rates", () => {
    const in_ = new Float32Array([1, 2, 3]);
    const out = resampleLinear(in_, 16000, 16000);
    expect(out).toEqual(new Float32Array([1, 2, 3]));
    expect(out).not.toBe(in_);
  });
  it("halves length when downsampling 2x", () => {
    const in_ = new Float32Array([0, 1, 0, -1, 0, 1, 0, -1]);
    const out = resampleLinear(in_, 32000, 16000);
    expect(out.length).toBe(4);
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[2]).toBeCloseTo(0, 5);
  });
  it("keeps a constant signal constant", () => {
    const in_ = new Float32Array(100).fill(0.42);
    const out = resampleLinear(in_, 16000, 44100);
    expect(out.length).toBe(Math.round(100 * 44100 / 16000));
    for (const v of out) expect(v).toBeCloseTo(0.42, 4);
  });
});

describe("base64 over bytes", () => {
  it("round-trips arbitrary buffers (1, 2, and 3-byte-aligned lengths)", () => {
    for (const len of [1, 2, 3, 4, 5, 17, 255]) {
      const u8 = new Uint8Array(len);
      for (let i = 0; i < len; i++) u8[i] = (i * 37 + 11) & 0xff;
      expect(Array.from(base64ToBytes(bytesToBase64(u8)))).toEqual(Array.from(u8));
    }
  });
  it("matches Buffer base64", () => {
    const u8 = new Uint8Array([0, 255, 65, 128, 1]);
    expect(bytesToBase64(u8)).toBe(Buffer.from(u8).toString("base64"));
  });
});
```

`apps/web/src/audio/wsClient.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { SessionSocket } from "./wsClient.js";
import type { WsLike, ServerMessage } from "./wsClient.js";

function mockSocket(): WsLike & { out: string[]; fireMessage(msg: unknown): void; fireClose(reason: string): void } {
  const out: string[] = [];
  let onMessage: any, onClose: any;
  const socket: any = {
    out,
    send: (d: string) => { out.push(d); },
    close: () => {},
    set onmessage(cb: any) { onMessage = cb; },
    set onclose(cb: any) { onClose = cb; },
    fireMessage: (msg: unknown) => onMessage?.({ data: JSON.stringify(msg) }),
    fireClose: (reason: string) => onClose?.({ reason }),
  };
  return socket;
}

describe("SessionSocket", () => {
  it("sends audio frames as base64 JSON", () => {
    const s = mockSocket();
    const socket = new SessionSocket(s, () => {}, () => {});
    socket.sendAudio(new Int16Array([1, -2, 3]));
    const frame = JSON.parse(s.out[0]);
    expect(frame.t).toBe("audio");
    expect(typeof frame.data).toBe("string");
    expect(frame.data.length).toBeGreaterThan(0);
  });

  it("parses server messages to the callback", () => {
    const s = mockSocket();
    const received: ServerMessage[] = [];
    new SessionSocket(s, (m) => received.push(m), () => {});
    s.fireMessage({ t: "state", state: "CONVERSATION" });
    s.fireMessage({ t: "transcript", speaker: "learner", text: "hi", seq: 1, startedAt: 0, endedAt: 100 });
    expect(received.map((m) => m.t)).toEqual(["state", "transcript"]);
  });

  it("swallows malformed messages instead of throwing", () => {
    const s = mockSocket();
    const received: ServerMessage[] = [];
    new SessionSocket(s, (m) => received.push(m), () => {});
    // @ts-expect-error simulating a corrupt frame
    s.onmessage({ data: "{not json" });
    expect(received).toHaveLength(0);
  });

  it("forwards close reason", () => {
    const s = mockSocket();
    const reason = vi.fn();
    new SessionSocket(s, () => {}, reason);
    s.fireClose("server_gone");
    expect(reason).toHaveBeenCalledWith("server_gone");
  });
});
```

Note: `mockSocket` uses setters for `onmessage`/`onclose`; the `SessionSocket` constructor assigns `socket.onmessage = ...` and `socket.onclose = ...`, which trigger those setters. The `fireMessage`/`fireClose` helpers then invoke the stored callbacks. Remove the now-unused `onMessage`/`onClose` local var pattern if it doesn't compile — the setters store into `onMessage`/`onClose` which `fireMessage`/`fireClose` read.

`apps/web/src/state/transcript.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { initialTranscript, applyTranscript } from "./transcript.js";

describe("transcript reducer", () => {
  it("appends in seq order even if delivered out of order", () => {
    let s = initialTranscript();
    s = applyTranscript(s, { t: "transcript", seq: 2, speaker: "coach", text: "second" });
    s = applyTranscript(s, { t: "transcript", seq: 1, speaker: "learner", text: "first" });
    expect(s.turns.map((t) => t.text)).toEqual(["first", "second"]);
  });

  it("ignores duplicate seqs (reconnect replay)", () => {
    let s = initialTranscript();
    s = applyTranscript(s, { t: "transcript", seq: 1, speaker: "learner", text: "a" });
    const again = applyTranscript(s, { t: "transcript", seq: 1, speaker: "learner", text: "a" });
    expect(again.turns).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd english-coach && pnpm vitest run apps/web`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement the pure modules**

`apps/web/src/audio/pcm.ts`:

```ts
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToBase64(u8: Uint8Array): string {
  let out = "";
  const len = u8.length;
  for (let i = 0; i < len; i += 3) {
    const b1 = u8[i];
    const b2 = i + 1 < len ? u8[i + 1] : 0;
    const b3 = i + 2 < len ? u8[i + 2] : 0;
    out += B64[(b1 >> 2) & 63];
    out += B64[((b1 & 3) << 4) | ((b2 >> 4) & 15)];
    out += i + 1 < len ? B64[((b2 & 15) << 2) | ((b3 >> 6) & 3)] : "=";
    out += i + 2 < len ? B64[b3 & 63] : "=";
  }
  return out;
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/=+$/, "");
  const outLen = Math.floor((clean.length * 3) / 4);
  const u8 = new Uint8Array(outLen);
  let j = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const e1 = B64.indexOf(clean[i]);
    const e2 = B64.indexOf(clean[i + 1]);
    const e3 = B64.indexOf(clean[i + 2]);
    const e4 = B64.indexOf(clean[i + 3]);
    const n = (e1 << 18) | (e2 << 12) | (e3 << 6) | e4;
    u8[j++] = (n >> 16) & 255;
    if (j < u8.length) u8[j++] = (n >> 8) & 255;
    if (j < u8.length) u8[j++] = n & 255;
  }
  return u8;
}

export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export function pcm16ToFloat(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = input[i] / 0x8000;
  return out;
}

export function resampleLinear(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate) return input.slice();
  const ratio = outRate / inRate;
  const outLen = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIdx = i * ratio;
    const i0 = Math.min(Math.floor(srcIdx), input.length - 1);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcIdx - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}
```

`apps/web/src/audio/wsClient.ts`:

```ts
import { bytesToBase64 } from "./pcm.js";
import type { ClientMessage, ServerMessage } from "../types/messages.js";

export type { ClientMessage, ServerMessage } from "../types/messages.js";

/** Minimal WebSocket surface so tests can supply a fake. */
export interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: ((ev: { reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export class SessionSocket {
  constructor(
    private readonly socket: WsLike,
    private readonly onMessage: (m: ServerMessage) => void,
    private readonly onClose: (reason: string) => void,
  ) {
    this.socket.onmessage = (ev) => {
      try { this.onMessage(JSON.parse(ev.data) as ServerMessage); } catch { /* corrupt frame */ }
    };
    this.socket.onclose = (ev) => this.onClose(String(ev.reason ?? "closed"));
    this.socket.onerror = () => { /* surfaced via onclose */ };
  }

  sendAudio(pcm: Int16Array): void {
    const u8 = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    this.socket.send(JSON.stringify({ t: "audio", data: bytesToBase64(u8) } satisfies ClientMessage));
  }

  sendControl(action: "start" | "end" | "mute" | "unmute"): void {
    this.socket.send(JSON.stringify({ t: "control", action } satisfies ClientMessage));
  }

  close(): void { this.socket.close(); }
}
```

`apps/web/src/state/transcript.ts`:

```ts
export interface Turn { seq: number; speaker: string; text: string; }
export interface TranscriptState { turns: Turn[]; }
export type TranscriptMessage = Extract<import("../types/messages.js").ServerMessage, { t: "transcript" }>;

export function initialTranscript(): TranscriptState {
  return { turns: [] };
}

export function applyTranscript(state: TranscriptState, m: TranscriptMessage): TranscriptState {
  if (state.turns.some((t) => t.seq === m.seq)) return state;
  const turns = [...state.turns, { seq: m.seq, speaker: m.speaker, text: m.text }]
    .sort((a, b) => a.seq - b.seq);
  return { turns };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/web`
Expected: all three pure-module suites PASS.

- [ ] **Step 5: Write the browser-only modules + views (build-checked)**

`apps/web/src/types/messages.ts` (mirror of the API protocol):

```ts
export type ClientMessage =
  | { t: "audio"; data: string }
  | { t: "control"; action: "start" | "end" | "mute" | "unmute" };

export type ServerMessage =
  | { t: "audio"; data: string; sampleRate: number }
  | { t: "transcript"; speaker: "learner" | "coach"; text: string; seq: number; startedAt: number; endedAt: number }
  | { t: "state"; state: string }
  | { t: "intervention"; kind: "micro_coach" | "target_retry" | "challenge"; skill: string }
  | { t: "session_ended"; state: string };
```

`apps/web/src/audio/capture.ts`:

```ts
import { floatToPcm16, resampleLinear } from "./pcm.js";

export interface Capture {
  start(onFrame: (pcm: Int16Array) => void): Promise<number>; // returns source sample rate
  stop(): void;
}

export async function createCapture(sampleRate = 16000): Promise<Capture> {
  const ctx = new AudioContext();
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const source = ctx.createMediaStreamSource(stream);
  const node = ctx.createScriptProcessor(4096, 1, 1);
  let active = false;
  let started = 0;

  node.onaudioprocess = (ev) => {
    if (!active) return;
    const input = ev.inputBuffer.getChannelData(0); // ctx.sampleRate rate
    const resampled = resampleLinear(input, ctx.sampleRate, sampleRate);
    const now = Date.now();
    if (now - started >= 20 || started === 0) {
      started = now;
      onFrame(floatToPcm16(resampled));
    }
  };
  source.connect(node);
  node.connect(ctx.destination); // ScriptProcessor requires a destination to run

  return {
    start: async () => { await ctx.resume(); active = true; started = 0; return ctx.sampleRate; },
    stop: () => { active = false; node.disconnect(); source.disconnect(); void ctx.close(); stream.getTracks().forEach((t) => t.stop()); },
  };
}
```

(`createScriptProcessor` is deprecated but universally available and simplest for a single-user local app; upgrade path: an AudioWorklet processor when low-latency on modern browsers matters.)

`apps/web/src/audio/worklet.js` (playback node — reads a shared ring buffer):

```js
class PlaybackProcessor extends AudioWorkletProcessor {
  static get processorName() { return "ec-playback"; }
  constructor() {
    super();
    this.ring = new Float32Array(8192);
    this.read = 0;
    this.write = 0;
    this.port.onmessage = (ev) => {
      const chunk = ev.data;
      if (this.write - this.read + chunk.length > this.ring.length) {
        // drop oldest to stay bounded (underrun preferred over growing latency)
        const drop = this.read + chunk.length - this.ring.length;
        this.ring.set(this.ring.subarray(drop, this.write));
        this.read = 0;
        this.write = this.write - drop;
      }
      this.ring.set(chunk, this.write);
      this.write += chunk.length;
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    for (let i = 0; i < out.length; i++) {
      if (this.read < this.write) {
        out[i] = this.ring[this.read % this.ring.length];
        this.read++;
      } else {
        out[i] = 0;
      }
    }
    return true;
  }
}
registerProcessor("ec-playback", PlaybackProcessor);
```

`apps/web/src/audio/player.ts`:

```ts
import { resampleLinear, base64ToBytes, pcm16ToFloat } from "./pcm.js";

export interface Player {
  playBase64(b64: string, sampleRate: number): void;
  start(): Promise<void>;
  stop(): void;
}

export async function createPlayer(): Promise<Player> {
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule(new URL("./worklet.js", import.meta.url).toString());
  let node: AudioWorkletNode | null = null;
  let rate = ctx.sampleRate;
  return {
    async start() { await ctx.resume(); },
    playBase64(b64: string, sampleRate: number) {
      rate = sampleRate;
      if (!node) {
        node = new AudioWorkletNode(ctx, "ec-playback");
        node.connect(ctx.destination);
      }
      const u8 = base64ToBytes(b64);
      const pcm = new Int16Array(u8.buffer, u8.byteOffset, Math.floor(u8.byteLength / 2));
      const float = resampleLinear(pcm16ToFloat(pcm), sampleRate, ctx.sampleRate);
      node.port.postMessage(float);
    },
    stop() { node?.disconnect(); node = null; void ctx.close(); },
  };
}
```

`apps/web/src/api/client.ts`:

```ts
const BASE = "http://127.0.0.1:3100";
const LEARNER_ID = "learner-1";

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, { headers: { "Content-Type": "application/json" }, ...init });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.status === 204 ? (undefined as T) : (res.json() as Promise<T>);
}

export const api = {
  createSession: () => http<{ sessionId: string; topic: string; difficulty: number; state: string }>(
    `/v1/learners/${LEARNER_ID}/sessions`, { method: "POST" }),
  endSession: (id: string) => http<{ state: string }>(`/v1/sessions/${id}/end`, { method: "POST" }),
  session: (id: string) => http<unknown>(`/v1/sessions/${id}`),
  profile: () => http<Record<string, unknown>>(`/v1/learners/${LEARNER_ID}`),
  skills: () => http<Array<Record<string, unknown>>>(`/v1/learners/${LEARNER_ID}/skills`),
  plan: () => http<Record<string, unknown>>(`/v1/learners/${LEARNER_ID}/learning-plan`),
  progress: () => http<Array<Record<string, unknown>>>(`/v1/learners/${LEARNER_ID}/progress`),
  goals: () => http<Array<Record<string, unknown>>>(`/v1/learners/${LEARNER_ID}/goals`),
  addGoal: (g: { type: string; description: string; priority?: number }) =>
    http<{ id: string }>(`/v1/learners/${LEARNER_ID}/goals`, { method: "POST", body: JSON.stringify(g) }),
  patchGoal: (id: string, patch: Record<string, unknown>) =>
    http<{ ok: boolean }>(`/v1/learners/${LEARNER_ID}/goals/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
};
```

`apps/web/src/App.tsx`:

```tsx
import { Routes, Route, NavLink } from "react-router";
import { SessionView } from "./views/SessionView.js";
import { DashboardView } from "./views/DashboardView.js";
import { GoalsView } from "./views/GoalsView.js";

export default function App() {
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 760, margin: "0 auto", padding: 24 }}>
      <nav style={{ display: "flex", gap: 16, marginBottom: 24, borderBottom: "1px solid #ddd", paddingBottom: 8 }}>
        <NavLink to="/">Session</NavLink>
        <NavLink to="/dashboard">Dashboard</NavLink>
        <NavLink to="/goals">Goals</NavLink>
      </nav>
      <Routes>
        <Route path="/" element={<SessionView />} />
        <Route path="/dashboard" element={<DashboardView />} />
        <Route path="/goals" element={<GoalsView />} />
      </Routes>
    </div>
  );
}
```

`apps/web/src/views/SessionView.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client.js";
import { createCapture } from "../audio/capture.js";
import { createPlayer } from "../audio/player.js";
import { SessionSocket } from "../audio/wsClient.js";
import { initialTranscript, applyTranscript, type TranscriptState } from "../state/transcript.js";

export function SessionView() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [state, setState] = useState("idle");
  const [transcript, setTranscript] = useState<TranscriptState>(initialTranscript());
  const [note, setNote] = useState("");
  const socketRef = useRef<{ stop: () => void } | null>(null);

  useEffect(() => () => socketRef.current?.stop(), []);

  async function start() {
    const created = await api.createSession();
    setSessionId(created.sessionId);
    setState("STARTING");
    const ws = new WebSocket(`ws://127.0.0.1:3100/ws/session/${created.sessionId}`);
    const player = await createPlayer();
    await player.start();
    const socket = new SessionSocket(ws as never, (m) => {
      if (m.t === "audio") player.playBase64(m.data, m.sampleRate);
      else if (m.t === "transcript") setTranscript((s) => applyTranscript(s, m));
      else if (m.t === "state") setState(m.state);
      else if (m.t === "intervention") setNote(`[${m.kind}] ${m.skill}`);
      else if (m.t === "session_ended") setState(m.state);
    }, (reason) => setState(`ended:${reason}`));
    const capture = await createCapture(16000);
    await capture.start((pcm) => socket.sendAudio(pcm)); // tested base64 path
    socket.sendControl("start");
    socketRef.current = { stop: () => { capture.stop(); player.stop(); socket.close(); } };
  }

  async function end() {
    if (sessionId) await api.endSession(sessionId).catch(() => {});
    socketRef.current?.stop();
  }

  return (
    <div>
      <h1>Speaking session</h1>
      <p>State: <strong>{state}</strong> {note && <span>({note})</span>}</p>
      <button onClick={start} disabled={!!sessionId}>Start</button>
      <button onClick={end} disabled={!sessionId}>End</button>
      <div style={{ marginTop: 24, maxHeight: 400, overflowY: "auto", border: "1px solid #eee", padding: 12 }}>
        {transcript.turns.map((t) => (
          <p key={t.seq} style={{ margin: "4px 0" }}>
            <strong>{t.speaker === "learner" ? "You" : "Coach"}:</strong> {t.text}
          </p>
        ))}
      </div>
    </div>
  );
}
```

`apps/web/src/views/DashboardView.tsx`:

```tsx
import { useEffect, useState } from "react";
import { api } from "../api/client.js";

interface SkillRow { code: string; mastery: number; confidence: number; trend: string; observation_count: number; }
interface PlanRow { difficulty: number; primaryTargets: string; secondaryTargets: string | null; topic: string | null; reasoning: string | null; }

export function DashboardView() {
  const [profile, setProfile] = useState<Record<string, unknown> | null>(null);
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [plan, setPlan] = useState<PlanRow | null>(null);
  const [progress, setProgress] = useState<Array<Record<string, unknown>>>([]);

  useEffect(() => {
    void api.profile().then(setProfile).catch(() => {});
    void api.skills().then(setSkills).catch(() => {});
    void api.plan().then(setPlan).catch(() => {});
    void api.progress().then(setProgress).catch(() => {});
  }, []);

  const primary = plan ? (JSON.parse(plan.primaryTargets) as string[]) : [];
  const secondary = plan?.secondaryTargets ? (JSON.parse(plan.secondaryTargets) as string[]) : [];

  return (
    <div>
      <h1>Progress</h1>
      {profile && (
        <p>
          Level: <strong>{String(profile.estimatedLevel ?? "—")}</strong>{" "}
          (confidence {Math.round(((profile.estimatedLevelConfidence as number) ?? 0) * 100)}%)
        </p>
      )}
      <h3>Skill mastery</h3>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr><th>Skill</th><th>Mastery</th><th>Trend</th><th>Obs</th></tr></thead>
        <tbody>
          {skills.map((s) => (
            <tr key={s.code} style={{ borderTop: "1px solid #eee" }}>
              <td>{s.code}</td>
              <td>{Math.round(s.mastery * 100)}%</td>
              <td>{s.trend}</td>
              <td>{s.observation_count}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {plan && (
        <div style={{ marginTop: 24 }}>
          <h3>Active plan</h3>
          <p>Topic: {plan.topic ?? "—"}</p>
          <p>Primary: {primary.join(", ") || "—"}</p>
          <p>Secondary: {secondary.join(", ") || "—"}</p>
          <p>Difficulty: {Math.round(plan.difficulty * 100)}%</p>
        </div>
      )}
      <h3>Last sessions</h3>
      <ul>{progress.map((p) => <li key={String(p.id)}>{String(p.topic ?? "—")} — overall {p.overall ?? "—"}</li>)}</ul>
    </div>
  );
}
```

`apps/web/src/views/GoalsView.tsx`:

```tsx
import { useEffect, useState } from "react";
import { api } from "../api/client.js";

interface GoalRow { id: string; type: string; description: string; priority: number; status: string; }

export function GoalsView() {
  const [goals, setGoals] = useState<GoalRow[]>([]);
  const [type, setType] = useState("");
  const [desc, setDesc] = useState("");

  const refresh = () => void api.goals().then(setGoals).catch(() => {});
  useEffect(() => { refresh(); }, []);

  async function add() {
    if (!type || !desc) return;
    await api.addGoal({ type, description: desc, priority: 0.5 });
    setType(""); setDesc("");
    refresh();
  }

  return (
    <div>
      <h1>Goals</h1>
      <ul>
        {goals.map((g) => (
          <li key={g.id}>
            [{g.type}] {g.description} (priority {g.priority}) — {g.status}
            <button onClick={() => void api.patchGoal(g.id, { status: "completed" }).then(refresh)}> Complete</button>
          </li>
        ))}
      </ul>
      <form onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <input placeholder="type (fluency/grammar/vocabulary)" value={type} onChange={(e) => setType(e.target.value)} />
        <input placeholder="description" value={desc} onChange={(e) => setDesc(e.target.value)} />
        <button type="submit">Add goal</button>
      </form>
    </div>
  );
}
```

`apps/web/src/main.tsx`:

```tsx
import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import App from "./App.js";

const root = createRoot(document.getElementById("root")!);
root.render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
```

`apps/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>English Coach</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/web/vite.config.ts`:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, host: "127.0.0.1" },
});
```

Update `apps/web/package.json` (from Task 1) — add `"dev": "vite"`, `"build": "tsc -p tsconfig.json && vite build"`, and ensure `react-router` is a dependency. The web `tsconfig.json` needs `"jsx": "react-jsx"` in compilerOptions and `"include": ["src", "vite.config.ts"]`.

- [ ] **Step 6: Run the pure-module tests, then the build**

Run:
```bash
pnpm vitest run apps/web          # pure modules PASS
pnpm --filter @ec/web build        # typecheck + vite build exit 0
```
Expected: vitest green; `build` exits 0 (this is the correctness gate for the browser-only audio + view code).

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(web): Vite+React client — session audio loop, dashboard, goals"
```

---
### Task 10: Real OpenAI providers + model pinning + README

No API key exists at build time, so the real providers must **compile, wire into the factory, and fail gracefully without a key** — their live behavior can only be exercised once `OPENAI_API_KEY` is set (manual smoke, documented in the README). Tests here cover the keyless guard and the factory; everything else is type-level verification via `pnpm typecheck`.

**Files:**
- Create: `packages/openai/src/models.ts` (model config)
- Create: `packages/openai/src/openai/speech.ts`
- Create: `packages/openai/src/openai/analysis.ts`
- Modify: `packages/openai/src/index.ts` (factory branches)
- Create: `packages/openai/src/openai/openai.test.ts`
- Create: `english-coach/README.md`
- Create: `english-coach/.env.example`

**Interfaces:**
- Consumes: `SpeechConversationProvider` / `AnalysisProvider` (Task 5), `@ec/prompts` (all four), `@ec/domain` (schemas).
- Produces: `class OpenAISpeechProvider implements SpeechConversationProvider`, `class OpenAIAnalysisProvider implements AnalysisProvider`, `MODEL_CONFIG`.

- [ ] **Step 1: Pin current model IDs**

Before writing code, check the current OpenAI docs for the actual model identifiers (the spec's `gpt-realtime-2.1` / `gpt-transcribe` names are unverified placeholders — spec §16 open item 1).

Run: fetch `https://platform.openai.com/docs/models` (and the Realtime API quickstart) and record the current:
- realtime voice model id (input+output audio)
- text model id suitable for structured-output analysis (Responses API)

Write them into `packages/openai/src/models.ts`:

```ts
/**
 * Pinned 2026-10-06 against platform.openai.com/docs/models.
 * Re-verify before a real key is plugged in (spec §16 open item 1):
 * realtime model names have changed repeatedly.
 */
export const MODEL_CONFIG = {
  realtime: "<current-realtime-model-id>",        // e.g. gpt-realtime-...
  analysis: "<current-text-model-id>",            // e.g. gpt-5.1 / gpt-4.1 class
  temperature: { conversation: 0.7, analysis: 0.2, planning: 0.4 },
} as const;
```

If the fetch fails (no network / docs moved), leave the two id strings as `gpt-realtime-2` and `gpt-4.1` and add a `// VERIFY` comment — the keyless guard means nothing breaks until a key is set.

- [ ] **Step 2: Write failing tests**

`packages/openai/src/openai/openai.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { selectSpeechProvider, selectAnalysisProvider } from "../index.js";

describe("provider factory", () => {
  it("defaults to the mock provider", () => {
    expect(selectSpeechProvider({ PROVIDER: undefined }).constructor.name).toBe("MockSpeechProvider");
    expect(selectAnalysisProvider({ PROVIDER: "mock" }).constructor.name).toBe("MockAnalysisProvider");
  });

  it("refuses to build a real provider without a key (clear error, no partial start)", () => {
    expect(() => selectSpeechProvider({ PROVIDER: "openai" })).toThrow(/OPENAI_API_KEY/);
    expect(() => selectAnalysisProvider({ PROVIDER: "openai" })).toThrow(/OPENAI_API_KEY/);
  });

  it("builds real providers only when key AND PROVIDER=openai", () => {
    const speech = selectSpeechProvider({ PROVIDER: "openai", OPENAI_API_KEY: "sk-test" }, { turns: [] });
    expect(speech.constructor.name).toBe("OpenAISpeechProvider");
    const analysis = selectAnalysisProvider({ PROVIDER: "openai", OPENAI_API_KEY: "sk-test" });
    expect(analysis.constructor.name).toBe("OpenAIAnalysisProvider");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd english-coach && pnpm vitest run packages/openai`
Expected: FAIL — `OpenAISpeechProvider` / `OpenAIAnalysisProvider` not exported.

- [ ] **Step 4: Implement `openai/speech.ts`**

```ts
import WebSocket from "ws";
import { MODEL_CONFIG } from "../models.js";
import type {
  ProviderEvent, SpeechConversationProvider, TranscriptTurn,
} from "../providers/types.js";

/**
 * Server-held Realtime session. The browser sends raw 16 kHz PCM16 over the
 * app WebSocket; this class bridges it to the OpenAI Realtime WebSocket
 * (raw `ws` to wss://api.openai.com/v1/realtime — no vendor SDK; the event
 * JSON protocol is the only OpenAI-specific surface, isolated in translate()).
 * Instructions arrive after connect: the bridge calls sendInstruction()
 * with the full rendered conversation prompt (see bridge.start()).
 */
export class OpenAISpeechProvider implements SpeechConversationProvider {
  private ws: WebSocket | null = null;
  private onEvent: ((e: ProviderEvent) => void) | null = null;
  private closed = false;

  constructor(private readonly apiKey: string) {}

  async connect(onEvent: (e: ProviderEvent) => void): Promise<void> {
    this.onEvent = onEvent;
    this.ws = new WebSocket("wss://api.openai.com/v1/realtime", {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    await new Promise<void>((resolve, reject) => {
      this.ws!.once("open", () => {
        this.send({ type: "session.update", session: {
          model: MODEL_CONFIG.realtime,
          voice: "alloy",
          modalities: ["audio", "text"],
          temperature: MODEL_CONFIG.temperature.conversation,
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
          turn_detection: { type: "server_vad" },
          tools: [
            { type: "function", name: "request_micro_coaching",
              description: "Request a brief correction of a recurring, target, or comprehension-affecting error.",
              parameters: { type: "object", properties: { skill: { type: "string" }, reason: { type: "string" } }, required: ["skill", "reason"] } },
            { type: "function", name: "request_target_retry",
              description: "Create another opportunity for the learner to practice a target structure.",
              parameters: { type: "object", properties: { skill: { type: "string" } }, required: ["skill"] } },
          ],
        } });
        resolve();
      });
      this.ws!.once("error", (err) => reject(new Error(`realtime connect failed: ${String(err.message ?? err)}`)));
    });
    this.ws.on("message", (data) => {
      try { this.translate(JSON.parse(String(data))); } catch { /* ignore non-JSON frames */ }
    });
    this.ws.on("close", (code) => this.emitClosed(code === 1000 ? "closed" : `connection_lost_${code}`));
  }

  private translate(evt: Record<string, unknown>): void {
    switch (evt.type) {
      case "session.created":
        this.onEvent?.({ t: "connected" });
        break;
      case "input_audio_transcription.completed": {
        const turn: TranscriptTurn = {
          speaker: "learner",
          text: String(evt.transcript ?? ""),
          startedAt: Date.now(),
          endedAt: Date.now(),
        };
        this.onEvent?.({ t: "transcript", turn });
        break;
      }
      case "response.audio_transcript.done": {
        const turn: TranscriptTurn = {
          speaker: "coach",
          text: String(evt.transcript ?? ""),
          startedAt: Date.now(),
          endedAt: Date.now(),
        };
        this.onEvent?.({ t: "transcript", turn });
        break;
      }
      case "response.audio.delta":
        if (evt.delta) this.onEvent?.({ t: "audio", data: Buffer.from(String(evt.delta), "base64"), sampleRate: 24000 });
        break;
      case "conversation.item.created":
        break;
      case "response.output_item.added": {
        const item = evt.item as { type?: string; name?: string; arguments?: string } | undefined;
        if (item && item.type === "function_call" && item.name) {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(item.arguments ?? "{}"); } catch { /* empty args */ }
          this.handleFunctionCall(item.name, args);
        }
        break;
      }
      default:
        break;
    }
  }

  private handleFunctionCall(name: string, args: Record<string, unknown>): void {
    const skill = String(args.skill ?? "");
    if (name === "request_micro_coaching") {
      this.onEvent?.({ t: "tool_call", name, skill, reason: args.reason ? String(args.reason) : undefined });
    } else if (name === "request_target_retry") {
      this.onEvent?.({ t: "tool_call", name, skill });
    }
  }

  sendAudio(pcm16: Buffer): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send({ type: "input_audio_buffer.append", audio: pcm16.toString("base64") });
    }
  }

  sendInstruction(text: string): void {
    this.send({ type: "session.update", session: { instructions: text } });
  }

  close(): void {
    if (this.closed || !this.ws) return;
    this.closed = true;
    this.send({ type: "session.delete" });
    this.ws.close(1000, "client_closed");
  }

  private send(obj: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }
  private emitClosed(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.onEvent?.({ t: "closed", reason });
  }
}
```

The `translate()` switch is the single OpenAI-protocol-specific surface in the codebase — event names must be verified against the installed SDK/protocol docs when the key is first set (spec §16 open item 2); everything downstream consumes only normalized `ProviderEvent`s.

- [ ] **Step 5: Implement `openai/analysis.ts`**

```ts
import { OpenAI } from "openai";
import {
  LearnerContext, PlanDraft, SessionAnalysis,
  PlanDraftSchema, SessionAnalysisSchema, SKILL_CODES,
} from "@ec/domain";
import { loadPrompt, promptMeta } from "@ec/prompts";
import type { AnalysisInput, AnalysisProvider } from "../providers/types.js";
import { MODEL_CONFIG } from "../models.js";

export class OpenAIAnalysisProvider implements AnalysisProvider {
  private client: OpenAI;
  constructor(private readonly apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async analyze(input: AnalysisInput): Promise<SessionAnalysis> {
    const transcript = input.transcript
      .map((t) => `${t.speaker === "learner" ? "Learner" : "Coach"}: ${t.text}`)
      .join("\n");
    const prompt = loadPrompt("analysis")
      .replace("{{metrics}}", JSON.stringify(input.metrics))
      .replace("{{learner_context}}", JSON.stringify(input.learnerContext))
      .replace("{{targets}}", input.sessionTargets.join(", ") || "none")
      .replace("{{transcript}}", transcript)
      .replace("{{skill_codes}}", SKILL_CODES.join("\n"));

    const res = await this.client.responses.create({
      model: MODEL_CONFIG.analysis,
      temperature: promptMeta("analysis").temperature,
      instructions: prompt,
      input: "Return the SessionAnalysis JSON now.",
    });
    const text = (res.output_text as string) ?? "";
    return SessionAnalysisSchema.parse(parseJsonLoose(text));
  }

  async plan(input: { difficulty: number; candidates: string[]; learnerContext: LearnerContext }): Promise<PlanDraft> {
    const prompt = loadPrompt("planning")
      .replace("{{learner_context}}", JSON.stringify(input.learnerContext))
      .replace("{{difficulty}}", String(input.difficulty))
      .replace("{{candidates}}", input.candidates.map((c, i) => `${i + 1}. ${c}`).join("\n"))
      .replace("{{recent_topics}}", input.learnerContext.recentTopics.join("; ") || "none");

    const res = await this.client.responses.create({
      model: MODEL_CONFIG.analysis,
      temperature: promptMeta("planning").temperature,
      instructions: prompt,
      input: "Return the plan JSON now.",
    });
    return PlanDraftSchema.parse(parseJsonLoose((res.output_text as string) ?? ""));
  }
}

/** Providers sometimes wrap JSON in markdown fences; extract the first {...} block. */
function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("provider returned no JSON object");
  return JSON.parse(trimmed.slice(start, end + 1));
}
```

- [ ] **Step 6: Update the factory (`packages/openai/src/index.ts`)**

Add these two imports next to the existing `MockSpeechProvider`/`MockAnalysisProvider` imports, then replace the two `throw new Error("...not configured...")` branches with the real-provider construction:

```ts
import { OpenAISpeechProvider } from "./openai/speech.js";
import { OpenAIAnalysisProvider } from "./openai/analysis.js";

// selectSpeechProvider — replace the openai branch body:
export function selectSpeechProvider(
  env: { PROVIDER?: string; OPENAI_API_KEY?: string },
  script?: { turns: MockTurn[] },
): SpeechConversationProvider {
  if (env.PROVIDER === "openai") {
    if (!env.OPENAI_API_KEY) {
      throw new Error("PROVIDER=openai requires OPENAI_API_KEY (set PROVIDER=mock or export the key)");
    }
    return new OpenAISpeechProvider(env.OPENAI_API_KEY);
  }
  return new MockSpeechProvider(script ?? { turns: [] });
}

export function selectAnalysisProvider(
  env: { PROVIDER?: string; OPENAI_API_KEY?: string },
): AnalysisProvider {
  if (env.PROVIDER === "openai") {
    if (!env.OPENAI_API_KEY) {
      throw new Error("PROVIDER=openai requires OPENAI_API_KEY (set PROVIDER=mock or export the key)");
    }
    return new OpenAIAnalysisProvider(env.OPENAI_API_KEY);
  }
  return new MockAnalysisProvider();
}
```

Note: the real speech provider's instructions are the full rendered conversation prompt — the bridge sends them via `sendInstruction` after `connect()`, which maps to a second `session.update` carrying the learner-specific text. The first `session.update` in `connect()` carries model/voice/tools; the bridge's follow-up carries the instructions. Leave the Task 6b bridge unchanged.

- [ ] **Step 7: Add SDK dependencies**

Add `"openai": "^4.0.0"` (or latest major) and `"ws": "^8.18.0"` + devDep `"@types/ws": "^8.5.0"` to `packages/openai/package.json`. If the current `openai` major is v5+, use it — verify `client.responses.create({ instructions, input })` exists in the installed version; on older versions the equivalent is `client.chat.completions.create({ response_format: { type: "json_object" }, messages: [...] })`. Adjust the two call sites in `analysis.ts` accordingly.

Then run: `cd english-coach && pnpm install`

- [ ] **Step 8: Run tests + typecheck**

Run:
```bash
pnpm vitest run packages/openai   # factory tests PASS (mock + keyless guard + key-present construction)
pnpm typecheck                     # real providers compile against the SDK
```

- [ ] **Step 9: README + env template**

`english-coach/README.md`:

````markdown
# English Coach

Adaptive English speaking coach: realtime voice conversation → deterministic
analysis → learner memory → next session plan. LLMs observe and speak; a
deterministic learning engine owns all learning state.

See `../Docs/implementation-spec.md` for the design and
`../Docs/plans/2026-10-06-english-coach-implementation.md` for the build plan.

## Quickstart (no API key needed)

```bash
pnpm install
pnpm --filter @ec/db db:init      # create + seed SQLite
pnpm --filter @ec/api dev         # API on 127.0.0.1:3100 (PROVIDER=mock)
pnpm --filter @ec/web dev         # web client on http://127.0.0.1:5173
```

Open http://127.0.0.1:5173 → Start a session. In mock mode the "learner" side
is scripted (past-tense errors included) so the full analysis → memory →
planning pipeline runs end-to-end.

## Using the real OpenAI API

```bash
cp .env.example .env   # set OPENAI_API_KEY=sk-...
# PROVIDER=openai
```

Model IDs live in `packages/openai/src/models.ts` — they were pinned without
a key and MUST be re-verified against platform.openai.com/docs/models before
the first live run.

## Testing

```bash
pnpm test               # all unit + integration + e2e (mock provider)
```

## Layout

| Path | What |
| --- | --- |
| `apps/api` | Fastify API: session state machine, realtime bridge, WS protocol, job runner, analysis + planner workers |
| `apps/web` | Vite + React SPA (session, dashboard, goals) |
| `packages/domain` | Types, Zod schemas, canonical skill codes |
| `packages/db` | Drizzle/SQLite schema, migrations, seed |
| `packages/learning-engine` | Pure learning math (scoring, mastery, errors, difficulty, priority, planning) |
| `packages/openai` | Provider seam: mock + real OpenAI implementations |
| `packages/prompts` | Versioned prompt files + loader |
````

`english-coach/.env.example`:

```
# PROVIDER=mock            # default: scripted provider, no key needed
# PROVIDER=openai          # real OpenAI Realtime + Responses
# OPENAI_API_KEY=
PORT=3100
DB_PATH=./data/english-coach.db
WARMUP_MS=120000
SESSION_TARGET_MS=900000
```

- [ ] **Step 10: Full test suite + build**

Run:
```bash
pnpm test
pnpm build
```
Expected: every suite green, all workspaces build.

- [ ] **Step 11: Commit**

```bash
git add -A && git commit -m "feat(openai): real realtime + analysis providers, model config, README"
```

---

## Final verification (after Task 10)

Run the whole system cold, exactly as a user would:

```bash
cd english-coach
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @ec/db db:init
pnpm --filter @ec/api dev &        # terminal 1
# in a browser: http://127.0.0.1:5173
#   1. Session → Start. Watch the scripted mock conversation play:
#      state banner WARMUP → CONVERSATION, intervention toast on the
#      past-tense micro-coach, transcript streaming both speakers.
#   2. End. State → ANALYZING, then session row becomes COMPLETED.
#   3. Dashboard: grammar.past_tense mastery < 50%, a recurring
#      past-tense error pattern listed, active plan targets it,
#      level estimate shown with confidence.
#   4. Start a second session: learner context now carries the
#      past-tense target and the updated difficulty.
```

All of the above is verifiable with **no API key** (mock provider). With a key: set `PROVIDER=openai`, verify the model IDs in `models.ts` against the current docs, repeat the session flow with a real microphone.
