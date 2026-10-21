# Phase 0 — Stabilize the existing application (P0)

**Date:** 2026-10-20
**Spec:** `Docs/new-features.md` §5 Phase 0, §18 backlog items 1–6, §9, §10, §11, §12.1
**Baseline:** `main` @ `fabde71` — 31 files / 160 tests green on Node 22.

---

## 1. Observed current behavior (verified on this branch)

| # | Defect | Evidence |
|---|---|---|
| A | Session detail hardcodes null results | `apps/api/src/services/session.ts:72` — `scores: null, analysis: null, metrics: null, // filled by Task 7` |
| B | HTTP end orphans the live bridge/provider | `apps/api/src/routes/sessions.ts:24-30` flips the DB row only; `apps/api/src/realtime/bridge.ts:158` `finish()` is the only path that closes the provider |
| C | Provider cache never evicted | `apps/api/src/server.ts:19,60` — `speechProviders` map grows one entry per session, never deleted |
| D | Planner adapts difficulty to the **oldest** five sessions | `apps/api/src/workers/planner.ts:93-98` queries `orderBy(desc(startedAt))` (newest first) but `recentPerformance` (`packages/learning-engine/src/difficulty.ts`) does `.slice(-5)`, i.e. the tail of a newest-first list |
| E | Missing plan is a dashboard *error* | `apps/api/src/routes/learners.ts:29` returns 404; `apps/web/src/api/client.ts` `http()` throws on non-ok; `apps/web/src/views/DashboardView.tsx:66` catches it into `setLoadFailed(true)` |
| F | Failed analysis leaves the session stuck in `ANALYZING` | `apps/api/src/workers/analysis.ts` throws out of the worker; `JobRunner` marks the **job** failed (`apps/api/src/workers/jobs.ts:67`) but nothing transitions the session. `ANALYZING → FAILED` is already a legal edge (`apps/api/src/stateMachine.ts`) |
| G | No way to inspect or retry a failed job | `jobs` table has no attempt history, no error class, no started-at; no read API; `POST /v1/internal/sessions/:id/analyze` is documented but absent |
| H | No structured logs / correlation IDs | `apps/api/src/app.ts:22` — `Fastify({ logger: false })`; no log helper anywhere |
| I | Web client never reconnects; no mute control | `apps/web/src/audio/wsClient.ts` — no reconnect, `WsLike` has no `onopen`; `apps/web/src/views/SessionView.tsx` has no mute button although the server honours `control:mute` (`apps/api/src/realtime/bridge.ts:146`) |
| J | Live interventions and assessment observations share one table | `apps/api/src/services/session.ts:48-54` inserts `micro_coach|target_retry|challenge` into `observations.type`; the analysis worker inserts the four assessment categories into the same column (`apps/api/src/workers/analysis.ts:96`) |
| K | Unsupported metrics are produced and displayed | `rmsEnergyAvg` is hardcoded `0` (`apps/api/src/metrics.ts:40`) yet is a required field of `SessionMetrics`; the mock analysis provider fabricates `pronunciation: 0.78` from transcript text (`packages/openai/src/mock/analysis.ts:85`) and the analysis prompt asks the LLM to infer pronunciation from text (`packages/prompts/prompts/analysis/v1.txt:15,35`) — forbidden by spec §12.1 / §3.7 |
| L | Speaker inferred from utterance parity | `apps/api/src/services/session.ts:34` filters `sequenceNumber % 2 === 1` — forbidden by spec §10.3 |

## 2. Target behavior

1. `GET /v1/sessions/:id` returns the persisted transcript, the six stored scores, the stored
   analysis JSON and the stored metrics. Malformed stored JSON degrades to `null`, never a 500.
2. Ending a session is idempotent from every entry point (WS `control:end` and
   `POST /v1/sessions/:id/end`): the provider and bridge are torn down exactly once, the
   analysis job is enqueued exactly once, and a repeated end returns the current state
   without duplicating jobs or learning records.
3. Difficulty adapts to the **newest** five completed sessions.
4. A learner with no plan sees an empty state, not an error. `GET /v1/learners/:id/learning-plan`
   answers `200` with `null` body when there is no active plan.
5. An analysis that fails three times transitions the session `ANALYZING → FAILED`, records
   every attempt with an error class, and can be retried with one request
   (`POST /v1/sessions/:id/analyze`). Failed jobs are inspectable (`GET /v1/jobs/failed`).
6. The session screen shows an explicit connection state, reconnects with backoff, and has a
   working mute toggle. Re-attaching never opens a second provider session.
7. Live interventions are persisted separately from assessment observations.
8. No unsupported number reaches the learner: `rmsEnergyAvg` is removed; pronunciation is
   `null` ("not assessed") unless the analysis provider declares audio-grounded evidence.

## 3. Changes

### 3.1 Domain / packages

| File | Change |
|---|---|
| `packages/domain/src/types.ts` | `Scores.pronunciation: number \| null`; drop `SessionMetrics.rmsEnergyAvg` |
| `packages/domain/src/schemas.ts` | `pronunciation` nullable in `ScoresSchema`; drop `rmsEnergyAvg` from `SessionMetricsSchema` |
| `packages/learning-engine/src/scoring.ts` | `calculateOverall` weights only the assessed dimensions and renormalizes |
| `packages/openai/src/providers/types.ts` | `AnalysisProvider.capabilities: { pronunciationEvidence: boolean }`; add `ProviderCapabilities` (spec §12 example) |
| `packages/openai/src/mock/analysis.ts` | emit `pronunciation: null`; declare `pronunciationEvidence: false` |
| `packages/openai/src/openai/analysis.ts` | declare `pronunciationEvidence: false` (an LLM reading text has no audio evidence) |
| `packages/prompts/prompts/analysis/v1.txt` | stop requesting pronunciation from text; require `"pronunciation": null` |
| `packages/db/src/schema.sql` | append `interventions` and `job_attempts` tables (additive only — `packages/db/src/migrate.ts` can only run `CREATE TABLE IF NOT EXISTS`) |
| `packages/db/src/schema.ts` | Drizzle tables + row types for the two new tables |

