Below is an implementation-ready specification for **English Coach v1**. I’m making a few concrete choices rather than leaving the architecture abstract.

One important current-platform change: for a new OpenAI implementation, use **Responses + Conversations** for the asynchronous/analysis side rather than the retired Assistants API; OpenAI says the Assistants API was sunset on August 26, 2026. Prompts can also be versioned and reused across Responses and Realtime sessions. ([OpenAI Platform][1])

# 1. Product definition

**Working name:** `English Coach`

### Primary objective

Improve the learner's spontaneous English speaking ability over repeated sessions.

### Non-objectives

The system is not primarily:

-   a grammar reference
-   a translation tool
-   an English exam
-   a chatbot with an English persona
-   a pronunciation-only application

### Core loop

```text
┌──────────────────────────────────────────────────────────┐
│                    ENGLISH COACH                         │
│                                                          │
│  Speak → Observe → Diagnose → Remember → Adapt → Speak  │
│             ↑                                  │         │
│             └──────── Long-term learner model ─┘         │
└──────────────────────────────────────────────────────────┘
```

---

# 2. Technology stack

I recommend this initial stack:

| Layer                  | Technology                   |
| ---------------------- | ---------------------------- |
| Web client             | Next.js + TypeScript         |
| Voice transport        | WebRTC                       |
| Live conversation      | OpenAI Realtime API          |
| Post-session reasoning | OpenAI Responses API         |
| Backend                | Node.js + TypeScript         |
| API framework          | Fastify                      |
| Database               | PostgreSQL                   |
| ORM                    | Drizzle                      |
| Cache/session state    | Redis                        |
| Background jobs        | BullMQ                       |
| Object storage         | S3-compatible                |
| Authentication         | Your preferred auth provider |
| Observability          | OpenTelemetry                |
| Deployment             | Docker                       |

The current OpenAI pricing page lists `gpt-realtime-2.1` and `gpt-realtime-2.1-mini` for realtime audio, and separate transcription models such as `gpt-transcribe`; that makes a realtime voice layer plus asynchronous analysis a natural architecture. ([OpenAI Platform][2])

---

# 3. Repository structure

```text
english-coach/
│
├── apps/
│   ├── web/
│   │   ├── app/
│   │   ├── components/
│   │   ├── hooks/
│   │   └── lib/
│   │
│   └── api/
│       ├── src/
│       │   ├── routes/
│       │   ├── services/
│       │   ├── agents/
│       │   ├── workers/
│       │   └── server.ts
│       └── package.json
│
├── packages/
│   ├── domain/
│   ├── db/
│   ├── openai/
│   ├── learning-engine/
│   ├── prompts/
│   ├── schemas/
│   └── telemetry/
│
├── migrations/
│
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── learning/
│   └── evaluation/
│
├── docker-compose.yml
├── pnpm-workspace.yaml
└── package.json
```

---

# 4. Domain model

The central domain object is the **Learner**.

```text
Learner
│
├── Profile
│
├── Goals
│
├── Skills
│   ├── Grammar
│   ├── Vocabulary
│   ├── Fluency
│   ├── Pronunciation
│   └── Discourse
│
├── Error Patterns
│
├── Vocabulary
│
├── Learning Plan
│
└── Sessions
    └── Utterances
        └── Observations
```

---

# 5. PostgreSQL schema

## `learners`

```sql
CREATE TABLE learners (
    id UUID PRIMARY KEY,
    native_language VARCHAR(10) NOT NULL,
    target_language VARCHAR(10) NOT NULL DEFAULT 'en',

    target_level VARCHAR(10),
    estimated_level VARCHAR(10),
    estimated_level_confidence NUMERIC(4,3),

    correction_style VARCHAR(30) NOT NULL DEFAULT 'moderate',

    preferred_session_minutes INTEGER NOT NULL DEFAULT 15,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## `learner_goals`

```sql
CREATE TABLE learner_goals (
    id UUID PRIMARY KEY,
    learner_id UUID NOT NULL REFERENCES learners(id),

    type VARCHAR(50) NOT NULL,
    description TEXT NOT NULL,

    priority NUMERIC(4,3) NOT NULL DEFAULT 0.5,

    status VARCHAR(20) NOT NULL DEFAULT 'active',

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);
```

---

# 6. Skill model

A skill is hierarchical.

```text
grammar
├── past_tense
├── present_perfect
├── conditionals
├── articles
└── prepositions

