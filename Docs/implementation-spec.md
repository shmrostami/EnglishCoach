# English Coach — Implementation Spec (v1)

Date: 2026-10-06
Status: approved for planning
Source docs: `Docs/design.md` (concept), `architecture.md` (implementation blueprint)

---

## 1. Product definition

Adaptive English **speaking** coach. Core loop:

```
Speak → Observe → Diagnose → Remember → Adapt → Speak
```

The system improves the learner's spontaneous English over repeated sessions. It is not a grammar reference, translation tool, exam, or pronunciation trainer.

**Fundamental rule (unchanged from source docs):**

- LLMs produce **observations and language**.
- A deterministic **learning engine** owns learning state (mastery, difficulty, priorities).
- The **database** owns persistent truth.
- The **realtime agent** owns the conversation. It can *request* interventions; it never writes learner memory.

### Scope decisions (user-approved)

| Decision | Choice |
| --- | --- |
| Scope | Full system, all 6 phases from architecture.md §44 (voice, sessions, analysis, learner memory, adaptive learning, longitudinal progress) |
| Voice transport | OpenAI Realtime API, **server-held WebSocket** (API bridges browser ↔ OpenAI; no WebRTC in browser) |
| Database | SQLite via Drizzle (Postgres-shaped schema; migration to Postgres is a dialect swap) |
| Job queue | In-process worker over a `jobs` table (BullMQ/Redis is a later drop-in; workers must be idempotent either way) |
| Learners | Single learner, no auth. API binds localhost. `learner_id` column kept for later multi-tenant upgrade |
| Web client | Vite + React SPA (deviation from Next.js; voice-first app, separate Fastify backend makes Next SSR unused) |
| LLM access | No API key at build time. OpenAI behind a provider interface; **mock provider** enables full end-to-end build + test. Real key activates via `OPENAI_API_KEY` env var, no code changes |
| Model IDs | Docs name models that may not exist (`gpt-realtime-2.1`, `gpt-transcribe`). Real current IDs pinned at implementation time against official OpenAI docs; the provider interface is the seam |

### Non-goals for v1 (from architecture.md §45, kept)

No vector DB, no RAG, no multi-agent framework, no autonomous agent loops, no teacher dashboard, no gamification, no CEFR classifier, no audio recording/persistence (see §8.1).

---

## 2. Architecture

```
BROWSER (Vite + React)
  mic → PCM16 16 kHz mono → WebSocket
  ← PCM16 24 kHz mono audio, transcript events, session events
        │
        ▼
FASTIFY API (Node.js, TypeScript)
  ├── RealtimeBridge     server-held WS to OpenAI Realtime; audio + events
  ├── SessionService     deterministic state machine; utterance persistence
  ├── LearnerService     profile, goals, skills, plans, progress
  └── JobRunner          polls `jobs` table, runs workers in-process
        │  session.ended
        ▼
ANALYSIS WORKER
  deterministic metrics (WPM, pauses, speaking seconds)
  → AnalysisProvider (Responses API, structured output, Zod-validated)
        │
        ▼
LEARNING ENGINE (pure functions, no I/O)
  scoring · mastery · error recurrence/decay · prioritization · difficulty
        │
        ▼
LEARNER MEMORY (SQLite)  ──→  next learning plan
        (LLM proposes topic/candidates; engine selects targets)
```

### Component responsibilities

| Component | Owns | Must not |
| --- | --- | --- |
| `RealtimeBridge` | OpenAI WS connection, audio streaming, event translation | Touch the database |
| `SessionService` | Session state machine, utterances, interventions, session lifecycle | Call LLMs directly |
| `AnalysisWorker` | Metrics computation, analysis provider call, validation, persistence of `SessionAnalysis` | Apply learning decisions |
| `LearningEngine` (package) | All mastery/difficulty/priority math, target selection | I/O, LLM calls |
| `PlannerService` | Composes engine output + LLM topic/candidate proposal into `learning_plans` row | Trust LLM target selection (engine re-ranks) |
| `JobsRunner` | Job lifecycle (pending → running → done/failed), retries with backoff, idempotency | Business logic |

### Security boundary (architecture.md §47)

Browser never sees `OPENAI_API_KEY`, prompts, or learner memory beyond its own safe context. API binds `127.0.0.1` only.

---

## 3. Technology stack

