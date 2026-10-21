# EnglishCoach — Feature Inventory

**Date:** 2026-10-21
**Source of truth:** the code under `english-coach/`, read directly. Where this disagrees with
`Docs/design.md`, the code wins and the gap is listed in §9.
**Last verified against:** `main` + the Phase 0 stabilization slice
(`Docs/plans/2026-10-20-phase-0-stabilization.md`) and the post-session feedback slice
(`Docs/plans/2026-10-21-post-session-feedback.md`).

---

## 1. What runs

| Piece | Detail |
|---|---|
| Workspace | pnpm monorepo, Node 20–22 (`engines: ">=20 <23"`) |
| `apps/api` | Fastify 5 on `127.0.0.1:3100`; opens SQLite, migrates, seeds, starts the job runner (1 s poll) — `apps/api/src/server.ts` |
| `apps/web` | Vite + React 18 SPA on `127.0.0.1:5173`; proxies `/v1` and `/ws` to the API (same-origin, no CORS) — `apps/web/vite.config.ts` |
| Packages | `domain`, `db`, `learning-engine`, `openai`, `prompts` |
| Auth | none. Single hardcoded learner `learner-1`. |
| Provider default | `mock` in code; `apps/api/.env` currently runs `PROVIDER=local` with `TTS_ENGINE=kokoro` |

The API seeds one learner (`learner-1`: native `fa`, target `en`, target level B2, moderate
correction style, 15-minute sessions) and three active goals on every start, idempotently —
`packages/db/src/seed.ts`.

---

## 2. Web routes

Seven routes, each under its own error boundary (`apps/web/src/App.tsx`).

| Route | File | Capability |
|---|---|---|
| `/` | `apps/web/src/views/SessionView.tsx` | Start speaking → creates a session, opens the WS, requests the mic, streams PCM, plays coach audio. Live transcript (learner/coach bubbles, deduped by `seq`, auto-scroll), state chip, on-air timer, intervention note, connection chip (connecting / connected / reconnecting / disconnected), Mute/Unmute button, End. Mic-denied keeps audio and transcript and shows a note. |
| `/dashboard` | `apps/web/src/views/DashboardView.tsx` | CEFR ladder A2→C1 with "you are here"; estimated level + confidence; next-session plan (topic, primary/secondary target chips, reasoning) or an empty-plan card; skill mastery grouped by family with progress bar, trend, observation count; last-10-sessions table (date, topic, the six dimension scores with "not assessed" for an unmeasured one, overall, overall delta). |
| `/review` | `apps/web/src/views/ReviewView.tsx` | Post-session review of the newest completed session: the six dimension scores ("not assessed" for an unmeasured one), strengths, up to three corrections (original → suggested + explanation), vocabulary to keep, and the next session's topic/targets/reason. Handles loading, no-session, still-analysing and failed-analysis states. |
| `/review/:sessionId` | same | The same review for a named session, so it survives leaving the session screen. |
| `/practice` | `apps/web/src/views/PracticeView.tsx` | One-time placement (three self-ratings), the objectives it seeds, and the recommended guided-speaking activity with its prompt, target skills and words. Empty state when there is no objective. |
| `/settings` | `apps/web/src/views/SettingsView.tsx` | Correction style, session length, feedback language, preferred accent. Unset stays empty rather than showing a default the learner never chose. |
| `/goals` | `apps/web/src/views/GoalsView.tsx` | List goals, add a goal (free-text `type` + description, priority forced to 0.5), mark active goal completed. |

Not present: session history browser, profile/login, and the learner's *action* on a
single correction (accept/dismiss) — the column exists, the UI does not. Recurring errors
and due vocabulary are rendered inside `/review` (`apps/web/src/views/ReviewSections.tsx`).
The live transcript exists only while a session is live; the review shows the analysis, not
the transcript.

---

## 3. Session state machine

`apps/api/src/stateMachine.ts`, enforced by `SessionService.transition`
(`apps/api/src/services/session.ts`).

