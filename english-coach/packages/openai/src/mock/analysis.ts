import type { LearnerContext, PlanDraft, SessionAnalysis, SessionMetrics } from "@ec/domain";
import type { AnalysisInput, AnalysisProvider, TranscriptTurn } from "../providers/types.js";

type LexiconEntry = {
  match: (text: string) => boolean;
  skill: string;
  pattern: string;
  actual: string;
  expected: string;
  severity: number;
  confidence: number;
};

const LEXICON: LexiconEntry[] = [
  { match: (t) => /yesterday i go\b/i.test(t) || /\bi go to (work|home)\b/i.test(t) && /yesterday/i.test(t),
    skill: "grammar.past_tense", pattern: "present_form_after_past_time_expression",
    actual: "go", expected: "went", severity: 0.65, confidence: 0.97 },
  { match: (t) => /\bsince (five|three|two|ten) years\b/i.test(t),
    skill: "grammar.present_perfect", pattern: "present_with_since_duration",
    actual: "I go there since five years", expected: "I have been there for five years",
    severity: 0.6, confidence: 0.9 },
  { match: (t) => /\bto hospital\b(?! (a|the))\b/i.test(t) || /\ba hospital\b/i.test(t),
    skill: "grammar.articles", pattern: "missing_or_wrong_article_place",
    actual: "to hospital", expected: "to the hospital",
    severity: 0.4, confidence: 0.92 },
];

export class MockAnalysisProvider implements AnalysisProvider {
  // The mock scores from transcript text and metrics only — it has no acoustic
  // evidence, so it never claims a pronunciation score.
  readonly capabilities = { pronunciationEvidence: false };

  async analyze(input: AnalysisInput): Promise<SessionAnalysis> {
    const learnerTurns = input.transcript.filter((t) => t.speaker === "learner");
    const observations: SessionAnalysis["observations"] = [];
    const perSkill = new Map<string, { count: number; confidence: number }>();

    for (const turn of learnerTurns) {
      for (const entry of LEXICON) {
        if (entry.match(turn.text)) {
          observations.push({
            type: "language_error", skill: entry.skill,
            evidence: turn.text, actual: entry.actual, expected: entry.expected,
            severity: entry.severity, confidence: entry.confidence,
          });
          const cur = perSkill.get(entry.skill) ?? { count: 0, confidence: 0 };
          perSkill.set(entry.skill, { count: cur.count + 1, confidence: Math.max(cur.confidence, entry.confidence) });
        }
      }
    }

    const recurring = [...perSkill.entries()]
      .filter(([, v]) => v.count >= 3)
      .map(([skill, v]) => ({ skill, pattern: LEXICON.find((e) => e.skill === skill)?.pattern ?? skill, confidence: v.confidence }));

    const strengths = input.transcript.some((t) => t.speaker === "learner" && /\bnegotiate\b/i.test(t.text))
      ? [{ skill: "vocabulary.precision", evidence: "used 'negotiate' in context", confidence: 0.8 }]
      : [];

    const recommended = [...new Set([...recurring.map((r) => r.skill), ...input.sessionTargets])];

    return {
      scores: deterministicScores(input.metrics),
      observations,
      recurring_errors: recurring,
      strengths,
      recommended_targets: recommended,
    };
  }

  async plan(input: { difficulty: number; candidates: string[]; learnerContext: LearnerContext }): Promise<PlanDraft> {
    const topic = input.difficulty >= 0.7
      ? "Convince a colleague to accept a policy you both dislike"
      : input.difficulty >= 0.5
        ? "Describe a difficult decision you made at work"
        : "Tell me about your last weekend";
    const avoid = new Set(input.learnerContext.recentTopics);
    const finalTopic = avoid.has(topic) ? "Talk about a book or film that changed your mind" : topic;
    return { topic: finalTopic, candidateSkills: input.candidates.slice(0, 3), reason: "Top-ranked recurring weaknesses selected for the next session." };
  }
}

function deterministicScores(m: SessionMetrics): SessionAnalysis["scores"] {
  const fluency = clamp01(0.5 + (m.wordsPerMinute - 90) / 200 - (m.longestPauseMs > 3000 ? 0.1 : 0));
  return {
    fluency,
    grammar: 0.62,
    vocabulary: 0.7,
    // Not assessed: no audio-grounded evidence (spec §12.1).
    pronunciation: null,
    coherence: 0.7,
    interaction: 0.8,
  };
}

function clamp01(x: number): number { return Math.min(1, Math.max(0, x)); }
