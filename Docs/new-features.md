# EnglishCoach — Technical Implementation Specification

**Version:** 1.0  
**Date:** 2026-10-19  
**Status:** Proposed implementation plan  
**Audience:** AI coding agents, software engineers, technical reviewers  
**Primary source:** Existing `features.md` inventory supplied with this project.  

> **Implementation rule:** Treat the existing code as the source of truth for current behavior. This document describes target behavior and proposed additions. Do not claim a feature is implemented until code, tests, and acceptance criteria demonstrate it. Inspect the repository before changing it; preserve existing conventions unless this specification explicitly requires a change.

## 1. Purpose

Evolve EnglishCoach from a real-time AI speaking application into a reliable, personalized English-learning system. Conversation remains a core activity, while every supported activity contributes evidence to a shared learner model. The application should turn learner performance into useful feedback, targeted review, and a justified next activity.

The implementation must prioritize correctness and a complete learning loop before adding a large number of new learning modes.

### 1.1 Product outcomes

1. Learners can complete a speaking session and reliably retrieve its transcript, analysis, feedback, and next steps.
2. Learning evidence persists across sessions and supports explainable personalization.
3. Vocabulary and recurring language errors can be reviewed over time.
4. Recommendations use learner goals, current objectives, skill evidence, due reviews, and recent performance.
5. Missing evidence is represented as unknown/not assessed, not silently converted into a zero or an invented score.
6. Hosted and local providers have explicit capability contracts and graceful degradation behavior.
7. The system is testable, observable, privacy-aware, and safe to extend.

## 2. Current baseline and known gaps

The supplied feature inventory describes a pnpm monorepo using Node 20–22, Fastify 5, React 18, Vite, SQLite, a job runner, and packages for domain logic, database access, learning engine, provider integration, and prompts. It documents a mock provider, OpenAI Realtime provider, and local speech pipeline using faster-whisper plus Piper or Kokoro. The current seeded learner is `learner-1`; authentication is absent.

The current implementation includes live conversation, a dashboard, flat goals, a session state machine, post-session analysis and planning jobs, 20 skill codes, and deterministic learning-engine functions.

The inventory also identifies these defects or gaps that should be verified against the current branch before implementation:

- `GET /v1/sessions/:id` returns null scores, analysis, and metrics instead of persisted results.
- The web client does not call the session end endpoint and does not reconnect WebSockets.
- Session ending may leave the live bridge/provider running.
- Analysis failure can leave a session in `ANALYZING` without a proper final disposition.
- Difficulty planning may select the oldest rather than newest five sessions.
- A missing learning plan is treated as a dashboard error rather than an empty state.
- Local mode does not emit the tool calls used for live micro-coaching and target retry.
- Pronunciation is not measured; inferring it from text is invalid.
- Vocabulary review scheduling is not implemented despite a `nextReviewAt` field.
- Recurring-error data has no user-facing retrieval/view.
- There is no onboarding, account system, settings view, full session-history UI, or structured curriculum.

**Before coding:** inspect the current branch and confirm each item. Do not assume the inventory remains perfectly synchronized with the repository.

## 3. Engineering principles

1. **Inspect before editing.** Read the relevant source, tests, database schema, package scripts, and existing architecture notes.
2. **Small, reviewable changes.** Implement one vertical slice at a time; avoid large rewrites.
3. **Preserve contracts.** Update shared types, API schemas, web types, and tests together.
4. **Deterministic core.** Application code owns authorization, state transitions, score aggregation, mastery updates, review scheduling, and persistence. LLMs propose content and interpretations but do not directly mutate authoritative learner state.
5. **Evidence provenance.** Every assessment should identify the activity, evidence, confidence, and rubric/version used.
6. **Idempotency.** Retries must not duplicate session analysis, observations, vocabulary records, or plans.
7. **No fabricated measurement.** Do not produce pronunciation scores without audio-grounded evidence. Do not report unsupported metrics.
8. **Provider parity is explicit.** A provider may have reduced capability, but the product must document and test it.
9. **Privacy by default.** Do not persist raw audio unless required, consented to, and governed by a retention policy.
10. **Test the learning loop.** Tests must prove session → evidence → feedback → learner state → review/next activity, not just individual screens.

## 4. Target architecture