```
STARTING      → WARMUP | CLOSING | FAILED
WARMUP        → CONVERSATION | CLOSING | FAILED
CONVERSATION  → CONVERSATION | MICRO_COACH | TARGET_RETRY | CHALLENGE | CLOSING | FAILED
MICRO_COACH   → CONVERSATION | TARGET_RETRY | CLOSING | FAILED
TARGET_RETRY  → CONVERSATION | CLOSING | FAILED
CHALLENGE     → CONVERSATION | CLOSING | FAILED
CLOSING       → ANALYZING
ANALYZING     → COMPLETED | FAILED
COMPLETED, FAILED → terminal
```

Driven from `apps/api/src/realtime/bridge.ts`:

| Trigger | Effect |
|---|---|
| First attach | provider `connect`, render `conversation` prompt, send warmup instruction → `WARMUP` |
| `WARMUP_MS` (default 120 s) or first learner transcript | → `CONVERSATION` |
| `SESSION_TARGET_MS` (default 900 s), only if still `CONVERSATION` | → `CHALLENGE`, intervention `discourse.argumentation` |
| provider `tool_call: request_micro_coaching` | → `MICRO_COACH`, records an observation, sends intervention + instruction |
| provider `tool_call: request_target_retry` | → `TARGET_RETRY` |
| next transcript after an intervention | → `CONVERSATION` |
| provider `closed{reason}` | → `FAILED` |
| client `control:end` | → `ANALYZING`, enqueue `analyze` |

A client disconnect does **not** end the session: the bridge and provider stay alive for
re-attach. The web client reconnects with bounded exponential backoff (5 attempts,
500 ms → 8 s) and shows a connection chip.

---

## 4. WebSocket protocol

Handler `apps/api/src/routes/ws-session.ts`; translation `apps/api/src/realtime/bridge.ts`.
Types mirrored in `apps/web/src/types/messages.ts`.

**Client → server**

| Message | Behaviour |
|---|---|
| `{"t":"audio","data":<base64 PCM16 16 kHz>}` | forwarded to the provider unless muted |
| `{"t":"control","action":"start"}` | **ignored** server-side |
| `{"t":"control","action":"mute"\|"unmute"}` | blocks / resumes upstream mic audio |
| `{"t":"control","action":"end"}` | ends the session, → `ANALYZING` |

**Server → client**

| Message | Carries |
|---|---|
| `{"t":"audio","data":<base64>,"sampleRate":n}` | coach PCM16 |
| `{"t":"transcript","speaker":"learner"\|"coach","text","seq","startedAt","endedAt"}` | `seq` from the utterance count |
| `{"t":"state","state":<SessionState>}` | transition |
| `{"t":"intervention","kind":"micro_coach"\|"target_retry"\|"challenge","skill"}` | live intervention |
| `{"t":"session_ended","state":<SessionState>,"reason"?}` | terminal |

Close codes: `4000` a live client is already attached; `4001` the session is not `STARTING`.

Note: `Docs/implementation-spec.md` writes the timestamp fields as `started_at`/`ended_at`;
the code sends camelCase.

---

## 5. HTTP endpoints

All under `apps/api/src/routes/`. Any learner other than `learner-1` returns 404.