| Layer | Technology |
| --- | --- |
| Language | TypeScript (strict), Node.js ≥ 22 |
| Monorepo | pnpm workspaces |
| API | Fastify 5 |
| DB | SQLite (better-sqlite3), Drizzle ORM, `drizzle-kit` migrations |
| Validation | Zod (shared schemas in `packages/domain`) |
| Web | Vite + React 18 + TypeScript, react-router, plain fetch + WebSocket |
| Jobs | In-process runner over `jobs` table |
| LLM | `openai` SDK; Realtime (conversation) + Responses (analysis/planning); mock provider for keyless dev |
| Testing | Vitest (unit + golden fixtures), `fastify.inject` (API), scripted mock sessions (e2e) |
| Tooling | eslint + prettier, single tsconfig base |

---

## 4. Repository layout

```
english-coach/
├── apps/
│   ├── web/
│   │   └── src/
│   │       ├── views/        SessionView · DashboardView · GoalsView
│   │       ├── audio/        pcm capture/decode, WS client
│   │       └── api/          typed fetch clients
│   └── api/
│       └── src/
│           ├── server.ts
│           ├── routes/       sessions.ts · learners.ts · ws-session.ts
│           ├── realtime/     bridge.ts · events.ts · pcm.ts
│           ├── services/     session.ts · learner.ts · planner.ts
│           ├── workers/      jobs.ts · analysis.ts · memory.ts
│           └── engine/       re-exports packages/learning-engine
├── packages/
│   ├── domain/               types.ts · schemas.ts (Zod) · cefr.ts
│   ├── db/                   schema.ts · client.ts · migrations/
│   ├── openai/
│   │   ├── providers/        types.ts (SpeechConversationProvider, AnalysisProvider)
│   │   ├── openai/           real implementations
│   │   └── mock/             fixture-driven implementations
│   ├── prompts/              conversation/analysis/diagnosis/planning/memory v1 + loader
│   └── learning-engine/      scoring.ts · mastery.ts · errors.ts · difficulty.ts
│                             · prioritization.ts · planning.ts  (pure functions)
├── fixtures/                 golden evaluation cases (see §11)
├── tests/
│   ├── unit/                 engine + domain
│   ├── api/                  fastify.inject route tests
│   └── e2e/                  full mocked session pipeline
└── pnpm-workspace.yaml
```

---

## 5. Domain model

```
Learner
├── Profile (level, languages, correction style, preferred session minutes)
├── Goals (type, description, priority, status)
├── Skills (hierarchical codes: grammar.past_tense, vocabulary.breadth, …)
├── ErrorPatterns (pattern, frequency, severity, mastery, confidence, decay)
├── VocabularyItems (word, recognition/production/collocation mastery)
├── Sessions → Utterances → Observations
└── LearningPlans (difficulty, primary/secondary targets, intervention, topic)
```

Skill code grammar: `<family>.<skill>`, families: `grammar`, `vocabulary`, `fluency`, `pronunciation`, `discourse`. Canonical code list lives in `packages/domain/codes.ts` — the single source of truth used by DB constraints (check lists), prompts, and the engine. Initial codes:

```
grammar: past_tense, present_perfect, conditionals, articles, prepositions, word_order
vocabulary: breadth, precision, collocations, retrieval
fluency: continuity, hesitation, retrieval_speed, self_correction
pronunciation: intelligibility, stress, rhythm
discourse: coherence, storytelling, argumentation
```

### Zod schemas (packages/domain/schemas.ts — abridged)

```ts
const SkillState = z.object({
  mastery: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  observationCount: z.number().int().nonnegative(),
});

const Observation = z.object({
  type: z.enum(["language_error", "strength", "vocabulary_use", "fluency_signal"]),
  skill: z.string(),                 // skill code
  evidence: z.string(),
  actual: z.string().optional(),
  expected: z.string().optional(),
  severity: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1),
});

const Scores = z.object({
  fluency: z.number().min(0).max(1),
  grammar: z.number().min(0).max(1),
  vocabulary: z.number().min(0).max(1),
  pronunciation: z.number().min(0).max(1),
  coherence: z.number().min(0).max(1),
  interaction: z.number().min(0).max(1),
});

const SessionAnalysis = z.object({
  scores: Scores,
  observations: z.array(Observation),
  recurring_errors: z.array(z.object({
    skill: z.string(),
    pattern: z.string(),
    confidence: z.number().min(0).max(1),
  })),
  strengths: z.array(z.object({
    skill: z.string(),
    evidence: z.string(),
    confidence: z.number().min(0).max(1),
  })),
  recommended_targets: z.array(z.string()),
});
```

