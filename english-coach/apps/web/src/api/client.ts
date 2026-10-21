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

export const api = {
  createSession: () => http<{ sessionId: string; topic: string; difficulty: number; state: string }>(
    `/v1/learners/${LEARNER_ID}/sessions`, { method: "POST" }),
  // Sessions are ended over the WebSocket (`control:end`) so the live bridge is
  // torn down with it. REST POST /end exists for the case where the socket is
  // already gone; the server closes the provider either way.
  session: (id: string) => http<SessionDetail>(`/v1/sessions/${id}`),
  endSession: (id: string) => http<{ state: string }>(`/v1/sessions/${id}/end`, { method: "POST" }),
  retryAnalysis: (id: string) => http<{ state: string; sessionId: string }>(`/v1/sessions/${id}/analyze`, { method: "POST" }),
  profile: () => http<Record<string, unknown>>(`/v1/learners/${LEARNER_ID}`),
  skills: () => http<Array<Record<string, unknown>>>(`/v1/learners/${LEARNER_ID}/skills`),
  // No active plan is a valid empty state: the server answers 200 with a JSON
  // `null` body, so this resolves to null rather than throwing.
  plan: () => http<Plan | null>(`/v1/learners/${LEARNER_ID}/learning-plan`),
  progress: () => http<Array<Record<string, unknown>>>(`/v1/learners/${LEARNER_ID}/progress`),
  goals: () => http<Array<Record<string, unknown>>>(`/v1/learners/${LEARNER_ID}/goals`),
  addGoal: (g: { type: string; description: string; priority?: number }) =>
    http<{ id: string }>(`/v1/learners/${LEARNER_ID}/goals`, { method: "POST", body: JSON.stringify(g) }),
  patchGoal: (id: string, patch: Record<string, unknown>) =>
    http<{ ok: boolean }>(`/v1/learners/${LEARNER_ID}/goals/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
};
