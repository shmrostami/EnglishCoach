import type { LearnerContext, PlanDraft, SessionAnalysis, SessionMetrics } from "@ec/domain";

export interface TranscriptTurn {
  speaker: "learner" | "coach";
  text: string;
  startedAt: number;
  endedAt: number;
}

/** Normalized events the realtime provider emits. No OpenAI names here. */
export type ProviderEvent =
  | { t: "connected" }
  | { t: "audio"; data: Buffer; sampleRate: number }
  | { t: "transcript"; turn: TranscriptTurn }
  | { t: "tool_call"; name: "request_micro_coaching" | "request_target_retry"; skill: string; reason?: string }
  | { t: "closed"; reason: string };

export interface SpeechConversationProvider {
  connect(onEvent: (e: ProviderEvent) => void): Promise<void>;
  sendAudio(pcm16: Buffer): void;
  sendInstruction(text: string): void;   // warmup / challenge / micro-coach directives
  close(): void;
}

export interface AnalysisInput {
  learnerId: string;
  transcript: TranscriptTurn[];
  metrics: SessionMetrics;
  learnerContext: LearnerContext;
  sessionTargets: string[];
}

export interface PlanInput {
  difficulty: number;
  candidates: string[];   // engine-ranked skill codes
  learnerContext: LearnerContext;
}

export interface AnalysisProvider {
  analyze(input: AnalysisInput): Promise<SessionAnalysis>;
  plan(input: PlanInput): Promise<PlanDraft>;
}