All provider outputs are validated with these schemas server-side before any persistence. Invalid output ⇒ job fails, retried with backoff (max 3 attempts, then `failed`).

---

## 6. Database schema (SQLite, Drizzle)

Ported from architecture.md §5–12; `TIMESTAMPTZ` → `INTEGER` (unix ms), `NUMERIC(4,3)` → `REAL`, `JSONB` → `TEXT` (JSON string) + Zod parse on read.

| Table | Key columns (beyond `id INTEGER PK`) |
| --- | --- |
| `learners` | native_language, target_language='en', target_level, estimated_level, estimated_level_confidence, correction_style, preferred_session_minutes, created_at, updated_at |
| `learner_goals` | learner_id FK, type, description, priority (default 0.5), status ('active'\|'completed'), created_at, completed_at |
| `skills` | learner_id FK, code UNIQUE(learner_id, code), mastery=0.5, confidence=0.1, trend ('improving'\|'stable'\|'declining'), observation_count=0, last_assessed_at, next_review_at |
| `error_patterns` | learner_id FK, skill_code, pattern UNIQUE(learner_id, skill_code, pattern), description, frequency=1, severity, mastery=0, confidence=0.5, status ('active'\|'mastered'), first_seen_at, last_seen_at, next_review_at |
| `vocabulary_items` | learner_id FK, word UNIQUE(learner_id, word), recognition_mastery, production_mastery, collocation_mastery, exposure_count, production_count, last_used_at, next_review_at |
| `sessions` | learner_id FK, status, topic, planned_difficulty, achieved_difficulty, duration_seconds, fluency/grammar/vocabulary/pronunciation/coherence/interaction_score, overall_score, started_at, ended_at, analysis (JSON: last SessionAnalysis), metrics (JSON: deterministic metrics from §8.2) |
| `utterances` | session_id FK, speaker ('learner'\|'coach'), sequence_number, text, started_at, ended_at, duration_ms, word_count, pause_before_ms |
| `observations` | session_id FK, utterance_id FK NULL, type, skill_code, evidence, expected, actual, severity, confidence, created_at |
| `learning_plans` | learner_id FK, difficulty, primary_targets (JSON), secondary_targets (JSON), intervention_type, topic, reasoning, status, created_at |
| `jobs` | type ('analyze'\|'plan_next'), session_id NULL FK, status ('pending'\|'running'\|'done'\|'failed'), attempts, max_attempts=3, next_run_at, error, created_at, done_at. UNIQUE(session_id, type) enforces idempotency |

Seed: one learner row (native_language 'fa', target_level 'B2', correction_style 'moderate', preferred_session_minutes 15) + three starter goals (fluency / grammar / vocabulary, priorities 0.9/0.7/0.6).

### 6.1 Audio

Not stored in v1. Deterministic acoustic metrics are computed from live PCM streams and persisted on the session row (§8.2). Recording + retention controls (architecture.md §48) are out of scope; no schema column needed yet.

---

## 7. Session lifecycle

### 7.1 State machine (deterministic, in SessionService)

`CLOSING` is reachable from **every active state** — a learner can end the session at any time (including during warmup or before any speech), and the end path always runs `→ CLOSING → ANALYZING`.

```
STARTING → WARMUP → CONVERSATION ⇄ { MICRO_COACH | TARGET_RETRY | CHALLENGE } → CLOSING → ANALYZING → COMPLETED
                (any active state can jump to CLOSING on end)                                        ↘ FAILED
```

Transition table (invalid transitions rejected, logged, session continues):

```
STARTING:     WARMUP, CLOSING, FAILED
WARMUP:       CONVERSATION, CLOSING, FAILED
CONVERSATION: CONVERSATION, MICRO_COACH, TARGET_RETRY, CHALLENGE, CLOSING, FAILED
MICRO_COACH:  CONVERSATION, TARGET_RETRY, CLOSING, FAILED
TARGET_RETRY: CONVERSATION, CLOSING, FAILED
CHALLENGE:    CONVERSATION, CLOSING, FAILED
CLOSING:      ANALYZING
ANALYZING:    COMPLETED, FAILED
COMPLETED:    —
FAILED:       —
```

