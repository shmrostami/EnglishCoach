# Review, vocabulary scheduling and preferences (backlog items 8–10)

**Date:** 2026-10-21
**Spec:** `Docs/new-features.md` §6.1 (preferences), §6.5 (vocabulary state + attempts),
§7.2 (error pattern lifecycle), §7.4 (scheduling), §7.5 (recommendation inputs),
§10.2 (learning API candidates), §11.1 (Review + Settings), §18 items 8–10.
**Baseline:** `main` @ `aa0d34a` — 197 tests green (one RAM-bound sidecar test excepted).

---

## 1. Observed current behavior

| # | Fact | Evidence |
|---|---|---|
| A | `error_patterns` is written, never read | `apps/api/src/workers/analysis.ts` `applyMemory`; no route matched `errors` |
| B | `vocabulary_items` has `nextReviewAt`, written with a placeholder interval | `analysis.ts` — `now + max(1, productionMastery*10) days`; no reader |
| C | No review attempt record exists | no `review_attempts` table |
| D | Learner settings are seeded columns with no edit path | `learners.correction_style`, `preferred_session_minutes`; no PATCH |
| E | `LearnerContext.vocabularyTargets` is hardcoded `[]` | `apps/api/src/workers/context.ts:56` |
| F | Correction style is read from the `learners` row only | `context.ts` — a preference stored elsewhere would be invisible |

## 2. Target behavior

1. `GET /v1/learners/:id/errors` returns each pattern with frequency, decayed effective
   frequency, severity, confidence, first/last seen, a representative correction, and a trend.
   Trend is **`null`** under two sessions of evidence — a single observation is not a
   direction (spec §3 principle 7).
2. `GET /v1/learners/:id/review-queue` returns due words soonest-first within a limit, mixing
   recognition with production. Production is only demanded once some recall exists.
3. `POST /v1/learners/:id/reviews/:word/attempts` persists the attempt append-only, then
   reschedules deterministically from the previous interval (not from wall-clock deltas).
4. `GET`/`PATCH /v1/learners/:id/preferences` store learner choices; an unset field is `null`,
   never a default. Correction style is mirrored onto `learners` so the coach prompt sees it.
5. `LearnerContext.vocabularyTargets` carries the due, not-yet-mastered words.
6. The web app gains a Settings screen and renders recurring errors + the due queue on Review.

## 3. Changes

### 3.1 Learning engine
- `errors.ts` + `errorTrend(perSessionCounts)` — `null` under two points.
- `review.ts` (new) — `SCHEDULER_VERSION = "interval-v1"`, `nextIntervalDays` (correct ×2.5,
  lapse → 1 day, cap 180), `applyReviewOutcome` (hint = partial success), `dueAt`, `isDue`,
  `selectReviewQueue` (budget + recognition/production mix).

### 3.2 Persistence
Appended to `schema.sql`: `learner_preferences` (one row per learner, all settings nullable),
`review_attempts` (append-only, records `scheduler_version`). Drizzle tables + row types.

### 3.3 API
- New `apps/api/src/routes/learning.ts`, registered in `app.ts`.
- `workers/context.ts` fills `vocabularyTargets` and prefers the stored correction style.

### 3.4 Web
- `api/client.ts`: `errors`, `reviewQueue`, `recordReview`, `preferences`, `savePreferences`.
- `views/ReviewSections.tsx` rendered by `ReviewView` in both the empty and populated cases.
- `views/SettingsView.tsx` + `/settings` route and nav link.

## 4. Failure and recovery

| Failure | Behavior |
|---|---|
| Unknown learner | 404 on every new route |
| No patterns / nothing due | empty state copy, not an error |
| Bad attempt outcome | 400; unknown word 404 |
| `preferredSessionMinutes` outside 1–120 | 400 — a setting the app cannot honour is refused |
| Save fails | the UI says so and does **not** print "Saved." |

## 5. Tests

`review.test.ts` (15), `api.test.ts` +3 routes (14 in file), `ReviewSections.test.tsx` (5),
`SettingsView.test.tsx` (4), plus the updated `ReviewView.test.tsx` mock.

## 6. Risks and compatibility

- Additive: two new tables, five routes, two views. Existing routes unchanged.
- The scheduler is documented as an interval policy, **not** SM-2/FSRS (spec §7.4 forbids
  claiming compatibility without following the specification).
- Review is button-driven in the UI: the schedule is real, the practice modality is not yet.
- Session length is stored but not enforced on the session timer.
