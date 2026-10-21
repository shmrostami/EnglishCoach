// Same-origin: requests go through the Vite dev proxy (see vite.config.ts),
// which forwards to the API on 127.0.0.1:3100. No hardcoded origin here, so
// the browser never makes a cross-origin request.
const BASE = "";
const LEARNER_ID = "learner-1";

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  // Declare application/json only when a body is actually sent — Fastify
  // rejects a request that claims a JSON body but has an empty one
  // (FST_ERR_CTP_EMPTY_JSON_BODY), which is what the bodyless create-session
  // POST tripped on.
  const headers: Record<string, string> = init?.body != null ? { "Content-Type": "application/json" } : {};
  const res = await fetch(BASE + path, { headers, ...init });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.status === 204 ? (undefined as T) : (res.json() as Promise<T>);
}

export interface SessionDetail {
  id: string;
  state: string;
  topic: string;
  scores: {
    fluency: number; grammar: number; vocabulary: number;
    pronunciation: number | null; coherence: number; interaction: number;
  } | null;
  analysis: unknown | null;
  metrics: Record<string, unknown> | null;
  transcript: { seq: number; speaker: string; text: string }[];
}

export interface Plan {
  id: string;
  difficulty: number;
  primaryTargets: string[];
  secondaryTargets: string[];
  interventionType: string | null;
  topic: string | null;
  reasoning: string | null;
  status: string;
  createdAt: number;
}

export interface Correction {
  id: string;
  original: string;
  suggested: string | null;
  explanation: string;
  skill: string;
  evidence: string;
  confidence: number;
  learnerAction: "pending" | "accepted" | "dismissed";
}

export interface SessionFeedback {
  sessionId: string;
  topic: string;
  startedAt: number;
  scores: Record<string, number | null>;
  notAssessed: string[];
  strengths: { skill: string; evidence: string; confidence: number }[];
  corrections: Correction[];
  vocabulary: string[];
  next: { topic: string | null; targets: string[]; reason: string | null } | null;
}

/** `feedback` is null until the analysis finishes (or if it failed). */
export interface FeedbackResponse {
  sessionId: string;
  state: string;
  feedback: SessionFeedback | null;
}

export interface ErrorPattern {
  id: string;
  skill: string;
  pattern: string;
  description: string | null;
  frequency: number;
  effectiveFrequency: number;
  severity: number;
  confidence: number;
  status: string;
  firstSeenAt: number;
  lastSeenAt: number;
  trend: "improving" | "stable" | "declining" | null;
  example: { original: string; suggested: string | null } | null;
}

export interface ReviewQueueItem {
  word: string;
  promptType: "recognition" | "production";
  recognitionMastery: number;
  productionMastery: number;
  nextReviewAt: number | null;
}

export interface Preferences {
  correctionStyle: string | null;
  preferredSessionMinutes: number | null;
  preferredFeedbackLanguage: string | null;
  preferredAccent: string | null;
  updatedAt: number | null;
}

export interface Objective {
  id: string;
  goalId: string | null;
  title: string;
  description: string;
  skillCodes: string[];
  priority: number;
  status: string;
}

export interface Activity {
  id: string;
  version: number;
  type: string;
  title: string;
  objectiveIds: string[];
  targetSkillCodes: string[];
  difficulty: number;
  estimatedMinutes: number;
  prompt: string | null;
  targetWords: string[];
  rubricVersion: string | null;
  status: string;
}

export interface DiagnosticResult {
  band: string;
  confidence: number;
  difficulty: number;
  focusSkills: string[];
  basis: string;
  rubricVersion: string;
}

export interface LevelHistory {
  sessions: number;
  history: { sessionId: string; startedAt: number; overall: number | null }[];
  trends: Record<string, "improving" | "stable" | "declining" | null>;
  levels: { sessionId: string; startedAt: number; level: string; confidence: number }[];
}

export interface Milestone {
  id: string;
  title: string;
  description: string | null;
  targetSkillCode: string | null;
  targetMastery: number | null;
  status: string;
  dueAt: number | null;
  achievedAt: number | null;
}

export interface PronunciationAssessment {
  rubricVersion: string;
  intelligibility: number | null;
  stress: number | null;
  rhythm: number | null;
  confidence: number;
}