Terminal states (`COMPLETED`, `FAILED`) accept no transitions.

The realtime model requests transitions through tools; the backend validates each request against this table.

### 7.2 State semantics

- **STARTING** — load learner profile, active `learning_plans` row, build compact `LearnerContext` (§7.3), start RealtimeBridge with conversation instructions.
- **WARMUP** (~2–3 min, timer-driven) — low-pressure, no corrections. Bridge sends a system instruction to keep it light.
- **CONVERSATION** — normal flow. On learner utterance: persist `utterance`, update live metrics. Model may call tools.
- **MICRO_COACH** — model called `request_micro_coaching({skill, reason})`. Backend logs an `observations` row (intervention, skill, reason, confidence 0.9), instructs the model to make one concise correction and return to conversation. The backend auto-transitions to CONVERSATION when the next learner utterance is persisted.
- **TARGET_RETRY** — model called `request_target_retry({skill})`. Backend logs observation; instructs model to create a new situation requiring the target structure. Returns to CONVERSATION after the retry turn completes.
- **CHALLENGE** — model escalates (or timer at ~80% of preferred session minutes with good performance). Higher cognitive demand per plan difficulty.
- **CLOSING** — user ends session (or timer). Model wraps up; bridge closes; `session.ended` event.
- **ANALYZING** — `jobs` row `analyze` queued; session row marked; worker pipeline runs (§8).
- **COMPLETED / FAILED** — terminal. `plan_next` job queued on COMPLETED.

### 7.3 LearnerContext (sent to the realtime model, not the whole DB)

```ts
interface LearnerContext {
  level: string;                    // e.g. "B1+"
  goals: string[];
  strengths: string[];              // skill codes
  activeWeaknesses: string[];       // recurring error skill codes
  vocabularyTargets: string[];
  difficulty: number;
  correctionStyle: string;
  recentTopics: string[];           // last 5 session topics
  currentSessionTargets: string[];  // from active learning plan
}
```

Built from DB at session start; ~1KB; versioned prompt template injects it (prompts/conversation/v1, see §12).

### 7.4 Conversation instructions

Base prompt (`packages/prompts/conversation/v1.txt`, from architecture.md §20) with `{{learner_context}}`, `{{targets}}`, `{{difficulty}}` slots filled at session start. Rules 1–13 from the doc are unchanged, including: never shame, don't praise every sentence, prefer elicitation, return to conversation after correction, no native-language switches unless necessary.

---

## 8. Realtime transport (server-held)

### 8.1 Protocol

```
Browser ⇄ API:      WebSocket  ws://127.0.0.1:PORT/ws/session/:sessionId
API ⇄ OpenAI:       Realtime API WebSocket, server-held
```

Browser → API messages (JSON):
```
{ "t": "audio", "data": base64_pcm16_16kHz_mono }   // continuous, ~20 ms frames
{ "t": "control", "action": "start" | "end" | "mute" | "unmute" }
```

API → Browser messages:
```
{ "t": "audio", "data": base64_pcm16_24kHz_mono }
{ "t": "transcript", "speaker": "learner"|"coach", "text": string, "seq": n,
  "started_at": ms, "ended_at": ms }
{ "t": "state", "state": SessionState }              // state machine transitions
{ "t": "intervention", "kind": "micro_coach"|"target_retry"|"challenge", "skill": string }
{ "t": "session_ended" }
```

The API translates OpenAI Realtime events (input/output audio deltas, `response.audio_transcript.delta` or equivalent current-event names, `session.update` responses to tool calls) into this protocol. The translation layer (`realtime/events.ts`) is the only place that knows OpenAI event names — it is swapped per provider.

Browser audio: `getUserMedia` → `ScriptProcessorNode` capture (deprecated in v1, kept for simplicity; upgrade path is an `AudioWorkletNode` capturer) → resampled to 16 kHz mono PCM16 → base64 frames. Playback: base64 → PCM16 → Float32, resampled to the device-native `AudioContext` sample rate by a band-limited (windowed-sinc) filter in the browser — the client does the resampling because the browser's own output-stage upsample is naive and left audible spectral-image hiss — and posted to an `AudioWorklet` that drains a bounded ring buffer (drop-oldest when the chunk would overflow — underrun is preferred over growing latency). The server-side PCM16 rate is 16 kHz in mock mode and 24 kHz from the OpenAI Realtime API; the client resamples either to the device rate. The `local` provider has no fixed rate: each `audio` frame carries the TTS engine's real `sampleRate` (22050 for Piper, 24000 for Kokoro), and the client resamples that. Frames must arrive **at or faster than realtime** — a bounded ring buffer starves below ratio 1 and the zero-fill is audible as crackle (see the local-voice spec §4.1).

