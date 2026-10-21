export const LEARNER_ID = "learner-1";

export type SessionState =
  | "STARTING" | "WARMUP" | "CONVERSATION" | "MICRO_COACH"
  | "TARGET_RETRY" | "CHALLENGE" | "CLOSING" | "ANALYZING"
  | "COMPLETED" | "FAILED";

export type Trend = "improving" | "stable" | "declining";

export type InterventionType =
  | "natural_reuse" | "micro_correction" | "elicitation"
  | "role_play" | "storytelling" | "contrast" | "repetition";

export interface SkillState {
  mastery: number;
  confidence: number;
  observationCount: number;
  trend: Trend;
}

export interface Scores {
  fluency: number; grammar: number; vocabulary: number;
  // null = "not assessed". Pronunciation is only measurable from audio-grounded
  // evidence, so a text-only analysis must leave it null (spec §12.1).
  pronunciation: number | null; coherence: number; interaction: number;
}

export interface Observation {
  type: "language_error" | "strength" | "vocabulary_use" | "fluency_signal";
  skill: string;
  evidence: string;
  actual?: string;
  expected?: string;
  severity?: number;
  confidence: number;
}

export interface RecurringError { skill: string; pattern: string; confidence: number; }
export interface SkillEvidence { skill: string; evidence: string; confidence: number; }

export interface SessionAnalysis {
  scores: Scores;
  observations: Observation[];
  recurring_errors: RecurringError[];
  strengths: SkillEvidence[];
  recommended_targets: string[];
}

export interface SessionMetrics {
  speakingSeconds: number;
  userWordCount: number;
  wordsPerMinute: number;
  pauseCount: number;
  avgPauseMs: number;
  longestPauseMs: number;
  utteranceCount: number;
  avgUtteranceWords: number;
}

export interface LearnerContext {
  level: string;
  goals: string[];
  strengths: string[];
  activeWeaknesses: string[];
  vocabularyTargets: string[];
  difficulty: number;
  correctionStyle: string;
  recentTopics: string[];
  currentSessionTargets: string[];
}

export interface LearningTarget {
  skillCode: string;
  reason: string;
  priority: number;
  intervention: InterventionType;
  mastery: number;
  confidence: number;
}

export interface LearnerProfile {
  nativeLanguage: string;
  targetLanguage: string;
  targetLevel: string;
  estimatedLevel: string;
  estimatedLevelConfidence: number;
  correctionStyle: string;
  preferredSessionMinutes: number;
}

export interface SessionRecord {
  id: string;
  state: SessionState;
  topic: string;
  plannedDifficulty: number;
  achievedDifficulty: number;
  startedAt: number;
  endedAt: number | null;
  scores: Scores | null;
  analysis: SessionAnalysis | null;
  metrics: SessionMetrics | null;
}

export interface PlanDraft {
  topic: string;
  candidateSkills: string[];
  reason: string;
}