Keep the current monorepo and modular boundaries initially. Do not introduce microservices, Redis, object storage, or WebRTC solely because the product is growing; introduce them only when measured operational needs justify them.

```text
React Web App
  ├─ Home / Speak / Review / Progress / Goals / Settings
  ├─ HTTP API client
  └─ Versioned WebSocket client
          │
Fastify API
  ├─ Authentication + learner authorization
  ├─ Session and activity services
  ├─ WebSocket gateway / realtime bridge
  ├─ Feedback, review, curriculum and progress routes
  └─ Job enqueueing
          │
Application / Domain Packages
  ├─ Domain schemas and state machines
  ├─ Learning engine (deterministic rules)
  ├─ Learner memory/evidence service
  ├─ Assessment and curriculum orchestration
  ├─ Provider contracts and adapters
  └─ Prompt registry + structured output validation
          │
Persistence + Workers
  ├─ SQLite initially; migrations and transactions
  ├─ Jobs: analyze, update learner state, plan next, build review queue
  └─ Idempotency keys, retries, logs, failure disposition
          │
Provider adapters
  ├─ mock
  ├─ hosted realtime / LLM / speech
  └─ local STT + local LLM + local TTS
```

### 4.1 Suggested module responsibilities

- `domain`: stable types, enums, schemas, state transition rules, errors.
- `db`: migrations, repositories, transaction helpers, query definitions.
- `learning-engine`: pure functions for score aggregation, skill updates, priority, difficulty, vocabulary scheduling, and recommendation ranking.
- `openai` (or rename later if it contains generic providers): provider interfaces and adapters. Keep provider-specific details out of domain services.
- `prompts`: versioned prompt templates and structured output contracts.
- `apps/api`: HTTP/WebSocket transport, authentication, application services, worker orchestration.
- `apps/web`: route views, accessible controls, client-side state and API contracts.

Do not split these modules into deployed services in the first implementation unless required by deployment constraints.

## 5. Implementation phases and release gates

### Phase 0 — Stabilize the existing application (P0)

Tasks:
- Verify and fix session end/finalization behavior.
- Return persisted results from the session detail endpoint.
- Fix planner ordering and test with more than five sessions.
- Treat absent learning plans as a valid empty state.
- Ensure worker failures reach a retryable or terminal failure state.
- Clean up provider/bridge resources on completion and failure.
- Add WebSocket reconnect/reattach and visible connection states.
- Add mute controls and align protocol/client/server behavior.
- Separate intervention events from assessment observations.
- Remove or suppress invalid metrics.
- Add structured logs, correlation IDs, and worker failure visibility.

Acceptance criteria:
- A learner can start, speak, end, and reload a session without inconsistent status.
- Session detail returns the stored transcript and available analysis/metrics.
- Repeated end requests do not duplicate jobs or learning records.
- Disconnect and reattach do not create duplicate provider sessions or utterances.
- Analysis failures are visible and do not remain silently stuck forever.
- The dashboard loads for a learner with no plan or prior sessions.
- Tests cover each repaired defect.

### Phase 1 — Complete the session learning loop (P1)

Tasks:
- Add persisted session feedback and a post-session review screen.
- Add corrected sentence records with original sentence, suggested version, explanation, target skill, evidence reference, confidence, and learner action.
- Add recurring-error read API and dashboard section.
- Add normalized vocabulary items and learner-specific vocabulary state.
- Implement a due-review queue and record review attempts.
- Ensure next-activity planning consumes current learning plan, recent evidence, goals, and due reviews.
- Add learner preferences and correction-style settings.
- Represent missing assessment dimensions explicitly as `not_assessed`.

Acceptance criteria:
- Completed sessions show a useful review page after analysis finishes.
- Feedback can be reloaded and is not lost when the user leaves the session screen.
- Vocabulary is deduplicated and can be reviewed in a later session.
- Error patterns have examples, confidence, frequency, and trend where evidence supports them.
- The next activity explains its primary learning objective and selection reason.

### Phase 2 — Structured curriculum and activity engine (P1/P2)

Tasks:
- Introduce learning objectives, curriculum units, activities, and activity attempts.
- Add onboarding and a diagnostic assessment.
- Add focused vocabulary, grammar, and guided-speaking activities.
- Decompose user goals into milestones and measurable objectives.
- Implement activity completion and assessment contracts.
- Add versioned assessment rubrics and an evaluation dataset.