### 8.2 Deterministic session metrics (computed in SessionService, stored on session)

From live utterance/audio data — no LLM involved:

```
speaking_seconds, user_word_count, words_per_minute,
pause_count, avg_pause_ms, longest_pause_ms,
utterance_count, avg_utterance_words, rms_energy_avg
```

These feed `fluency`-related signals to the analysis prompt as *evidence*, alongside the transcript.

### 8.3 Realtime model tools

Exactly two (architecture.md §33). No memory tools.

```ts
{
  name: "request_micro_coaching",
  description: "Request a brief correction of a recurring, target, or comprehension-affecting error.",
  parameters: { skill: string, reason: string }
}
{
  name: "request_target_retry",
  description: "Create another opportunity for the learner to practice a target structure.",
  parameters: { skill: string }
}
```

Correction policy guidance lives in the prompt (design.md §14): correct only when recurring / target-skill / comprehension-affected / pronunciation-critical; first-occurrence low-impact errors are not interrupted.

---

## 9. Post-session pipeline

```
session.ended
  → SessionService: close realtime bridge, compute metrics, mark ANALYZING,
    enqueue job {type: "analyze", session_id}
  → JobsRunner (in-process, 1 s poll, backoff 2^attempts * 5 s, max 3):
      1. Idempotency check: skip if sessions.analysis already set
      2. Deterministic metrics → session.metrics
      3. analysisProvider.analyze({ transcript, metrics, learnerContext, targets })
         → SessionAnalysis (Zod-validated)
      4. Persist: session.scores + analysis JSON; rows into `observations`
      5. Learning engine (§10) → skill updates, error upserts, vocabulary,
         session-level mastery/difficulty changes
      6. Mark done; enqueue {type: "plan_next", session_id}
  → plan worker:
      1. Idempotency: skip if learner already has an active plan created after this session
      2. Engine: difficulty adjustment, ranked candidate targets
      3. Planner: LLM proposes topic + candidate skills within engine constraints
         (abstractness/familiarity bounds from difficulty); engine re-ranks and
         selects top-2 primary (+ up to 1 secondary); writes learning_plans
```

Worker failure semantics: `failed` after 3 attempts; session row keeps partial results; surfaced on dashboard; `analyze` can be manually re-triggered via `POST /v1/internal/sessions/:id/analyze`.

---

## 10. Learning engine (pure functions, packages/learning-engine)

No I/O, no randomness, no LLM. Every function takes plain data, returns plain data. Fully unit-tested.

### 10.1 Overall score

```ts
const WEIGHTS = { fluency: 0.25, grammar: 0.2, vocabulary: 0.2,
                  pronunciation: 0.15, coherence: 0.1, interaction: 0.1 };
overall = Σ (scores[k] * WEIGHTS[k])
```

### 10.2 Skill mastery (EMA, conservative)

```ts
function updateSkill(prev: SkillState, observation: number): SkillState {
  const alpha = prev.observationCount < 5 ? 0.25 : 0.15;
  mastery  = prev.mastery * (1 - alpha) + observation * alpha;
  confidence = Math.min(0.95, prev.confidence + 0.05);
  observationCount++;
  trend = compare vs. window of last 5: improving / stable / declining
}
```

Only observations with `confidence > 0.8` count toward mastery updates.

### 10.3 Error patterns

```
On observation (language_error, confidence > 0.8):
  upsert error_patterns by (learner, skill, pattern):
    frequency += 1, last_seen_at = now, confidence = max(existing, obs.confidence)
Recurring when: frequency >= 3 AND confidence >= 0.75
Decay (applied when reading, not stored): effectiveFrequency = frequency * e^(-daysSinceLastSeen / 30)
Retire (status = 'mastered') when: effectiveFrequency < 1 for 30 days
                                    OR target skill mastery >= 0.8 with confidence >= 0.8
```

### 10.4 Vocabulary items