| Method | Path | Behaviour |
|---|---|---|
| POST | `/v1/learners/:id/sessions` | Reads the active plan → planned difficulty + topic (fallbacks 0.5 / "Free conversation about your day"), inserts a `STARTING` session. Returns `{sessionId, topic, difficulty, state}`. |
| GET | `/v1/sessions/:id` | Session + transcript + the persisted results: `scores` (rebuilt from the six score columns; an unassessed dimension is `null`), `analysis` (stored JSON) and `metrics` (stored JSON). Malformed stored JSON degrades to `null` — never a 500. |
| POST | `/v1/sessions/:id/end` | Ends once (409 on repeat), → `CLOSING`→`ANALYZING`, computes metrics, enqueues `analyze`, tears down the live bridge and releases the cached provider. |
| POST | `/v1/sessions/:id/analyze` | Re-queues a failed analysis. Resets the existing job row (`UNIQUE(session_id,type)` makes a fresh insert impossible) or enqueues one when there is none. `409` for an already-analyzed session. Returns `{state:"QUEUED", sessionId}`. |
| GET | `/v1/jobs/failed` | Failed jobs, newest first, each with its attempt history (`attempt`, `status`, `errorClass`, `error`, timestamps). |
| GET | `/v1/sessions/:id/feedback` | Persisted post-session feedback: scores, `notAssessed` dimensions, strengths, stored corrections (with `learnerAction`), vocabulary, and the active plan's topic/targets/reason as `next`. A session that is not analysed yet answers `200` with `feedback: null` and its `state`; unknown session is `404`. |
| GET | `/v1/learners/:id/objectives` | Objectives, highest priority first. |
| POST | `/v1/learners/:id/objectives` | Requires `title` + `description`; status `active`. 201 `{id}`. |
| GET | `/v1/learners/:id/activities/recommended` | The guided-speaking activity for the top objective, generated once per objective (asking twice returns the same row). No objective → `200` with `activity: null` and a reason. |
| POST | `/v1/learners/:id/activities/:activityId/attempts` | Starts an attempt (`in_progress`). 201 `{attemptId}`. |
| POST | `/v1/learners/:id/activity-attempts/:attemptId/submit` | Scores the attempt against the session's transcript + metrics. 409 on a repeat, 400 when the session is not this learner's. |
| GET | `/v1/learners/:id/activity-attempts` | Attempt history with its stored result. |
| POST | `/v1/learners/:id/diagnostic` | Three self-ratings → band, difficulty, low confidence, `basis: "self_report"`. Persists and seeds `estimatedLevel`; **never** writes skill mastery. 400 outside 0..1 / 0..7. |
| GET | `/v1/learners/:id/diagnostic` | Latest placement, or `{diagnostic: null}`. |
| GET | `/v1/learners/:id/errors` | Active recurring-error patterns with frequency, decayed `effectiveFrequency`, severity, confidence, first/last seen, a representative correction as `example`, and `trend` — `null` while fewer than two sessions carry evidence. |
| GET | `/v1/learners/:id/review-queue` | Due vocabulary items (`?limit=`, max 50), soonest first, each with its prompt type — recognition, or production once recall exists. |
| POST | `/v1/learners/:id/reviews/:word/attempts` | Records a review attempt (`outcome` required, optional `hintUsed`/`promptType`) and reschedules from it. Unknown word 404, bad outcome 400. |
| GET | `/v1/learners/:id/preferences` | Learner-chosen settings; every field `null` until chosen — never a default posing as a choice. |
| PATCH | `/v1/learners/:id/preferences` | Sets `correctionStyle`, `preferredSessionMinutes` (1–120, else 400), `preferredFeedbackLanguage`, `preferredAccent`. Correction style is mirrored onto the `learners` row so the live coach prompt picks it up. |
| GET | `/v1/learners/:id` | Language profile, target/estimated level + confidence, correction style, preferred minutes. |
| GET | `/v1/learners/:id/skills` | Raw skill rows: code, mastery, confidence, trend, observation count. |
| GET | `/v1/learners/:id/learning-plan` | Newest active plan (targets parsed defensively from JSON). **No plan → `200` with a JSON `null` body**, not a 404 — a learner with no plan is a valid empty state. |
| GET | `/v1/learners/:id/progress` | Last 10 `COMPLETED` sessions, oldest→newest, overall + six dimension scores (`pronunciation` is `null` when not assessed). |
| GET | `/v1/learners/:id/goals` | Goal rows. |
| POST | `/v1/learners/:id/goals` | Requires `type` + `description`; priority 0.5; status `active`. 201 `{id}`. |
| PATCH | `/v1/learners/:id/goals/:goalId` | `priority`, `description`, `status` (completing sets `completedAt`). The UI only sends `status`. |
| WS | `/ws/session/:sessionId` | Attach / re-attach (§4). |

The manual analysis retry is `POST /v1/sessions/:id/analyze`; the older
`POST /v1/internal/sessions/:id/analyze` path named in `Docs/implementation-spec.md` §9/§13
still does not exist.

---

## 6. Post-session pipeline

`apps/api/src/workers/`, driven by `JobRunner` (`jobs.ts`): 1 s poll, 3 attempts,
backoff `min(30 s, 2^attempts · 5 s)`, idempotent enqueue via a unique (session, type) key.

### `analyze` — `workers/analysis.ts`

1. Skip if the session already has analysis.
2. Build transcript + deterministic metrics + learner context; call
   `AnalysisProvider.analyze`.
3. Strip `pronunciation` unless the provider declares `capabilities.pronunciationEvidence`
   (a text-only model has no acoustic evidence — §9 / spec §12.1).
