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
  /**
   * The learner's audio for the turn just ended, when the provider has it.
   *
   * This is the ONLY route by which audio can reach a pronunciation
   * assessment (spec §12.1): a score needs the samples, not the transcript.
   * A provider that does not retain audio returns null, and the assessment
   * then reports "not assessed" rather than inventing a number.
   */
  takeLearnerAudio?(): { pcm: Buffer; sampleRate: number } | null;
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
 * What a provider can actually evidence.
 *
 * `pronunciationEvidence` says whether the provider has an audio-grounded
 * measurement of its own. It is NOT what decides the score: the acoustic
 * assessment measures the retained samples directly, so a provider's number
 * is never used. The flag is kept because it tells the worker whether the
 * provider is even looking at audio, and because a future provider with a
 * real acoustic pipeline (a phoneme aligner, say) will need to say so.
 *
 * A provider that reads only the transcript declares false, and the worker
 * strips any number it returns (spec §12.1).
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