Exposure counted from transcript (word seen in coach speech → exposure_count++); production from learner utterances (production_count++, production_mastery EMA). Recognition proxy: learner uses the word correctly at least once. Collocation mastery updated when analysis flags a collocation observation for that word. Review scheduling: `next_review_at = last_used_at + interval`, interval = `max(1, floor(10 * production_mastery))` days.

### 10.5 Difficulty

```ts
function adjustDifficulty(d: number, recentPerformance: number): number {
  // recentPerformance = mean of last 5 session overall scores (or 1 if first session)
  if (recentPerformance >= 0.85) next = d + 0.05;
  else if (recentPerformance >= 0.75) next = d + 0.02;
  else if (recentPerformance >= 0.55) next = d;
  else next = d - 0.05;
  return clamp(next, 0.15, 0.95);   // and |next - d| <= 0.05 always holds by construction
}
```

### 10.6 Target priority (engine selects, LLM proposes)

```ts
priority = 0.25 * recurrence            // normalized effectiveFrequency of errors on skill
         + 0.20 * severity              // mean severity of its error patterns
         + 0.20 * goalRelevance        // 1 if skill family matches an active goal type, else 0.3
         + 0.15 * communicativeImpact  // from analysis observation severity, capped
         + 0.10 * readiness            // 1 - mastery (practice the skill while it's reachable)
         + 0.10 * forgettingRisk       // 1 - e^(-daysSinceLastSeen/30) on the skill's last review
```

Candidates: skills with recurring errors ∪ `recommended_targets` from analysis ∪ skills tied to active goals. For any skill with no observation history, default `recurrence = 0`, `severity = 0.4` (neutral), `forgettingRisk = 0`, and `readiness = 1 - mastery` (0.5 for never-assessed skills). Engine ranks; **top 2 primary, up to 1 secondary**. LLM-proposed candidates that the engine would rank below its own top-2 are rejected. Mastered skills (10.3 retire rule) are excluded.

### 10.7 Intervention type

Chosen per target: recurring grammar error → `natural_reuse` or `micro_correction`; vocabulary retrieval weakness → `repetition` + topic bias; discourse/fluency target → `role_play` or `storytelling` (matching difficulty band). Deterministic mapping in `prioritization.ts`.

---

## 11. Evaluation

### 11.1 Golden fixtures (fixtures/*.json)

Each fixture: seeded learner state (skills, errors, goals) + a batch of observations → asserted engine outcomes:

| Fixture | Asserts |
| --- | --- |
| `past-tense-recurring.json` | past_tense selected as target after 3 high-confidence errors; difficulty unchanged |
| `article-isolated.json` | single low-confidence article error does NOT create recurring pattern, does NOT become a target |
| `mastery-detection.json` | skill with sustained correct observations crosses 0.8 mastery → retired from targets, trend = improving |
| `difficulty-adjustment.json` | 5-session score series 0.48→0.86 ⇒ difficulty rises by ≤ 0.05/session and caps at 0.95; declining series ⇒ floor 0.15 |
| `priority-ranking.json` | with two goal-aligned recurring weaknesses, top-2 selection matches expected order; goal_relevance term demonstrably breaks the tie |
| `decay.json` | error unseen 90 days has effectiveFrequency < 1 and is retired |

### 11.2 Synthetic learners (architecture.md §42)

Three seeded profiles (A: strong vocab/weak grammar, B: strong grammar/weak fluency, C: weak vocabulary retrieval) run through 10 simulated sessions of fixture observations. Assert: correct targets selected per profile, no overreaction to isolated errors, mastered skills stop being targeted.

### 11.3 E2E (mock provider)

Scripted mock dialogue (learner with injected past-tense errors across a fixture session) → full pipeline: session → utterances → analysis → engine → memory → plan. Assert next session's `LearnerContext` contains the expected targets and corrected difficulty.

### 11.4 API tests

`fastify.inject`: session lifecycle, invalid transition rejection, job idempotency (double `end` → single analysis), learner endpoints.

LLM output quality (prompt tuning, correction feel) is out of scope for automated tests — noted for manual review once a key exists.

---

## 12. Prompts (packages/prompts, versioned files + loader)

```
prompts/
├── conversation/v1.txt    base coach prompt (architecture.md §20, rules 1-13) + slots
├── analysis/v1.txt        diagnostician prompt (design.md §16) + "Return SessionAnalysis JSON"
├── planning/v1.txt        planner prompt (design.md §17) + topic generation (architecture.md §31)
└── memory/v1.txt          conservative memory-update rules (design.md §18)
```