vocabulary
├── breadth
├── precision
├── collocations
└── retrieval

fluency
├── continuity
├── hesitation
├── retrieval_speed
└── self_correction

pronunciation
├── intelligibility
├── stress
├── rhythm
└── phoneme_accuracy

discourse
├── coherence
├── storytelling
├── explanation
└── argumentation
```

### `skills`

```sql
CREATE TABLE skills (
    id UUID PRIMARY KEY,
    learner_id UUID NOT NULL REFERENCES learners(id),

    code VARCHAR(100) NOT NULL,

    mastery NUMERIC(4,3) NOT NULL DEFAULT 0.5,
    confidence NUMERIC(4,3) NOT NULL DEFAULT 0.1,

    trend VARCHAR(20) NOT NULL DEFAULT 'stable',

    observation_count INTEGER NOT NULL DEFAULT 0,

    last_assessed_at TIMESTAMPTZ,
    next_review_at TIMESTAMPTZ,

    UNIQUE (learner_id, code)
);
```

---

# 7. Error memory

```sql
CREATE TABLE error_patterns (
    id UUID PRIMARY KEY,
    learner_id UUID NOT NULL REFERENCES learners(id),

    skill_code VARCHAR(100) NOT NULL,

    pattern VARCHAR(255) NOT NULL,

    description TEXT,

    frequency INTEGER NOT NULL DEFAULT 1,

    severity NUMERIC(4,3) NOT NULL,

    mastery NUMERIC(4,3) NOT NULL DEFAULT 0,

    confidence NUMERIC(4,3) NOT NULL DEFAULT 0.5,

    status VARCHAR(20) NOT NULL DEFAULT 'active',

    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    next_review_at TIMESTAMPTZ
);
```

---

# 8. Vocabulary memory

```sql
CREATE TABLE vocabulary_items (
    id UUID PRIMARY KEY,
    learner_id UUID NOT NULL REFERENCES learners(id),

    word VARCHAR(255) NOT NULL,

    recognition_mastery NUMERIC(4,3) NOT NULL DEFAULT 0,
    production_mastery NUMERIC(4,3) NOT NULL DEFAULT 0,
    collocation_mastery NUMERIC(4,3) NOT NULL DEFAULT 0,

    exposure_count INTEGER NOT NULL DEFAULT 0,
    production_count INTEGER NOT NULL DEFAULT 0,

    last_used_at TIMESTAMPTZ,
    next_review_at TIMESTAMPTZ,

    UNIQUE (learner_id, word)
);
```

---

# 9. Sessions

```sql
CREATE TABLE sessions (
    id UUID PRIMARY KEY,
    learner_id UUID NOT NULL REFERENCES learners(id),

    status VARCHAR(30) NOT NULL,

    topic VARCHAR(255),

    planned_difficulty NUMERIC(4,3),
    achieved_difficulty NUMERIC(4,3),

    duration_seconds INTEGER,

    fluency_score NUMERIC(5,2),
    grammar_score NUMERIC(5,2),
    vocabulary_score NUMERIC(5,2),
    pronunciation_score NUMERIC(5,2),
    coherence_score NUMERIC(5,2),
    interaction_score NUMERIC(5,2),

    overall_score NUMERIC(5,2),

    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ
);
```

---

# 10. Utterances

```sql
CREATE TABLE utterances (
    id UUID PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES sessions(id),

    speaker VARCHAR(20) NOT NULL,

    sequence_number INTEGER NOT NULL,

    text TEXT NOT NULL,

    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,

    duration_ms INTEGER,

    word_count INTEGER,

    pause_before_ms INTEGER,
    pause_after_ms INTEGER,

    confidence NUMERIC(4,3)
);
```

---

# 11. Observations

This table is the bridge between LLM analysis and deterministic learning logic.

```sql
CREATE TABLE observations (
    id UUID PRIMARY KEY,

    session_id UUID NOT NULL REFERENCES sessions(id),
    utterance_id UUID REFERENCES utterances(id),

    type VARCHAR(50) NOT NULL,

    skill_code VARCHAR(100),

    evidence TEXT,

    expected TEXT,
    actual TEXT,

    severity NUMERIC(4,3),

    confidence NUMERIC(4,3),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Example:

```json
{
    "type": "language_error",
    "skill_code": "grammar.past_tense",
    "actual": "Yesterday I go to work.",
    "expected": "Yesterday I went to work.",
    "severity": 0.65,
    "confidence": 0.97
}
```

---

# 12. Learning plans

```sql
CREATE TABLE learning_plans (
    id UUID PRIMARY KEY,

    learner_id UUID NOT NULL REFERENCES learners(id),

    difficulty NUMERIC(4,3) NOT NULL,

    primary_targets JSONB NOT NULL,
    secondary_targets JSONB,

    intervention_type VARCHAR(50),

    topic VARCHAR(255),

    reasoning TEXT,

    status VARCHAR(20) NOT NULL DEFAULT 'active',

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

# 13. Session state machine

Implement this as a deterministic state machine.

```typescript
type SessionState =
    | "STARTING"
    | "WARMUP"
    | "CONVERSATION"
    | "MICRO_COACH"
    | "TARGET_RETRY"
    | "CHALLENGE"
    | "CLOSING"
    | "ANALYZING"
    | "COMPLETED"
    | "FAILED";
```

Transitions:

```typescript
const transitions = {
    STARTING: ["WARMUP", "FAILED"],
    WARMUP: ["CONVERSATION", "FAILED"],
    CONVERSATION: [
        "CONVERSATION",
        "MICRO_COACH",
        "TARGET_RETRY",
        "CHALLENGE",
        "CLOSING",
    ],
    MICRO_COACH: ["CONVERSATION", "TARGET_RETRY"],
    TARGET_RETRY: ["CONVERSATION"],
    CHALLENGE: ["CONVERSATION", "CLOSING"],
    CLOSING: ["ANALYZING"],
    ANALYZING: ["COMPLETED", "FAILED"],
};
```

The LLM can **request** a transition, but the backend validates it.

---

# 14. Session object

```typescript
interface SpeakingSession {
    id: string;
    learnerId: string;

    state: SessionState;

    difficulty: number;

    topic: string;

    primaryTargets: LearningTarget[];

    secondaryTargets: LearningTarget[];

    startedAt: Date;

    metrics: SessionMetrics;
}
```

---

# 15. Learning target

```typescript
interface LearningTarget {
    skillCode: string;

    reason: string;

    priority: number;

    intervention: InterventionType;

    mastery: number;

    confidence: number;
}

type InterventionType =
    | "natural_reuse"
    | "micro_correction"
    | "elicitation"
    | "role_play"
    | "storytelling"
    | "contrast"
    | "repetition";
```

---

# 16. Realtime voice architecture

The browser should **not** send your OpenAI API key.

Use:

```text
Browser
   │
   │ HTTPS
   ▼
Backend
   │
   │ create ephemeral realtime credential
   ▼
OpenAI
   │
   │ WebRTC
   ▼
Browser
```

The browser then establishes the realtime session.

For the voice experience:

```text
Microphone
    ↓
WebRTC
    ↓
Realtime model
    ↓
Audio response
    ↓
Speaker
```

Meanwhile your application records the relevant events/transcript for analysis.

---

# 17. Backend endpoints

I'd expose:

```text
POST /v1/realtime/session
POST /v1/sessions
GET  /v1/sessions/:id
POST /v1/sessions/:id/end

GET  /v1/learners/:id
GET  /v1/learners/:id/skills
GET  /v1/learners/:id/progress

GET  /v1/learners/:id/learning-plan
POST /v1/learners/:id/goals

POST /v1/internal/sessions/:id/analyze
POST /v1/internal/sessions/:id/update-memory
POST /v1/internal/sessions/:id/plan-next
```

---

# 18. Realtime session endpoint

Conceptually:

```typescript
POST / v1 / realtime / session;
```

Input:

```json
{
    "sessionId": "session_123"
}
```

Backend:

```typescript
async function createRealtimeSession(
  sessionId: string,
  userId: string
) {
  const learner = await learnerService.get(userId);

  const plan = await learningEngine.getActivePlan(userId);

  const instructions =
    promptBuilder.buildConversationPrompt({
      learner,
      plan
    });

  return openaiRealtime.createClientSecret({
    instructions,
    ...
  });
}
```

The exact realtime credential/session endpoint should be implemented against the current Realtime API documentation rather than hard-coded from an older SDK version.

---

# 19. Realtime agent context

Don't send the entire learner database to the model.

Create a compact **Learner Context**.

```typescript
interface LearnerContext {
    level: string;

    goals: string[];

    strengths: string[];

    activeWeaknesses: ActiveWeakness[];

    vocabularyTargets: string[];

    difficulty: number;

    correctionStyle: string;

    recentTopics: string[];

    currentSessionTargets: LearningTarget[];
}
```

Example:

```json
{
    "level": "B1+",
    "goals": ["Speak more fluently", "Improve business English"],
    "activeWeaknesses": ["grammar.past_tense", "grammar.articles"],
    "difficulty": 0.61,
    "correctionStyle": "moderate",
    "currentSessionTargets": ["grammar.past_tense", "fluency.continuity"]
}
```

This is much cheaper and more reliable than loading months of history into every realtime session.

---

# 20. Conversation prompt

Store this as a versioned prompt.

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

LEARNER CONTEXT

{{learner_context}}

CURRENT TARGETS

{{targets}}

SESSION DIFFICULTY

{{difficulty}}
```

---

# 21. Don't let the realtime model update permanent memory

This is an important boundary.

The realtime model can produce:

```text
observation:
    "learner struggled with past tense"
```

But it should **not** execute:

```text
UPDATE learner SET past_tense = 0.43
```

Instead:

```text
Realtime
   ↓
Observation
   ↓
Database
   ↓
Post-session Analyzer
   ↓
Learning Engine
   ↓
Memory update
```

---

# 22. Post-session analysis pipeline

When the user ends a session:

```text
POST /sessions/:id/end
             │
             ▼
       Mark session ended
             │
             ▼
       Queue analysis job
             │
             ▼
      ┌───────────────┐
      │ Analysis      │
      │ Worker        │
      └───────┬───────┘
              │
       ┌──────┴───────┐
       ▼              ▼
 Transcript       Audio metrics
       │              │
       └──────┬───────┘
              ▼
       Language Analysis
              │
              ▼
       Diagnostic Model
              │
              ▼
       Learning Engine
              │
              ▼
       Memory Update
              │
              ▼
       Next Learning Plan
```

---

# 23. Analysis output schema

Use structured output.

```typescript
interface SessionAnalysis {
    scores: {
        fluency: number;
        grammar: number;
        vocabulary: number;
        pronunciation: number;
        coherence: number;
        interaction: number;
    };

    observations: Observation[];

    strengths: SkillEvidence[];

    weaknesses: SkillEvidence[];

    recurringErrors: RecurringError[];

    vocabularyObservations: VocabularyObservation[];

    recommendedTargets: string[];
}
```

---

# 24. Example JSON schema

The LLM should return something equivalent to:

```json
{
    "scores": {
        "fluency": 0.71,
        "grammar": 0.64,
        "vocabulary": 0.73,
        "pronunciation": 0.78,
        "coherence": 0.69,
        "interaction": 0.82
    },

    "observations": [
        {
            "type": "language_error",
            "skill": "grammar.past_tense",
            "evidence": "Yesterday I go to work",
            "actual": "go",
            "expected": "went",
            "severity": 0.61,
            "confidence": 0.97
        }
    ],

    "recurring_errors": [
        {
            "skill": "grammar.past_tense",
            "pattern": "present_form_after_past_time_expression",
            "confidence": 0.91
        }
    ],

    "strengths": [
        {
            "skill": "vocabulary.precision",
            "evidence": "...",
            "confidence": 0.82
        }
    ]
}
```

Validate this server-side with Zod.

```typescript
const SessionAnalysisSchema = z.object({
    scores: z.object({
        fluency: z.number().min(0).max(1),
        grammar: z.number().min(0).max(1),
        vocabulary: z.number().min(0).max(1),
        pronunciation: z.number().min(0).max(1),
        coherence: z.number().min(0).max(1),
        interaction: z.number().min(0).max(1),
    }),

    observations: z.array(ObservationSchema),

    recurring_errors: z.array(RecurringErrorSchema),

    strengths: z.array(SkillEvidenceSchema),
});
```

---

# 25. Scoring engine

Keep this **outside the LLM**.

```typescript
const WEIGHTS = {
    fluency: 0.25,
    grammar: 0.2,
    vocabulary: 0.2,
    pronunciation: 0.15,
    coherence: 0.1,
    interaction: 0.1,
};
```

```typescript
function calculateOverall(scores: Scores): number {
    return (
        scores.fluency * 0.25 +
        scores.grammar * 0.2 +
        scores.vocabulary * 0.2 +
        scores.pronunciation * 0.15 +
        scores.coherence * 0.1 +
        scores.interaction * 0.1
    );
}
```

---

# 26. Bayesian-ish confidence model

Don't pretend that an LLM score is precise.

Maintain:

```typescript
interface SkillState {
    mastery: number;
    confidence: number;
    observationCount: number;
}
```

Update:

```typescript
function updateSkill(previous: SkillState, observation: number): SkillState {
    const alpha = previous.observationCount < 5 ? 0.25 : 0.15;

    const mastery = previous.mastery * (1 - alpha) + observation * alpha;

    const confidence = Math.min(0.95, previous.confidence + 0.05);

    return {
        mastery,
        confidence,
        observationCount: previous.observationCount + 1,
    };
}
```

This is intentionally conservative.

---

# 27. Recurring-error algorithm

A single error:

```text
frequency = 1
```

should not create a persistent weakness.

Use:

```typescript
if (observation.confidence > 0.8) {
    error.frequency += 1;
}
```

Then:

```typescript
const recurring = error.frequency >= 3 && error.confidence >= 0.75;
```

But also consider time decay.

For example:

```text
old error
   ↓
no occurrences for 10 sessions
   ↓
frequency weight decreases
```

---

# 28. Error decay

```typescript
function decayError(frequency: number, daysSinceLastSeen: number) {
    const decay = Math.exp(-daysSinceLastSeen / 30);

    return frequency * decay;
}
```

This prevents the system from remembering:

> "You made this mistake six months ago"

forever.

---

# 29. Learning-priority engine

Implement deterministically.

```typescript
function calculatePriority(target: Target): number {
    return (
        0.25 * target.recurrence +
        0.2 * target.severity +
        0.2 * target.goalRelevance +
        0.15 * target.communicativeImpact +
        0.1 * target.readiness +
        0.1 * target.forgettingRisk
    );
}
```

Then:

```typescript
const targets = candidates
    .map((t) => ({
        ...t,
        priority: calculatePriority(t),
    }))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 2);
```

The LLM can propose candidates.

The **learning engine chooses them**.

---

# 30. Adaptive difficulty engine

```typescript
function adjustDifficulty(
    difficulty: number,
    recentPerformance: number
): number {
    if (recentPerformance >= 0.85) return Math.min(0.95, difficulty + 0.05);

    if (recentPerformance >= 0.75) return Math.min(0.95, difficulty + 0.02);

    if (recentPerformance >= 0.55) return difficulty;

    return Math.max(0.15, difficulty - 0.05);
}
```

Then add a constraint:

```text
difficulty change per session <= 0.05
```

This makes the experience stable.

---

# 31. Topic generation

The LLM should generate the **topic**, but the engine determines constraints.

Example:

```json
{
    "difficulty": 0.67,
    "target_skills": ["grammar.past_tense", "fluency.storytelling"],
    "topic_constraints": {
        "abstractness": 0.55,
        "familiarity": 0.65,
        "required_storytelling": true
    }
}
```

The LLM turns that into:

> "Tell me about a difficult decision you made at work."

---

# 32. Learning planner output

```json
{
    "difficulty": 0.66,

    "topic": "A difficult decision at work",

    "primary_targets": ["grammar.past_tense", "fluency.storytelling"],

    "secondary_targets": ["vocabulary.precision"],

    "intervention": "natural_reuse",

    "reason": "Past tense remains a recurring weakness while storytelling is below the learner's target level."
}
```

---

# 33. Tool definitions for the agent

The realtime agent should have very few tools.

```typescript
const tools = [
    {
        name: "request_micro_coaching",
        description: "Request a brief correction/intervention.",
        parameters: {
            type: "object",
            properties: {
                skill: { type: "string" },
                reason: { type: "string" },
            },
            required: ["skill", "reason"],
        },
    },

    {
        name: "request_target_retry",
        description:
            "Ask the system to create another opportunity to practice the target.",
        parameters: {
            type: "object",
            properties: {
                skill: { type: "string" },
            },
            required: ["skill"],
        },
    },
];
```

Notice there is **no**:

```text
update_learner_memory()
```

tool available to the realtime model.

---

# 34. Backend-only tools

The learning workers can use:

```text
get_learner
get_skill_states
get_recent_sessions
get_error_patterns
get_vocabulary
update_skill
upsert_error_pattern
update_vocabulary
create_learning_plan
```

These are trusted backend operations.

---

# 35. Prompt architecture

Don't put every prompt into source code.

Use:

```text
prompts/
│
├── conversation/
│   └── v1.txt
│
├── analysis/
│   └── v1.txt
│
├── diagnosis/
│   └── v1.txt
│
├── planning/
│   └── v1.txt
│
└── memory/
    └── v1.txt
```

Then store:

```text
prompt_name
version
model
temperature
schema_version
created_at
```

OpenAI's current migration guidance explicitly positions versioned prompts as the replacement for the old Assistant configuration model, and notes that the same prompt configuration can be reused across Responses and Realtime. ([OpenAI Platform][1])

---

# 36. Service architecture

```text
api/
│
├── RealtimeService
│
├── SessionService
│
├── LearnerService
│
├── LearningPlanService
│
└── ProgressService


agents/
│
├── ConversationAgent
├── AnalysisAgent
├── DiagnosticAgent
├── PlanningAgent
└── MemoryAgent


learning-engine/
│
├── ScoreEngine
├── MasteryEngine
├── ErrorEngine
├── DifficultyEngine
├── PriorityEngine
└── ProgressEngine
```

---

# 37. Event-driven backend

I strongly recommend events.

```text
session.started
session.utterance.created
session.intervention.created
session.ended
analysis.completed
skills.updated
memory.updated
learning_plan.created
```

Example:

```typescript
interface DomainEvent {
    id: string;
    type: string;
    aggregateId: string;
    timestamp: string;
    payload: unknown;
}
```

This will become extremely useful when you later want:

-   analytics
-   teacher dashboards
-   A/B tests
-   replay
-   debugging
-   model evaluation

---

# 38. Queue architecture

```text
Realtime Session
       │
       ▼
session.ended
       │
       ▼
Redis / BullMQ
       │
       ├── analyze.transcript
       │
       ├── analyze.audio
       │
       ├── update.skills
       │
       └── generate.learning.plan
```

Don't perform all of that synchronously when the user clicks **End**.

---

# 39. Failure handling

Every worker should be idempotent.

For example:

```typescript
await db.transaction(async (tx) => {
    const alreadyProcessed = await tx.analysis.findUnique({
        where: { sessionId },
    });

    if (alreadyProcessed) {
        return;
    }

    // perform analysis
});
```

Otherwise retries can double-count errors and destroy your learner model.

---

# 40. Observability

Track:

```text
session_id
learner_id
model
prompt_version

input_tokens
output_tokens
latency_ms

session_duration

number_of_corrections
number_of_interruptions

analysis_confidence

skill_updates
```

Especially track:

```text
correction_rate
```

because too many corrections will probably make the product unpleasant.

---

# 41. Key product metric

I would **not** optimize first for:

```text
number of corrections
```

Instead:

### Primary metric

**Target skill transfer**

Example:

```text
Session 10:
past_tense mastery = 0.52

Session 15:
past_tense mastery = 0.71
```

### Secondary metrics

```text
Speaking duration
Words/minute
Hesitation rate
Self-correction rate
Error recurrence
Vocabulary production
Conversation completion
Learner retention
```

---

# 42. Evaluation framework

Before deploying the learning engine, create synthetic learner profiles.

### Learner A

```text
B1
Strong vocabulary
Weak grammar
Good fluency
```

### Learner B

```text
B2
Strong grammar
Weak fluency
Frequent hesitation
```

### Learner C

```text
B1
Strong comprehension
Poor vocabulary retrieval
```

Then test:

```text
Does the engine select the correct target?

Does difficulty increase appropriately?

Does it stop targeting mastered skills?

Does it avoid overreacting to isolated errors?
```

This is more important than simply testing whether the LLM produces good English.

---

# 43. Golden evaluation cases

Create fixtures like:

```text
fixtures/
├── past-tense-recurring.json
├── article-isolated.json
├── vocabulary-retrieval.json
├── fluency-improvement.json
├── mastery-detection.json
└── difficulty-adjustment.json
```

Example:

```json
{
    "learner": {
        "past_tense": 0.42
    },

    "observations": [
        {
            "skill": "past_tense",
            "correct": false
        },
        {
            "skill": "past_tense",
            "correct": false
        },
        {
            "skill": "past_tense",
            "correct": true
        }
    ],

    "expected": {
        "target": "past_tense",
        "difficulty_change": 0
    }
}
```

---

# 44. MVP implementation sequence

I would implement it in this order.

### Phase 1 — Voice

```text
Web UI
 ↓
Realtime
 ↓
microphone
 ↓
conversation
 ↓
speaker
```

Goal: **a natural 10-minute conversation.**

---

### Phase 2 — Sessions

Add:

```text
session
utterances
transcript
duration
```

---

### Phase 3 — Analysis

Add:

```text
grammar
vocabulary
fluency
coherence
```

---

### Phase 4 — Learner memory

Add:

```text
skills
errors
vocabulary
goals
```

---

### Phase 5 — Adaptive learning

Add:

```text
learning planner
difficulty
target selection
interventions
```

---

### Phase 6 — Longitudinal progress

Add:

```text
progress
trends
mastery
retention
```

---

# 45. What I would NOT build initially

Avoid:

```text
❌ complex multi-agent framework
❌ vector database
❌ RAG
❌ autonomous agent loops
❌ huge learner memory
❌ elaborate CEFR classifier
❌ teacher dashboard
❌ gamification
❌ dozens of tools
```

You don't need them for the first useful version.

PostgreSQL is enough for the learner memory initially.

---

# 46. Where a vector database eventually fits

Possibly later.

For example:

```text
"Find examples of situations where I previously
made this type of mistake."
```

Then embeddings could retrieve relevant previous utterances.

But **do not use vector search as the primary learner memory**.

Your structured tables should remain authoritative.

---

# 47. Security boundaries

Never expose:

```text
OPENAI_API_KEY
database credentials
internal prompts
learner private memory
```

to the browser.

The browser receives only:

```text
ephemeral realtime credential
session metadata
safe learner context
```

Audio recordings should also have explicit retention policies.

---

# 48. Privacy architecture

Give the learner controls for:

```text
Record audio:        ON/OFF
Store transcripts:   ON/OFF
Store audio:         ON/OFF
Use history for AI:  ON/OFF
Delete history
Export learner data
```

This is especially important because you're potentially storing voice recordings and detailed behavioral/language profiles.

---

# 49. Final architecture

Putting everything together:

```text
                         ┌───────────────────────┐
                         │       WEB APP         │
                         │                       │
                         │ microphone / speaker  │
                         │ session UI            │
                         │ progress UI           │
                         └───────────┬───────────┘
                                     │
                                  WebRTC
                                     │
                                     ▼
                         ┌───────────────────────┐
                         │   REALTIME SERVICE    │
                         │                       │
                         │ Conversation Agent    │
                         └───────────┬───────────┘
                                     │
                         transcript/events
                                     │
                                     ▼
                         ┌───────────────────────┐
                         │    SESSION SERVICE    │
                         └───────────┬───────────┘
                                     │
                               session.ended
                                     │
                                     ▼
                         ┌───────────────────────┐
                         │       JOB QUEUE       │
                         └───────────┬───────────┘
                                     │
             ┌───────────────────────┼───────────────────────┐
             ▼                       ▼                       ▼
     ┌──────────────┐       ┌──────────────┐       ┌──────────────┐
     │Transcript    │       │Audio         │       │Conversation  │
     │Analyzer      │       │Analyzer      │       │Analyzer      │
     └──────┬───────┘       └──────┬───────┘       └──────┬───────┘
            └──────────────────────┼───────────────────────┘
                                   ▼
                         ┌───────────────────────┐
                         │  DIAGNOSTIC AGENT    │
                         │                       │
                         │ structured analysis   │
                         └───────────┬───────────┘
                                     ▼
                         ┌───────────────────────┐
                         │   LEARNING ENGINE    │
                         │                       │
                         │ scoring               │
                         │ mastery               │
                         │ error recurrence      │
                         │ difficulty            │
                         │ prioritization        │
                         └───────────┬───────────┘
                                     ▼
                         ┌───────────────────────┐
                         │    LEARNER MEMORY    │
                         │                       │
                         │ PostgreSQL            │
                         └───────────┬───────────┘
                                     ▼
                         ┌───────────────────────┐
                         │   NEXT PLAN ENGINE   │
                         └───────────┬───────────┘
                                     │
                                     ▼
                              NEXT SESSION
```

## The key architectural rule

I'd formalize the system around this contract:

```text
LLMs produce observations and language.

The learning engine owns learning state.

The database owns persistent truth.

The realtime agent owns conversation.

The planner owns progression.
```

That separation gives you a system that can improve over **hundreds of sessions** without the learner's profile becoming an increasingly unreliable collection of LLM-generated prose.

### Recommended next implementation artifact

The next thing I'd produce is a **v1 code-level contract** consisting of:

1. `schema.ts` — all TypeScript domain types + Zod schemas
2. `schema.sql` / Drizzle schema
3. `realtime-session.ts`
4. `conversation-agent.ts`
5. `session-analyzer.ts`
6. `learning-engine.ts`
7. `memory-manager.ts`
8. `learning-planner.ts`
9. exact OpenAI tool schemas
10. exact versioned prompts
11. REST API OpenAPI specification
12. Docker Compose for PostgreSQL + Redis + API + web
13. an end-to-end `15-minute speaking session` implementation

That would take this from an architecture document to something a developer can start implementing immediately.

[1]: https://platform.openai.com/playground?assistant=asst_MLZgVy7CSjBGoFkwY9RmX9os&mode=assistant&utm_source=chatgpt.com "Assistants migration guide | OpenAI API"
[2]: https://platform.openai.com/pricing?client_id=81433148.1787961602&session_id=1787961602&utm_source=chatgpt.com "Pricing | OpenAI API"