Acceptance criteria:
- A learner can follow a sequence of activities instead of only starting free conversation.
- Each activity has a target objective, input/output modality, difficulty, estimated duration, and success criteria.
- Results from multiple activity types update the same learner model without pretending every task measures every skill.

### Phase 3 — Add learning modalities (P2)

Add listening, reading, writing/revision, dictation, and audio-grounded pronunciation workflows. Each modality must use the same activity and evidence contracts.

Acceptance criteria:
- Each modality has task-specific rubrics and tests.
- Pronunciation scores are unavailable unless the selected pipeline returns suitable audio-derived evidence.
- Provider limitations and missing evidence are visible rather than hidden.

### Phase 4 — Advanced personalization and scale (P3)

Consider curriculum prerequisites, custom learning materials, offline packs, multi-device sync, teacher reporting, and experiments to measure retention. Prioritize only after observing learner usage and outcome data.

## 6. Core domain model

Use existing schema conventions and IDs where appropriate. The following are logical entities; reconcile them with current tables before adding migrations.

### 6.1 Learner profile and preferences

Profile fields:
- `id`
- `nativeLanguage`
- `targetLanguages`
- `selfReportedLevel`
- `estimatedLevel`
- `levelConfidence`
- `createdAt`, `updatedAt`

Preferences should be separated from inferred skill state:
- `preferredSessionMinutes`
- `correctionStyle`
- `preferredFeedbackLanguage`
- `preferredAccent`
- `accessibilityPreferences`
- `availableStudyDays`
- `audioRetentionPreference`

Never use profile preferences as proof of proficiency. Learners must be able to edit them.

### 6.2 Learning objective

```ts
type LearningObjective = {
  id: string;
  learnerId: string;
  goalId?: string;
  title: string;
  description: string;
  skillCodes: string[];
  successCriteria: Record<string, unknown>;
  priority: number; // normalized 0..1
  status: "planned" | "active" | "achieved" | "paused" | "cancelled";
  dueAt?: string;
  createdAt: string;
  updatedAt: string;
};
```

### 6.3 Activity definition and attempt

```ts
type ActivityDefinition = {
  id: string;
  version: number;
  type: "conversation" | "role_play" | "vocabulary_review" | "grammar" |
        "listening" | "reading" | "writing" | "dictation" | "pronunciation";
  title: string;
  objectiveIds: string[];
  targetSkillCodes: string[];
  difficulty: number; // normalized 0..1; not a CEFR level
  estimatedMinutes: number;
  inputModality: string[];
  outputModality: string[];
  rubricVersion?: string;
  successCriteria: Record<string, unknown>;
};

type ActivityAttempt = {
  id: string;
  learnerId: string;
  activityId: string;
  activityVersion: number;
  sessionId?: string;
  status: "planned" | "ready" | "in_progress" | "submitted" |
          "evaluating" | "completed" | "paused" | "abandoned" | "failed";
  startedAt?: string;
  submittedAt?: string;
  completedAt?: string;
  resultId?: string;
};
```

### 6.4 Assessment result and evidence

```ts
type AssessmentDimension = {
  skillCode: string;
  score?: number; // normalized 0..1 only when assessed
  status: "assessed" | "not_assessed" | "insufficient_evidence";
  confidence: number; // 0..1, calibrated and documented
  evidenceIds: string[];
};

type AssessmentResult = {
  id: string;
  learnerId: string;
  activityAttemptId?: string;
  sessionId?: string;
  rubricVersion: string;
  assessor: { kind: "deterministic" | "llm" | "speech_pipeline" | "human"; version: string };
  dimensions: AssessmentDimension[];
  overallScore?: number;
  overallStatus: "assessed" | "partial" | "not_assessed";
  createdAt: string;
};

type SkillEvidence = {
  id: string;
  learnerId: string;
  skillCode: string;
  sourceType: "speaking" | "writing" | "listening" | "reading" | "quiz" |
             "pronunciation" | "self_report";
  sourceId: string;
  result: Record<string, unknown>;
  confidence: number;
  evidenceQuality: number;
  provenance: { kind: "direct" | "inferred" | "model_generated"; version?: string };
  observedAt: string;
};
```