Loader tracks `prompt_name, version, model, temperature, schema_version` in an in-code registry (DB table deferred — single-user, prompts change with code). The analysis prompt demands the exact `SessionAnalysis` JSON schema; the planning prompt returns `{ topic, candidate_skills[], reason }` and nothing else decides targets.

---

## 13. HTTP API (Fastify, localhost)

```
POST   /v1/learners/:id/sessions              create session (loads plan, returns {sessionId})
GET    /v1/sessions/:id                        session state + metrics + transcript
POST   /v1/sessions/:id/end                    end session → analysis pipeline
GET    /v1/learners/:id                        profile + level + confidence
GET    /v1/learners/:id/skills                 skill states + trends
GET    /v1/learners/:id/goals                  list goals
POST   /v1/learners/:id/goals                  add goal
PATCH  /v1/learners/:id/goals/:goalId          update (priority / status / description)
GET    /v1/learners/:id/learning-plan          active plan
GET    /v1/learners/:id/progress               level history, per-dimension scores
                                              (last 10 sessions) + trends   [phase 6]
POST   /v1/internal/sessions/:id/analyze       manual retry of failed analysis
```

WebSocket: `/ws/session/:sessionId` (protocol §8.1).

---

## 14. Web client (Vite + React)

Three views, react-router, single-page shell:

| View | Contents |
| --- | --- |
| **Session** | mic button (start/stop), live transcript (auto-scroll), state banner (WARMUP / CONVERSATION / MICRO_COACH / CHALLENGE…), intervention toasts, session timer, End Session |
| **Dashboard** | estimated level + confidence + evidence counts (design.md §31); skill cards (mastery bar, trend arrow, observation count); recurring errors list (pattern, frequency, last seen, mastery); last-10-sessions score table with per-dimension deltas; active learning plan (targets, topic, intervention) |
| **Goals** | list/add/edit/prioritize goals; complete-goal action |

Audio client: `audio/pcm.ts` (worklet capture + playback ring buffer), `audio/wsClient.ts` (typed WS, reconnect with backoff, sequence tracking for gap detection).

No backend state in the SPA beyond what the API/WS provides.

---

## 15. Milestones

| # | Milestone | Exit criteria |
| --- | --- | --- |
| M1 | Scaffold: pnpm workspace, tsconfigs, domain package (types, Zod schemas, skill codes), DB schema + migrations + seed, provider interfaces + mock provider skeleton | `drizzle-kit migrate` clean; domain schema tests green; provider interfaces compile with both implementations |
| M2 | SessionService + state machine + learner/goals/plans endpoints | API tests: create→start→end lifecycle; invalid transitions rejected; idempotent end |
| M3 | RealtimeBridge (mock) + WS protocol + web SessionView | Full mocked session in browser: audio frames flow, transcript renders, interventions shown, utterances persisted |
| M4 | Metrics + analysis worker + jobs runner (mock analysis provider, Zod validation) | `end` → validated `SessionAnalysis` persisted; double-end produces no duplicate work; failed output retried then marked failed |
| M5 | Learning engine + memory writes | All §11.1/§11.2 fixtures pass |
| M6 | Planner + next-session wiring | New session's `LearnerContext` reflects previous session's engine decisions (targets, difficulty) |
| M7 | Dashboard + Goals views + progress endpoint | §31 longitudinal view renders real data from ≥3 sessions |
| M8 | Real OpenAI provider + key wiring (env `OPENAI_API_KEY`) + model ID pinning | Provider tests green against live API; mock remains default when no key; README documents key setup |

M1–M7 run entirely keyless (mock provider). M8 is a seam, not a rewrite.

---

## 16. Open items (resolved during implementation, not blockers)

1. **Model IDs** — pin current Realtime + Responses model names from official OpenAI docs at M8 (docs' `gpt-realtime-2.1` unverified).
2. **Realtime event names** — `realtime/events.ts` written against current Realtime API docs; protocol translation isolates any mismatch.
3. **Latency tuning** — PCM frame size, audio buffer sizing tuned during M3 against the real provider.
4. **CEFR estimation** — v1 shows `estimated_level` as a free-form string updated by the planner from the overall score bands (0.40–0.54 → B1, 0.55–0.69 → B1+/B2, 0.70+ → B2+/C1); no classifier (non-goal).