### 3.2 API

| File | Change |
|---|---|
| `apps/api/src/services/session.ts` | `getRecord` returns persisted results; `recordIntervention` writes to `interventions`; `recordUtterance` stops inferring the speaker by parity; new `failSession` |
| `apps/api/src/routes/sessions.ts` | end route tears down the bridge + releases the provider; `POST /v1/sessions/:id/analyze` (retry); `GET /v1/jobs/failed` |
| `apps/api/src/routes/learners.ts` | `learning-plan` → `200 null` when absent; `progress` reports `pronunciation: null` |
| `apps/api/src/workers/analysis.ts` | force `pronunciation: null` unless the provider declares evidence; use the guarded JSON parser |
| `apps/api/src/workers/planner.ts` | order completed sessions oldest→newest before `recentPerformance` |
| `apps/api/src/workers/jobs.ts` | record each attempt (`job_attempts`), classify the error, expose an `onFailed` hook |
| `apps/api/src/logger.ts` *(new)* | JSON-line structured logger with a correlation id |
| `apps/api/src/app.ts` / `server.ts` | wire the logger, the failure hook, the provider release; evict the provider cache |

### 3.3 Web

| File | Change |
|---|---|
| `apps/web/src/api/client.ts` | `plan()` → `Plan \| null`; `session(id)`; `endSession(id)`; `retryAnalysis(id)` |
| `apps/web/src/audio/wsClient.ts` | reconnect with bounded backoff, `onopen`, connection-state callback |
| `apps/web/src/types/messages.ts` | connection states |
| `apps/web/src/views/SessionView.tsx` | connection chip, mute toggle, transcript restored from the server on reload |
| `apps/web/src/views/DashboardView.tsx` | empty-plan card, "not assessed" for pronunciation |

### 3.4 No new tables in this slice beyond `interventions` and `job_attempts`

`learner_preferences`, `session_feedback`, `vocabulary_state` and `review_attempts` belong to
Phase 1 (backlog items 7–10) and are not created here.

## 4. Failure and recovery

| Failure | Behavior |
|---|---|
| Malformed `sessions.analysis` / `sessions.metrics` | parsed defensively → `null`; the endpoint still answers `200` |
| Analysis provider throws | job retried (3 attempts, backoff `min(30 s, 2^n·5 s)`); the third failure transitions the session to `FAILED`, records the attempt + error class, and logs it |
| Analysis output fails schema validation | same path — no learner state written (the existing "invalid provider output" test keeps asserting learner state is untouched) |
| Operator wants to retry | `POST /v1/sessions/:id/analyze` re-enqueues; the worker is idempotent (`session.analysis` short-circuit) so a retry after a partial write is a no-op |
| WebSocket drops | the client retries with backoff and shows `reconnecting`; the server keeps the bridge and provider alive, so a re-attach does not open a second provider session |
| Provider dies mid-session | bridge marks the session `FAILED`, closes the provider, sends `session_ended` — unchanged |
| No active learning plan | `200 null`; the dashboard renders an empty state |

## 5. Tests

New / updated (all under `pnpm test`, Node 22):

- `apps/api/tests/api.test.ts` — session detail returns the persisted scores/analysis/metrics;
  repeated end does not duplicate the queued job; learning-plan answers `200 null`;
  `GET /v1/jobs/failed` lists a failed job; `POST /v1/sessions/:id/analyze` re-enqueues.
- `apps/api/tests/worker.test.ts` — planner ordering with **7** completed sessions (only the
  newest five may drive difficulty); analysis failure → session `FAILED` + attempt row;
  `pronunciation` is `null` unless the provider declares evidence.
- `apps/api/tests/bridge.test.ts` — an intervention is written to `interventions`, not to
  `observations`; the provider is closed when the session ends over HTTP.
- `apps/web/src/audio/wsClient.test.ts` — reconnect after an unexpected close, connection state.
- `apps/web/src/views/DashboardView.test.tsx` — empty plan renders an empty state, not an error.
- `packages/learning-engine/src/scoring.test.ts` — overall renormalizes over assessed dimensions.
- `packages/domain/src/schemas.test.ts` — `pronunciation: null` is valid; `rmsEnergyAvg` is gone.

## 6. Risks and backwards compatibility

- **Score shape change.** `pronunciation` becomes nullable. Every consumer that reads it must
  handle `null` (dashboard, `/progress`, session detail). The `sessions.pronunciation_score`
  column stays, so the DB shape is unchanged.
- **Overall score shifts.** With pronunciation excluded, `calculateOverall` renormalizes over
  five dimensions, so historical `overall_score` values are not comparable with new ones.
  The `/progress` endpoint keeps returning the stored value, so past rows are unaffected.
- **Analysis prompt change.** The LLM is told to return `pronunciation: null`. A provider that
  still returns a number is stripped by the worker unless it declares `pronunciationEvidence`.
- **New tables are additive.** `migrate()` only supports `CREATE TABLE IF NOT EXISTS`, so the
  two new tables are appended to `schema.sql`; no existing table changes shape and no data
  migration is needed.
- **`observations.type` no longer holds intervention kinds.** Nothing reads that table today,
  so no consumer breaks; the live-intervention rows now live in `interventions`.
- **WebSocket protocol.** The client/server message types are unchanged; the client gains
  reconnect behavior and a `connection` state message that the server does not need to send —
  the connection state is derived client-side.