export const api = {
  createSession: () => http<{ sessionId: string; topic: string; difficulty: number; state: string }>(
    `/v1/learners/${LEARNER_ID}/sessions`, { method: "POST" }),
  // Sessions are ended over the WebSocket (`control:end`) so the live bridge is
  // torn down with it. REST POST /end exists for the case where the socket is
  // already gone; the server closes the provider either way.
  session: (id: string) => http<SessionDetail>(`/v1/sessions/${id}`),
  endSession: (id: string) => http<{ state: string }>(`/v1/sessions/${id}/end`, { method: "POST" }),
  retryAnalysis: (id: string) => http<{ state: string; sessionId: string }>(`/v1/sessions/${id}/analyze`, { method: "POST" }),
  feedback: (id: string) => http<FeedbackResponse>(`/v1/sessions/${id}/feedback`),
  pronunciation: (id: string) => http<{ pronunciation: PronunciationAssessment | null }>(`/v1/sessions/${id}/pronunciation`),
  difficultyProfile: (id: string) => http<{ difficulty: Record<string, number> | null }>(`/v1/sessions/${id}/difficulty`),
  setCorrectionAction: (sessionId: string, correctionId: string, learnerAction: "accepted" | "dismissed") =>
    http<{ correctionId: string; learnerAction: string }>(
      `/v1/sessions/${sessionId}/corrections/${correctionId}`,
      { method: "PATCH", body: JSON.stringify({ learnerAction }) }),
  profile: () => http<Record<string, unknown>>(`/v1/learners/${LEARNER_ID}`),
  skills: () => http<Array<Record<string, unknown>>>(`/v1/learners/${LEARNER_ID}/skills`),
  // No active plan is a valid empty state: the server answers 200 with a JSON
  // `null` body, so this resolves to null rather than throwing.
  plan: () => http<Plan | null>(`/v1/learners/${LEARNER_ID}/learning-plan`),
  progress: () => http<Array<Record<string, unknown>>>(`/v1/learners/${LEARNER_ID}/progress`),
  levelHistory: () => http<LevelHistory>(`/v1/learners/${LEARNER_ID}/level-history`),
  milestones: (goalId: string) =>
    http<{ milestones: Milestone[]; suggested: { title: string; targetSkillCode: string; targetMastery: number }[] }>(
      `/v1/learners/${LEARNER_ID}/goals/${goalId}/milestones`),
  addMilestone: (goalId: string, m: { title: string; targetSkillCode?: string; targetMastery?: number }) =>
    http<{ id: string }>(`/v1/learners/${LEARNER_ID}/goals/${goalId}/milestones`,
      { method: "POST", body: JSON.stringify(m) }),
  goals: () => http<Array<Record<string, unknown>>>(`/v1/learners/${LEARNER_ID}/goals`),
  addGoal: (g: { type: string; description: string; priority?: number }) =>
    http<{ id: string }>(`/v1/learners/${LEARNER_ID}/goals`, { method: "POST", body: JSON.stringify(g) }),
  patchGoal: (id: string, patch: Record<string, unknown>) =>
    http<{ ok: boolean }>(`/v1/learners/${LEARNER_ID}/goals/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  errors: () => http<{ patterns: ErrorPattern[]; generatedAt: number }>(`/v1/learners/${LEARNER_ID}/errors`),
  reviewQueue: (limit = 10) =>
    http<ReviewQueueItem[]>(`/v1/learners/${LEARNER_ID}/review-queue?limit=${limit}`),
  recordReview: (word: string, body: { outcome: "correct" | "incorrect"; hintUsed?: boolean; promptType?: string }) =>
    http<{ word: string; intervalDays: number; nextReviewAt: number; schedulerVersion: string }>(
      `/v1/learners/${LEARNER_ID}/reviews/${encodeURIComponent(word)}/attempts`,
      { method: "POST", body: JSON.stringify(body) }),
  objectives: () => http<Objective[]>(`/v1/learners/${LEARNER_ID}/objectives`),
  addObjective: (o: { title: string; description: string; skillCodes?: string[]; priority?: number }) =>
    http<{ id: string }>(`/v1/learners/${LEARNER_ID}/objectives`, { method: "POST", body: JSON.stringify(o) }),
  recommendedActivity: () =>
    http<{ activity: Activity | null; reason: string }>(`/v1/learners/${LEARNER_ID}/activities/recommended`),
  startAttempt: (activityId: string) =>
    http<{ attemptId: string; status: string }>(
      `/v1/learners/${LEARNER_ID}/activities/${activityId}/attempts`, { method: "POST" }),
  submitAttempt: (attemptId: string, sessionId: string) =>
    http<{ attemptId: string; status: string; result: { summary: string; dimensions: { skillCode: string; score: number | null; status: string }[] } }>(
      `/v1/learners/${LEARNER_ID}/activity-attempts/${attemptId}/submit`,
      { method: "POST", body: JSON.stringify({ sessionId }) }),
  diagnostic: () => http<{ diagnostic: DiagnosticResult | null }>(`/v1/learners/${LEARNER_ID}/diagnostic`),
  runDiagnostic: (a: { speakingComfort: number; grammarConfidence: number; weeklySpeakingFrequency: number; focusSkills: string[] }) =>
    http<DiagnosticResult>(`/v1/learners/${LEARNER_ID}/diagnostic`, { method: "POST", body: JSON.stringify(a) }),
  preferences: () => http<Preferences>(`/v1/learners/${LEARNER_ID}/preferences`),
  savePreferences: (patch: Partial<Preferences>) =>
    http<{ ok: boolean }>(`/v1/learners/${LEARNER_ID}/preferences`, { method: "PATCH", body: JSON.stringify(patch) }),
};
