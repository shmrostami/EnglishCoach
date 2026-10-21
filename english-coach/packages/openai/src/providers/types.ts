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

/**
 * What a provider can actually evidence. A provider that reads only the
 * transcript cannot support a pronunciation score (spec §12.1), so it
 * declares `pronunciationEvidence: false` and the worker strips any number.
 */
export interface ProviderCapabilities {
  pronunciationEvidence: boolean;
}

export interface AnalysisProvider {
  /** Declared once, by the provider itself. */
  readonly capabilities: ProviderCapabilities;
  analyze(input: AnalysisInput): Promise<SessionAnalysis>;
  plan(input: PlanInput): Promise<PlanDraft>;
}