Prefer append-only evidence. Derived mastery and trends may be recomputed from evidence and versioned rules.

### 6.5 Vocabulary and review state

Separate the canonical language item from the learner's mastery state.

Canonical vocabulary item:
- `id`, `lemma`, `surfaceForms`, `partOfSpeech`
- `definitions`, optional learner-language meaning
- `exampleSentences`, `collocations`, `register`, `topicTags`
- optional pronunciation/audio references

Learner vocabulary state:
- `learnerId`, `vocabularyItemId`
- `recognitionMastery`, `recallMastery`, `productionMastery`
- `stability`, `difficulty`, `dueAt`, `lastReviewedAt`
- `reviewCount`, `lapseCount`, `lastRecallRating`, `status`

Review attempt:
- `id`, `learnerId`, `vocabularyItemId`, `promptType`
- `answerOutcome`, `hintUsed`, `responseLatencyMs` when available
- `schedulerVersion`, `scheduledInterval`, `createdAt`

Do not merge distinct meanings of polysemous words. Normalize lemma/phrase identity and preserve source context.

## 7. Learning engine requirements

Keep core algorithms pure and unit-testable under `packages/learning-engine`.

### 7.1 Skill mastery

- Continue using the existing mastery algorithm initially unless evaluation demonstrates a problem.
- Document the meaning of mastery, confidence, and trend separately.
- Confidence must reflect evidence quality, recency, quantity, and consistency; do not increase confidence solely because a session occurred.
- Do not update skills that were not assessed.
- Keep a history or append-only evidence trail for every meaningful update.
- Version algorithms so historical results can be interpreted.

### 7.2 Error pattern lifecycle

Each error pattern should store:
- stable ID and learner ID
- skill/error code and normalized pattern
- first/last observed timestamps
- effective frequency and raw count
- severity/communicative impact
- confidence and supporting evidence IDs
- representative original and corrected examples, subject to retention policy
- status (`active`, `improving`, `retired`)
- retirement reason and timestamp

Use thresholds and decay from the current engine as the baseline, but add tests for recurrence, decay, retirement, and reactivation. Avoid treating one ASR error as a learner grammar error without sufficient confidence.

### 7.3 Difficulty adaptation

- Fix chronological ordering before changing the formula.
- Separate activity difficulty from estimated proficiency.
- Use a bounded adjustment and consider hysteresis to avoid oscillation.
- Do not change difficulty based on one unreliable or very short task.
- Record the reason for each adjustment.

### 7.4 Vocabulary scheduling

Implement a documented scheduler (for example, SM-2/FSRS or a simple interval policy). Do not claim algorithm compatibility unless the implementation follows its specification.

Required behavior:
1. Select due items under a review-time budget.
2. Mix recognition and productive recall.
3. Record correctness and hints.
4. Update the due date deterministically.
5. Reschedule missed items sooner without permanently punishing one lapse.
6. Reuse reviewed items in later activities where suitable.
7. Test new items, correct recall, incorrect recall, repeated lapses, overdue items, time-zone rendering, and algorithm-version changes.

### 7.5 Recommendation selection

Inputs should include:
- active objectives and goal relevance
- current skill evidence and confidence
- recurring errors and communicative impact
- due reviews and forgetting risk
- recent activities/topics to avoid monotonous repetition
- available time, learner preferences, provider capabilities
- prerequisites and target difficulty

The deterministic engine should rank and validate candidates. An LLM may propose candidate activities and explanations, but must not bypass hard constraints or directly write the final plan.

## 8. AI agent and prompt contracts

Use logical agents as modules at first, not necessarily separate processes or multiple LLM calls on every turn.

### 8.1 Responsibilities

- **Session orchestrator:** owns workflow and state transitions.
- **Conversation coach:** conducts natural, level-appropriate conversation.
- **Assessment agent:** evaluates completed tasks against a versioned rubric and supplies evidence references.
- **Feedback agent:** explains selected feedback at the learner's preferred depth/language.
- **Curriculum planner:** proposes objectives, activity sequences, and rationales.
- **Vocabulary curator:** proposes normalized words/phrases, meanings, and examples.
- **Exercise generator:** creates schema-valid activities targeting specified objectives.
- **Speech analysis service:** returns ASR/alignment/pronunciation evidence and uncertainty supported by the provider.
- **Learning engine:** deterministically applies scores, mastery, priority, and scheduling.
- **Learner memory service:** authoritative persistence interface.

