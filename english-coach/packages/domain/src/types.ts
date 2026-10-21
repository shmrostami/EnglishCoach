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

/** What the learner did with a correction. Stored so review survives a reload. */
export type LearnerAction = "pending" | "accepted" | "dismissed";

export interface CorrectedSentence {
  id: string;
  original: string;
  /** null when no grounded replacement could be derived — never invented. */
  suggested: string | null;
  explanation: string;
  skill: string;
  /** The learner's own words the correction is drawn from. */
  evidence: string;
  confidence: number;
  learnerAction: LearnerAction;
}

/** The reviewable result of one analysed session (spec §11.3). */
export interface SessionFeedback {
  sessionId: string;
  topic: string;
  startedAt: number;
  scores: Scores;
  /** Dimensions the analysis could not evidence — shown as "not assessed". */
  notAssessed: (keyof Scores)[];
  strengths: SkillEvidence[];
  corrections: CorrectedSentence[];
  vocabulary: string[];
  next: { topic: string | null; targets: string[]; reason: string | null } | null;
}

/** Learner-chosen settings (spec §6.1). A null field means "not set". */
export interface LearnerPreferences {
  correctionStyle: string | null;
  preferredSessionMinutes: number | null;
  preferredFeedbackLanguage: string | null;
  preferredAccent: string | null;
  updatedAt: number | null;
}

/** One recurring error, with the evidence a learner can act on (spec §7.2). */
export interface ErrorPatternView {
  id: string;
  skill: string;
  pattern: string;
  description: string | null;
  frequency: number;
  /** Frequency decayed by age, 30-day half-life — "how bad is it now". */
  effectiveFrequency: number;
  severity: number;
  confidence: number;
  status: string;
  firstSeenAt: number;
  lastSeenAt: number;
  /** null when fewer than two sessions carried evidence — not a trend yet. */
  trend: "improving" | "stable" | "declining" | null;
  example: { original: string; suggested: string | null } | null;
}

export interface ReviewItem {
  word: string;
  promptType: "recognition" | "production";
  recognitionMastery: number;
  productionMastery: number;
  nextReviewAt: number | null;
}

export interface PlanDraft {
  topic: string;
  candidateSkills: string[];
  reason: string;
}
