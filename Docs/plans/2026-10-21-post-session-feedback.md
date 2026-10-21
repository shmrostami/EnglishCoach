# Post-session feedback persistence + review UI (backlog item 7)

**Date:** 2026-10-21
**Spec:** `Docs/new-features.md` — §10.1 (`GET /v1/sessions/:id/feedback`), §5 Phase 1 tasks
("persisted session feedback and a post-session review screen", "corrected sentence records
with original sentence, suggested version, explanation, target skill, evidence reference,
confidence, and learner action"), §11.1 (Review section), §11.3 (post-session review content),
§11.4 (UI states), §18 item 7.
**Baseline:** `main` @ `79feaaf` — 31 files / 184 tests green on Node 22.

---

## 1. Observed current behavior

| # | Fact | Evidence |
|---|---|---|
| A | Analysis results are persisted, but only as opaque JSON on the session row | `apps/api/src/workers/analysis.ts:78-88` writes `sessions.analysis`; `GET /v1/sessions/:id` returns it as `analysis: unknown` |
| B | There is no correction record of any kind | `packages/db/src/schema.sql` has no feedback/correction table; grep for `corrected` in the spec hits only the one Phase 1 task line |
| C | Nothing renders a completed session | `apps/web/src/App.tsx` has three routes (Session, Dashboard, Goals); `SessionView.tsx:111` clears `sessionId` on `session_ended` and the transcript dies with the view |
| D | Analysis observations carry `actual`/`expected`/`evidence` but no reviewable form | `packages/domain/src/types.ts:28-36`; the mock lexicon fills `actual: "go"`, `expected: "went"` (`packages/openai/src/mock/analysis.ts:17`) |
| E | The next recommendation (topic + reason) lives only on `learning_plans` | `apps/api/src/workers/planner.ts`; readable via `GET /v1/learners/:id/learning-plan` |
| F | Migration path is append-only | `packages/db/src/migrate.ts` — `CREATE TABLE` → `CREATE TABLE IF NOT EXISTS`; a new column on an existing table is not applied |

## 2. Target behavior

1. `GET /v1/sessions/:id/feedback` returns a review document for a completed session:
   the six dimension scores, which dimensions are **not assessed**, up to three supported
   strengths, up to three corrections, vocabulary to save, and the next recommendation with
   its reason. Unknown session → 404. Not-yet-analyzed session → 200 with `feedback: null`
   and the session `state` (a session mid-analysis is a valid state, not an error).
2. Corrections are persisted as rows in `corrected_sentences`, each with original sentence,
   suggested version, explanation, target skill, evidence reference, confidence and learner
   action (`pending` | `accepted` | `dismissed`), and survive leaving the session screen.
3. Corrections are **derived deterministically** from the stored analysis, so a retried
   analysis cannot invent different feedback, and re-running the job does not duplicate rows
   (spec §3 principle 6).
4. A suggested version is only produced when the provider's `actual` string actually occurs in
   the learner's quoted sentence; otherwise `suggested` is `null` and the UI shows the target
   form instead. No correction is fabricated (spec §3 principle 7).
5. An unassessed dimension is labelled "not assessed", never scored 0 (spec §12.1).
6. The web app gains a Review route that renders the above, with loading, empty,
   not-yet-analyzed, failed-analysis and error states.

## 3. Changes

### 3.1 Domain (`packages/domain`)

`types.ts` + `schemas.ts`: `LearnerAction`, `CorrectedSentence`, `SessionFeedback`,
`SessionFeedbackSchema`. `SKILL_CODES` reused; no new skill vocabulary.

### 3.2 Learning engine (`packages/learning-engine/src/feedback.ts`, new)

Pure `deriveFeedback(analysis: SessionAnalysis) → FeedbackDraft`:
- `notAssessed`: score dimensions whose value is `null`.
- `strengths`: `analysis.strengths`, confidence-descending, capped at 3.
- `corrections`: `language_error` observations that carry `actual` **and** `expected`,
  severity-descending then confidence-descending, capped at 3. `suggested` = first-occurrence
  splice of `expected` over `actual` in `evidence`; `null` when `actual` is absent from the
  quote. `explanation` = `Replace "<actual>" with "<expected>" here.`
- `vocabulary`: distinct longest alpha tokens (`[a-zA-Z]{4,}`) from `vocabulary_use` evidence.

### 3.3 Persistence (`packages/db`)

Append one table to `schema.sql` (+ Drizzle table and `CorrectedSentenceRow` in `schema.ts`):

```sql
CREATE TABLE corrected_sentences (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  utterance_id TEXT REFERENCES utterances(id),
  original TEXT NOT NULL,
  suggested TEXT,
  explanation TEXT,
  skill_code TEXT NOT NULL,
  evidence TEXT NOT NULL,
  confidence REAL NOT NULL,
  learner_action TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);
```

### 3.4 API (`apps/api`)

- `apps/api/src/workers/analysis.ts`: after observations are persisted, write correction rows
  once (skip when the session already has any), using `deriveFeedback` on the stripped analysis.
- `apps/api/src/routes/sessions.ts`: `GET /v1/sessions/:id/feedback` composes scores +
  not-assessed + strengths + corrections (with ids and learner action) + vocabulary from the
  stored analysis, and the next recommendation from the active plan.

### 3.5 Web (`apps/web`)

- `api/client.ts`: `feedback(id)` and `Correction`/`SessionFeedback` types.
- `views/ReviewView.tsx`: `/review` (newest completed session) and `/review/:sessionId`.
- `App.tsx`: route under its own `ErrorBoundary` + nav link.
- `SessionView.tsx`: after the session ends, a "Review this session" link to that session's
  review page (the transcript is preserved on the review page too).
- `styles.css`: `ec-review*` classes.

## 4. Failure and recovery

| Failure | Behavior |
|---|---|
| Unknown session id | 404 `{error: "unknown session"}` |
| Session not analyzed yet | 200 `{sessionId, state, feedback: null}`; UI shows "Analysis is still running" and offers a refresh |
| Analysis failed | 200 with `feedback: null`, `state: "FAILED"`; UI shows the failure and does not offer a retry (the retry route remains operator-only, per `Docs/features.md` §10) |
| Corrupt stored analysis JSON | `tryParseJson` → `null` → `feedback: null`; never a 500 |
| Correction row ids missing for an old session | Feedback still renders; actions simply have no target |

## 5. Tests

- `packages/learning-engine/src/feedback.test.ts` — caps, ordering, no-substring → null
  suggestion, null-dimension detection, vocabulary dedupe.
- `apps/api/tests/api.test.ts` — 404, `feedback: null` before analysis, full payload after.
- `apps/api/tests/e2e/pipeline.test.ts` — the analysis job writes correction rows, and running
  the job again adds none.
- `apps/web/src/views/ReviewView.test.tsx` — renders corrections and "not assessed"; renders
  the not-yet-analyzed state without an error.

## 6. Risks and compatibility

- Additive only: new table, new route, new view. `GET /v1/sessions/:id` is unchanged.
- `utterance_id` is nullable and left null: the analysis contract carries evidence **quotes**,
  not utterance ids, and the spec forbids letting a model invent ids (§8).
- Learner-action PATCH is deliberately out of scope: the column exists so the next slice can
  add it without a migration, and it defaults to `pending`.