### 8.2 Agent rules

Every prompt must define:
- one primary objective and role
- relevant learner context and current activity
- allowed evidence and evidence limitations
- permitted tools and prohibited actions
- output schema and validation rules
- tone, length, correction style, and interruption budget
- uncertainty behavior and conditions to abstain
- prompt version and evaluation cases

Never include the entire learner history by default. Build a compact, relevant context window and apply data minimization.

### 8.3 Tool contracts

Potential tools:
- `get_learner_context`
- `get_due_reviews`
- `get_active_learning_objectives`
- `record_assessment_candidate`
- `request_micro_coaching`
- `request_target_retry`
- `propose_vocabulary_items`
- `propose_next_activity`
- `complete_activity`

For every tool specify JSON schema, authorization, valid workflow states, timeout, idempotency key, error codes, and audit behavior. Do not provide unrestricted SQL or generic database-write tools to an LLM.

### 8.4 Example structured assessment contract

```json
{
  "rubricVersion": "speaking-v1",
  "dimensions": [
    {
      "skillCode": "grammar.past_tense",
      "status": "assessed",
      "score": 0.72,
      "confidence": 0.81,
      "evidence": [
        {
          "utteranceId": "utt_123",
          "span": "Yesterday I go to work",
          "observation": "Past-time reference used with a base-form verb",
          "suggestedCorrection": "Yesterday I went to work"
        }
      ]
    },
    {
      "skillCode": "pronunciation.intelligibility",
      "status": "not_assessed",
      "confidence": 0,
      "evidence": []
    }
  ]
}
```

This is an illustrative schema, not a claim that the example score is calibrated. Validate all outputs with runtime schemas and reject or repair invalid results. Do not allow an LLM to invent utterance IDs or evidence that was not supplied.

## 9. Session state machine and reliability

Keep session lifecycle separate from asynchronous job lifecycle and activity lifecycle.

### 9.1 Session lifecycle

Recommended high-level flow:

`CREATED → STARTING → WARMUP → CONVERSATION → CLOSING → ANALYZING → COMPLETED`

`FAILED` and `CANCELLED` paths must be explicit from applicable nonterminal states. Existing intervention states (`MICRO_COACH`, `TARGET_RETRY`, `CHALLENGE`) can remain if they have valid entry/exit transitions and timeout recovery.

### 9.2 Invariants

- Terminal sessions reject new audio and learner events.
- Ending a session is idempotent.
- A disconnect does not silently finish a session.
- Reattachment is authenticated and prevents concurrent active attachments.
- Job enqueue is idempotent by entity, job type, and relevant version.
- Retried workers do not duplicate derived records.
- Analysis failure records attempts, error class, and final disposition.
- Provider resources are closed on terminal transitions.
- Client-visible states distinguish reconnecting, processing, completed, and failed.
- Stale events are rejected or ignored deterministically.

### 9.3 Job execution

For each job, persist:
- job ID, entity ID, job type, input/version key
- status, attempt count, next attempt time
- created/started/completed timestamps
- last error code and sanitized details
- idempotency key

Retry transient failures with bounded exponential backoff and jitter. Do not retry permanent validation or authorization errors indefinitely. Provide an operational way to inspect and retry failed jobs. If SQLite remains the queue store, use transactions and appropriate indexes; reassess the design if concurrent load exceeds its intended limits.

## 10. API and WebSocket contracts

Preserve current routes where possible and update client/server schemas together. The current endpoint list is documented in the original inventory; the routes below are proposals.

### 10.1 Session API

- `POST /v1/learners/:id/sessions` — create a session and return ID, state, topic/activity, and connection details as appropriate.
- `GET /v1/sessions/:id` — return persisted session metadata, transcript, and available results; do not hardcode null fields.
- `POST /v1/sessions/:id/end` — idempotently request session end and enqueue analysis once.
- `GET /v1/sessions/:id/feedback` — return persisted post-session feedback.

### 10.2 Learning API candidates

