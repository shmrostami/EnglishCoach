# Activity contracts, a guided-speaking activity, and diagnostic onboarding (backlog items 11–12)

**Date:** 2026-10-21
**Spec:** `Docs/new-features.md` §6.2 (objective), §6.3 (activity + attempt), §6.4 (assessment
result), §7.5 (recommendation inputs), §10.2 (activity routes), §12.1 (pronunciation),
§18 items 11–12.
**Baseline:** `main` @ `d15df2c` — 224 tests green (one RAM-bound sidecar test excepted).

---

## 1. Observed current behavior

| # | Fact | Evidence |
|---|---|---|
| A | A session is the only unit of work | `sessions` is the only table; there is no objective, activity or attempt |
| B | Nothing guides a session toward a stated objective | `apps/api/src/services/session.ts` takes topic/difficulty from the plan only |
| C | There is no entry placement | `estimateLevel` runs only after a completed session (`workers/analysis.ts`) |
| D | Pronunciation has no evidence path anywhere | no acoustic pipeline; §12.1 forbids inferring it from text |

## 2. Target behavior

1. Objectives exist per learner, linked to a goal, with skill codes and priority.
2. `guided_speaking` activity: a prompt, target skills, and target words taken from the
   learner's own weakest vocabulary — never an invented list. One activity per objective,
   created on demand (idempotent).
3. An attempt is started and later submitted against a session. The transcript comes from the
   DB, not the request, so the caller cannot dictate the score.
4. The result is deterministic: word coverage and speaking time are scored; the activity's own
   target skill and pronunciation are `not_assessed`, and the summary says so in words.
5. A three-question diagnostic places a learner. It is `basis: "self_report"`, confidence ≤ 0.5,
   frequency capped at 7, and it writes `estimatedLevel` but **never** skill mastery.

## 3. Changes

### 3.1 Domain
`ActivityType`, `ActivityStatus`, `LearningObjective`, `Activity`, `AssessmentDimension`,
`ActivityResult`.

### 3.2 Learning engine
- `activity.ts` — `assessGuidedSpeaking`, `selectObjective`, `GUIDED_RUBRIC_VERSION`.
- `diagnostic.ts` — `runDiagnostic`, `DIAGNOSTIC_VERSION`.

### 3.3 Persistence
Appended to `schema.sql`: `learning_objectives`, `activities`, `activity_attempts`,
`diagnostics`. Drizzle tables + row types.

### 3.4 API
`apps/api/src/routes/activities.ts`, registered in `app.ts`: objectives (GET/POST), recommended
activity, start attempt, submit attempt, attempt history, diagnostic (GET/POST).

### 3.5 Web
`api/client.ts` additions; `views/PracticeView.tsx` at `/practice` with a nav link.

## 4. Failure and recovery

| Failure | Behavior |
|---|---|
| No objective | `200` with `activity: null` plus a reason — a valid empty state |
| Repeat submit | 409 `already_submitted` |
| Session not this learner's / unknown | 400 |
| Unknown activity or attempt | 404 |
| Diagnostic answers out of range | 400 with the accepted ranges |
| Copying an activity | same activity returned, not a duplicate |

## 5. Tests

`activity.test.ts` (11), `api.test.ts` +2 groups (16 in file), `PracticeView.test.tsx` (5).

## 6. Risks and compatibility

- Additive: four tables, eight routes, one view. Nothing existing changed shape.
- Only `guided_speaking` exists. There is no curriculum, sequencing, or second activity type.
- The diagnostic adjusts the level estimate but is explicitly not an assessment; skill mastery
  is untouched, so a learner cannot talk their way into a higher mastery number.
- The submit route accepts any of the learner's sessions, not only ones started from the
  activity — the attempt records which session it was scored against.