4. Write session scores + weighted overall; set status `COMPLETED` **directly, bypassing the
   state machine**.
5. Update the learner's estimated level and confidence.
6. Apply memory deterministically (no LLM): skill EMA, error patterns (confidence > 0.8),
   error retirement, vocabulary upsert, `nextReviewAt`.
7. Persist analysis observations.
8. Persist `corrected_sentences` rows from `deriveFeedback` (skipped when the session already
   has any, so a retry cannot duplicate them — §3 principle 6).
9. Enqueue `plan_next`.

A job that exhausts its 3 attempts is recorded attempt-by-attempt in `job_attempts`
(with an error class: `validation` / `type` / `provider` / `unknown`), and the session
moves `ANALYZING → FAILED` instead of sitting in `ANALYZING` forever. The operator can
retry with `POST /v1/sessions/:id/analyze`.

### `plan_next` — `workers/planner.ts`

1. Requires analysis.
2. Build ranked candidates from active error patterns ∪ analysis `recommended_targets` ∪
   high-confidence observation skills.
3. Adjust difficulty from recent performance (the **newest** five completed sessions; the
   rows are read oldest→newest so `recentPerformance`'s `slice(-5)` takes the newest).
4. Ask the analysis provider for a topic + reason.
5. **The engine is authoritative**: `selectTargets` picks primary/secondary; the LLM's
   `candidateSkills` are discarded.
6. Write the plan, superseding the previous active one.

### Supporting

| Piece | File | Does |
|---|---|---|
| Metrics | `apps/api/src/metrics.ts` | speaking seconds, word count, WPM, pauses > 800 ms, longest/average pause, utterance count. (`rmsEnergyAvg` was removed — it was always 0.) |
| Learner context | `workers/context.ts` | level, goals, strengths, active weaknesses, difficulty, correction style, last 5 topics, current targets. `vocabularyTargets` is always `[]`. |
| Logger | `apps/api/src/logger.ts` | JSON-line structured logs (one object per line) with a correlation id; `server.listening`, `ws.attach`, `ws.reattach`, `ws.reject`, `job.failed`. |

No LLM-backed goal decomposition exists; goals are flat text rows.

---

## 7. Learning engine

Pure functions, no I/O — `packages/learning-engine/src/`, all exported from `index.ts`.

| Module | Exports | Computes |
|---|---|---|
| `scoring.ts` | `WEIGHTS`, `calculateOverall` | weighted mean over the **assessed** dimensions: fluency .25, grammar .20, vocabulary .20, pronunciation .15, coherence .10, interaction .10. A `null` dimension (not assessed) is excluded and the remaining weights are renormalized; a real `0` keeps its weight. |
| `mastery.ts` | `updateSkill`, `computeTrend`, `trendFromDelta`, `clamp01` | EMA (α .25 for the first 5 observations, then .15), confidence +.05 capped .95, trend from the mean of last-5 halves with a ±.05 threshold |
| `errors.ts` | `upsertErrorInput`, `effectiveFrequency`, `isRecurring`, `shouldRetire` | recurrence counting at confidence ≥ .8, exponential decay with a 30-day half-life, retirement at mastery ≥ .8 or effective frequency < 1 |
| `difficulty.ts` | `adjustDifficulty`, `recentPerformance` | +.05 at ≥ .85, +.02 at ≥ .75, 0 at ≥ .55, else −.05; clamped .15–.95 |
| `prioritization.ts` | `calculatePriority`, `rankCandidates`, `goalRelevanceFor`, `DEFAULT_NO_HISTORY` | six terms: recurrence .25, severity .20, goal relevance .20, communicative impact .15, readiness .10, forgetting risk .10 |
| `activity.ts` | `assessGuidedSpeaking`, `selectObjective`, `GUIDED_RUBRIC_VERSION` | deterministic activity result: word coverage + speaking time scored, the target skill and pronunciation marked `not_assessed` with the reason spelled out |
| `diagnostic.ts` | `runDiagnostic`, `DIAGNOSTIC_VERSION` | self-report placement: band, difficulty, confidence capped at 0.5, `basis: self_report`, frequency capped at a week of daily practice |
| `review.ts` | `nextIntervalDays`, `applyReviewOutcome`, `dueAt`, `isDue`, `selectReviewQueue`, `SCHEDULER_VERSION` | documented interval policy — correct ×2.5, lapse back to 1 day, capped at 180; a hint counts as partial success; queue picks due items within a budget and alternates recognition with production |
| `feedback.ts` | `deriveFeedback` | review shape from a stored analysis: unassessed dimensions, top-3 strengths by confidence, top-3 corrections by severity (a `suggested` sentence only when the wrong form actually occurs in the quoted evidence, else `null`), deduped vocabulary |
| `planning.ts` | `selectTargets`, `chooseIntervention`, `estimateLevel` | drop mastery ≥ .8, take 2 primary + 1 secondary; intervention by family; CEFR banding A2/B1/B1+/B2+/C1 with confidence `clamp(.3 + .05·sessions, .3, .95)` |

**Skill codes** — `packages/domain/src/codes.ts`, 5 families / 20 codes:

- `grammar`: `past_tense`, `present_perfect`, `conditionals`, `articles`, `prepositions`, `word_order`
- `vocabulary`: `breadth`, `precision`, `collocations`, `retrieval`
- `fluency`: `continuity`, `hesitation`, `retrieval_speed`, `self_correction`
- `pronunciation`: `intelligibility`, `stress`, `rhythm`
- `discourse`: `coherence`, `storytelling`, `argumentation`

**Other vocabularies** — observation categories `language_error | strength | vocabulary_use |
fluency_signal`; live interventions `micro_coach | target_retry | challenge`; plan
interventions `natural_reuse | micro_correction | elicitation | role_play | storytelling |
contrast | repetition`.

---

## 8. Provider modes

Seam: `packages/openai/src/providers/types.ts`. Selection: `packages/openai/src/index.ts`.

```ts
SpeechConversationProvider { connect, sendAudio, sendInstruction, close }
ProviderEvent = connected | audio | transcript | tool_call | closed
AnalysisProvider { capabilities: ProviderCapabilities, analyze, plan }
ProviderCapabilities { pronunciationEvidence: boolean }
```

| Capability | `mock` (default) | `openai` | `local` |
|---|---|---|---|
| Learner audio in | ignored (scripted) | OpenAI Realtime | endpoint gate → faster-whisper |
| Learner transcript | scripted demo | Realtime transcription | sidecar STT |
| Coach transcript | scripted | Realtime transcript | local chat LLM |
| Coach audio | 40 ms silent frames | Realtime 24 kHz | Piper 22050 / Kokoro 24000 |
| Tool calls | script-injected | **yes** (2 functions) | **none** |
| Analysis + planning | mock lexicon | real LLM | **mock lexicon** |
| Failure reasons | script finished | `connection_lost_<code>` | `stt_unavailable`, `voice_engine_lost`, `coach_unavailable` |

Local-mode pieces:

- `local/endpoint.ts` — adaptive RMS gate, 300 ms minimum voiced span, 600 ms trailing
  silence, 15 s cap.
- `local/sidecar.ts` — spawn, `ready` handshake, one request / one response, no restart. The
  child's stderr is captured, so a failed startup says *why* (a missing `faster_whisper`,
  a bad model path) instead of only that the handshake never happened.