- `GET /v1/learners/:id/review-queue`
- `POST /v1/learners/:id/reviews/:itemId/attempts`
- `GET /v1/learners/:id/errors`
- `GET /v1/learners/:id/curriculum`
- `GET /v1/learners/:id/activities/recommended`
- `POST /v1/learners/:id/activities/:activityId/attempts`
- `GET /v1/learners/:id/level-history`
- `GET /v1/learners/:id/learning-summary`

Before adding a route, check whether an existing resource can represent the use case cleanly. Use consistent validation, error schemas, pagination, and authorization.

### 10.3 WebSocket message envelope

Define a versioned, validated envelope. Example only:

```json
{
  "v": 1,
  "eventId": "evt_unique_id",
  "sessionId": "session_id",
  "seq": 42,
  "t": "transcript",
  "serverTime": "2026-10-19T18:00:00.000Z",
  "payload": {
    "speaker": "learner",
    "status": "final",
    "text": "I went to work yesterday",
    "startedAt": "2026-10-19T17:59:58.000Z",
    "endedAt": "2026-10-19T18:00:00.000Z"
  }
}
```

Requirements:
- Explicit sample rate, channel count, sample format, and frame duration for audio.
- Maximum frame size and backpressure behavior.
- Partial/final transcript distinction.
- Unique event IDs, ordering, and duplicate handling.
- Heartbeats and structured recoverable/nonrecoverable errors.
- Authenticated reconnect/reattach rules.
- No speaker inference based on odd/even utterance IDs.
- Reject stale events after terminal session state.

Migrate protocol versions deliberately; do not silently rename fields on one side only.

## 11. Frontend requirements

### 11.1 Navigation target

- **Home / Today:** daily plan, due reviews, continue learning, next recommended activity.
- **Speak:** free conversation, guided conversation, role-play, storytelling, debate, interview.
- **Practice:** vocabulary, grammar, listening, pronunciation, dictation, writing.
- **Lessons:** curriculum and activity sequence.
- **Review:** session feedback, corrected sentences, recurring errors, saved phrases, due vocabulary.
- **Progress:** skill history, evidence-backed trends, learning consistency, goal milestones.
- **Goals:** goal creation, decomposition, priorities, due dates, linked objectives.
- **Settings:** languages, level, correction style, voice, audio devices, accessibility, privacy.

For the first release, Home, Speak, Review, Progress, and Settings are sufficient; other sections can be introduced incrementally.

### 11.2 Session screen

- Display explicit microphone and connection states.
- Provide mute/unmute, end, and recoverable reconnect behavior.
- Distinguish partial and final transcript text.
- Avoid transcript duplication using event IDs/sequence numbers.
- Keep transcript and any session summary available after the session ends.
- Handle microphone denial without crashing the screen.
- Do not show a pronunciation score if the provider cannot measure pronunciation.

### 11.3 Post-session review

Show:
- activity objective and session topic
- two or three supported strengths
- a small number of high-value corrections
- original sentence, suggested version, and concise explanation
- vocabulary/phrases to save and practice
- retry or follow-up activity
- skill changes with confidence/evidence count
- dimensions not assessed reliably
- reason for the next recommendation

### 11.4 UI states

Every data-driven view must handle loading, empty, partial-data, error, retry, and stale-data states. A missing optional plan or history is not a fatal application error. Use accessible labels and keyboard navigation, and test narrow viewports.

## 12. Speech providers and capability matrix

Keep the existing provider interface where feasible, but make capabilities explicit rather than relying on undocumented differences.

Example capability contract:

```ts
type ProviderCapabilities = {
  streamingInput: boolean;
  streamingOutput: boolean;
  transcriptEvents: boolean;
  partialTranscripts: boolean;
  toolCalls: boolean;
  wordTimestamps: boolean;
  audioAlignment: boolean;
  pronunciationEvidence: boolean;
  supportedLanguages: string[];
};
```

For each provider document:
- supported languages and accent coverage
- streaming and interruption behavior
- audio sample rates/formats
- transcript confidence and timestamp support
- tool-call support
- pronunciation/alignment capabilities
- latency, CPU/RAM/GPU needs, and operational cost
- licensing and data handling
- failure modes and fallback behavior

Local mode should use application-side intervention rules when model tool calls are unavailable, where practical. If feature parity is impossible, communicate the limitation in the UI and test it explicitly.

### 12.1 Pronunciation rules

Do not infer pronunciation from transcript text. Only enable the corresponding assessment when the pipeline supports suitable audio-grounded evidence. Potential capabilities include voice activity detection, timestamped ASR, forced alignment, reference-phrase comparison, phoneme-level analysis where supported, stress/rhythm analysis with limitations, and audio quality checks. Do not imply that any one signal alone proves native-like pronunciation or overall speaking proficiency.

## 13. Persistence, migrations, and privacy

Potential additional tables, reconciled with existing schema:
- `learner_preferences`
- `learning_objectives`
- `curriculum_units`
- `activities`
- `activity_attempts`
- `assessment_results`
- `skill_evidence`
- `vocabulary_items`
- `vocabulary_learner_state`
- `review_attempts`
- `error_pattern_examples`
- `learning_plan_items`
- `provider_runs`
- `audit_events`

Migration requirements:
- Add reversible or clearly documented forward migrations following repository conventions.
- Test migrations from both a fresh database and the previous schema.
- Add foreign keys and indexes where supported and useful.
- Use transactions for related state changes.
- Store timestamps consistently in UTC and render local time in the UI.
- Version prompts, rubrics, skill taxonomies, and scheduling algorithms.
- Define data retention/deletion for transcripts and audio separately.
- Avoid raw audio retention by default unless necessary and explicitly consented to.

Security requirements before multi-user release:
- Authentication and per-learner authorization on every HTTP and WebSocket path.
- Never trust a client-provided learner ID without authorization checks.
- Keep provider secrets on the server.
- Validate payloads, rate-limit endpoints, and cap audio/frame sizes.
- Redact credentials and sensitive content from logs.
- Document what each provider receives.
- Provide user-accessible retention and deletion controls.

## 14. Observability and quality evaluation

### 14.1 Operational metrics

- session start/completion/failure rates
- WebSocket reconnects and dropped audio frames
- time to first coach response
- STT/TTS/LLM latency
- analysis/planning job success and retry counts
- cost per completed activity where measurable
- provider error rates and resource usage

### 14.2 Learning metrics

- activity completion and abandonment
- review completion and delayed recall
- repeated error recurrence and improvement
- performance on comparable tasks over time
- target skill use in later contexts
- learner-rated usefulness of feedback

Do not optimize solely for engagement, streaks, speaking time, or model-generated scores. Use comparable tasks and sufficient evidence to measure learning.

### 14.3 Evaluation set

Create a versioned, human-reviewed evaluation dataset covering:
- multiple proficiency levels
- different accents and speech-recognition failure cases
- common learner grammar and vocabulary errors
- acceptable variants that should not be incorrectly corrected
- ambiguous utterances and missing context
- cases where pronunciation must be marked not assessed
- role-play quality and level appropriateness

Evaluate correction accuracy, false-positive correction rate, preservation of intended meaning, assessment agreement, vocabulary extraction, curriculum relevance, schema validity, tool correctness, latency, and failure recovery. Evaluate prompt/provider changes against this set before release.

## 15. Testing strategy

Required test layers:

1. **Unit:** scoring, prioritization, mastery, difficulty, scheduling, state transitions.
2. **Repository:** persistence, transactions, indexes, uniqueness, migrations.
3. **API contract:** request/response schemas, errors, authorization, pagination.
4. **WebSocket:** ordering, reconnect, duplicate delivery, stale events, terminal states.
5. **Worker:** retries, idempotency, crash recovery, partial writes, permanent failures.
6. **Provider contract:** common behavior across mock/local/hosted implementations.
7. **Frontend:** loading, empty, partial, error, microphone denied, mute, reconnect, review.
8. **End-to-end:** session → transcript → analysis → evidence → learner state → review queue → next activity.
9. **AI evaluation:** fixed datasets and regression thresholds for prompts/models.
10. **Accessibility:** keyboard operation, screen-reader labels, focus management, contrast.

Keep existing test conventions. Run the repository's full test command and the relevant focused tests after each change. The supplied inventory says the current suite has 160 passing tests and that Node 22 is required because of `better-sqlite3`; verify this against the current environment.

## 16. Repository workflow for AI coding agents

Use this procedure for every implementation task.

### Step 1 — Inspect