- `scripts/voice_sidecar.py` — `stt` / `tts` / `ping` / `bye` over JSON lines; Whisper loaded
  eagerly, TTS engine lazily (`TTS_ENGINE=piper|kokoro`).
- `local/speech.ts` — turn serialization, one LLM retry, absolute-deadline audio pacing.

Because local mode emits no tool calls, live micro-coaching and target-retry never fire there;
only the timer-driven challenge does. A TTS failure is non-fatal: the coach's text lands and
the audio is skipped.

---

## 9. Designed but not built

From `Docs/design.md`. Treat as unimplemented unless listed otherwise.

| Design item | Status | Reality |
|---|---|---|
| §24 Pronunciation architecture | **design-only** | Nothing is measured. No phoneme, IPA, accent or acoustic pipeline exists. The `pronunciation` score is now `null` ("not assessed") unless an analysis provider declares `capabilities.pronunciationEvidence` — no current provider does — and the analysis prompt now requires `"pronunciation": null`. The three `pronunciation.*` skill codes still exist but nothing feeds them. |
| §12–13 `UPDATE_MEMORY` / `PLAN_NEXT` states | **not states** | Implemented as jobs, not session states. |
| §18 memory-update prompt | **dead code** | `packages/prompts/prompts/memory/v1.txt` is registered but has zero call sites. Memory writes are deterministic. |
| §21 LLM tool layer | **not implemented** | Design lists seven tools; only `request_micro_coaching` and `request_target_retry` exist, and memory is written by the engine, not the model. |
| §30 session types | **not implemented** | Only traces are `role_play`/`storytelling` as intervention-type values. No rotation. |
| §10 conversation difficulty decomposition | **partial** | One scalar 0–1 adjusted in ±.02/.05 steps; the six-part decomposition is absent. |
| §6 vocabulary memory | **partial** | Schema complete. The worker picks the word with `/[a-zA-Z]{4,}/g` from `vocabulary_use` evidence, only ever updates `productionMastery`; recognition stays 0.3, collocation 0, exposure 0. |
| §29 priority formula | **implemented** | `prioritization.ts`, exact design weights. |
| §11 adaptive difficulty | **implemented** | `difficulty.ts`; no hysteresis. |
| Spaced vocabulary review | **partial** | Due queue, attempts and rescheduling are implemented (`interval-v1`). The scheduler is a documented interval policy, **not** SM-2 or FSRS. Review is button-driven in the UI, not a spoken or typed recall exercise. |
| Goal decomposition | **not implemented** | Goals are flat text rows. |
| Dashboard recurring errors | **implemented** | `GET /v1/learners/:id/errors` + the Review page section; `trend` stays `null` under two sessions of evidence. |
| Correction accept/dismiss | **partial** | `corrected_sentences.learner_action` exists and defaults to `pending`; no route or control changes it yet. |
| Learning objectives / activity attempts | **partial** | Objectives, one activity type (`guided_speaking`) and attempts exist. No curriculum units, no sequencing, and no other activity type. |
| Diagnostic onboarding | **partial** | A three-question self-report placement exists and is stored. It is not an assessment and does not touch skill mastery. Broader modalities (listening, reading, writing, dictation) are still absent. |
| Level history / per-dimension trends | **not implemented** | `/progress` returns the last 10 sessions only. |
| §25/§32 V2–V4 roadmap | **not implemented** | Personalized curriculum, teacher dashboard, advanced pronunciation. |
| Redis / object storage / audio recordings / WebRTC | **out of scope by design** | Spec §1 non-goals. |