- Read `package.json`, workspace configuration, relevant package scripts, and current tests.
- Read the feature inventory and architecture docs.
- Search for the endpoint, schema, state transition, or algorithm being changed.
- Identify all consumers of shared types and any migration implications.
- Confirm whether the reported defect still exists on the current branch.

### Step 2 — Plan

Before editing, write a short plan containing:
- observed current behavior and file paths
- target behavior
- schema/API/UI changes
- failure and recovery behavior
- tests to add or update
- risks and backwards compatibility

If the requested change conflicts with this specification or existing contracts, explain the conflict before making a broad change.

### Step 3 — Implement a vertical slice

- Update domain types/schema first where appropriate.
- Implement deterministic domain/service logic.
- Add or update persistence and migrations.
- Update API/provider contracts.
- Update UI and user-visible error states.
- Add tests in the same change.
- Avoid unrelated refactoring.

### Step 4 — Verify

- Run focused unit and integration tests.
- Run type checking, linting, and the full test suite using repository scripts.
- Run migration tests where schema changed.
- Review logs and error handling.
- Confirm no unsupported claims or placeholder scores are displayed.
- Summarize modified files, behavior changes, tests run, and remaining limitations.

### Step 5 — Report

The coding agent's final report must include:
- what changed
- important design decisions
- files changed
- database/API/protocol changes
- tests run and exact outcomes
- known limitations
- recommended next task

Never claim tests passed if they were not run. Never claim a provider or feature works without evidence from tests or an actual execution.

## 17. Suggested AI coding-agent task template

Copy this template into the coding agent for each task:

```text
You are implementing the EnglishCoach repository described by
englishcoach-technical-implementation-spec.md and features.md.

Task:
[ONE narrowly scoped task]

Rules:
1. Inspect the current repository and relevant tests before editing.
2. Treat code as the source of truth for current behavior; verify that the reported issue still exists.
3. Follow the technical specification and preserve existing architecture unless a change is justified.
4. Do not implement unrelated features or perform a broad rewrite.
5. Keep domain rules deterministic. LLM outputs must be schema-validated and cannot directly mutate authoritative learner state.
6. Do not invent scores or claim pronunciation assessment without audio-grounded evidence.
7. Update shared types, API contracts, migrations, UI states, and tests together as needed.
8. Ensure retries and repeated requests are idempotent.
9. Run focused tests, type checking, and the repository's full test suite where practical.
10. Do not claim a test passed unless it was executed successfully.

Before coding, provide a concise plan and identify files likely to change. Then implement the task. Finish with changed files, behavior, tests and results, and remaining limitations.
```

## 18. Recommended first backlog

Implement in this order, one independently testable task at a time:

1. Fix session detail results and add endpoint regression tests.
2. Fix session end/finalization and provider cleanup; test repeated end requests.
3. Fix planner recent-session ordering and add a regression test with more than five sessions.
4. Fix dashboard empty-plan behavior.
5. Make analysis failures retryable and observable.
6. Add WebSocket reconnect/reattach and mute controls.
7. Add post-session feedback persistence and review UI.
8. Add recurring-error retrieval and UI.
9. Add normalized vocabulary state, review attempts, and scheduling.
10. Add learner preferences/settings.
11. Add activity/objective contracts and a minimal guided-speaking activity.
12. Add diagnostic onboarding and broader modalities after the core loop is reliable.

## 19. Definition of done

A feature is done only when all applicable criteria are satisfied:

- Learner value and acceptance criteria are documented.
- Domain and API contracts are validated.
- Authorization and data ownership are enforced.
- Loading, empty, error, retry, and accessibility behavior are handled.
- Persistent changes have migrations and migration tests.
- Retries and duplicate events are safe.
- Automated tests cover success and failure paths.
- Logs/metrics make operational failures diagnosable.
- AI output is validated and its evidence/uncertainty represented.
- Privacy and retention implications are documented.
- Documentation and feature status are updated to reflect reality.

## 20. Final architecture rule

**LLMs generate and interpret; the learning engine validates and decides; the learner model remembers; the product explains and measures progress.**

The highest-value next step is not to add many agents. It is to make the existing session pipeline reliable, persist evidence and feedback, and connect each completed session to review and a justified next activity. Once that loop works end to end, add curriculum and new learning modalities through shared activity and assessment contracts.