---

## 10. Implemented but unwired, and known defects

**Unwired**

- `POST /v1/sessions/:id/end` — no client call; the web client ends over the WebSocket.
- `POST /v1/sessions/:id/analyze` and `GET /v1/jobs/failed` — no client call yet (they are
  the operator's retry/inspection surface).
- WS `control:start` — sent by the client, ignored by the server.
- Goal `priority` / `description` PATCH — API supports, UI only completes.
- `PlanDraft.candidateSkills` — validated, then discarded.
- `learning_plans.interventionType` — stored and returned, never rendered.
- Unused exports: `computeTrend`, `isRecurring`, `newAccumulator`, `LearningTarget`,
  `resampleSinc`, `RealtimeBridge.detach()`.

**Defects**

- `openai` mode emits zero-duration turns, so WPM reads 0.
- `recordUtterance` finds the previous learner turn by speaker now (the odd/even-sequence
  assumption is gone), but `pauseBeforeMs` is still only used for the per-turn pause metric.
- The web client's reconnect uses a fixed backoff schedule; a session that is gone from the
  server registry (4001/4000) is still retried until the attempt budget runs out.
- `docs`: `Docs/features.html` is a hand-maintained twin of this file and lags it.

---

## 11. Tests

`pnpm test` — 39 files, 241 tests, all passing (vitest). Includes an end-to-end pipeline test
(`apps/api/tests/e2e/pipeline.test.ts`) proving session → utterances → analysis → memory →
plan → next-session targets, and a real-Python sidecar test.

Must run on Node 22: `better-sqlite3` is compiled for Node 22 and Node 24 refuses to load it.
`packages/openai/src/local/voice_sidecar.test.ts` loads Whisper in a real Python child; on a
machine short of free RAM it fails with `mkl_malloc: failed to allocate memory` — an
environment failure, not a code one. Run it on its own when the box is busy.
