import { randomUUID } from "node:crypto";
import { eq, and, ne, inArray } from "drizzle-orm";
import {
  sessions, utterances, observations, skills, errorPatterns, vocabularyItems,
  learners, jobs, correctedSentences, vocabularyItemsCanonical, vocabularyState,
  difficultyProfiles, interventions, audioEvidence, pronunciationAssessments,
  tryParseJson, type DrizzleDb,
} from "@ec/db";
import type { Scores, SessionAnalysis, SessionMetrics, Observation, SkillState } from "@ec/domain";
import { SessionAnalysisSchema } from "@ec/domain";
import type { AnalysisProvider, TranscriptTurn } from "@ec/openai";
import {
  calculateOverall, updateSkill, trendFromDelta,
  upsertErrorInput, shouldRetire, estimateLevel, deriveFeedback,
  lemmaCandidates, applyVocabEvidence, INITIAL_VOCAB_STATE, type VocabState,
  decomposeDifficulty,
  decodePcm16, measureAudio, scorePronunciation, PRONUNCIATION_RUBRIC_VERSION,
  type ErrorPatternInput,
} from "@ec/learning-engine";
import { buildLearnerContext } from "./context.js";

const PERFORMANCE: Record<Observation["type"], (o: Observation) => number> = {
  language_error: (o) => 1 - (o.severity ?? 0.5),
  strength: () => 0.9,
  vocabulary_use: () => 0.8,
  fluency_signal: () => 0.7,
};

export async function runAnalysis(opts: {
  db: DrizzleDb;
  provider: AnalysisProvider;
  sessionId: string;
  now: number;
}): Promise<void> {
  const { db: d, provider, sessionId, now } = opts;
  const session = d.select().from(sessions).where(eq(sessions.id, sessionId)).all()[0];
  if (!session) throw new Error(`unknown session ${sessionId}`);
  if (session.analysis) return; // idempotency: already analyzed

  const turns: TranscriptTurn[] = d.select().from(utterances)
    .where(eq(utterances.sessionId, sessionId))
    .all()
    .map((u) => ({
      speaker: u.speaker as "learner" | "coach",
      text: u.text,
      startedAt: u.startedAt ?? 0,
      endedAt: u.endedAt ?? 0,
    }))
    .sort((a, b) => a.startedAt - b.startedAt);

  const metrics: SessionMetrics = tryParseJson<SessionMetrics>(session.metrics) ?? {
    speakingSeconds: 0, userWordCount: 0, wordsPerMinute: 0, pauseCount: 0,
    avgPauseMs: 0, longestPauseMs: 0, utteranceCount: 0, avgUtteranceWords: 0,
  };
  const learnerContext = buildLearnerContext(d, session.learnerId, sessionId, now);

  const raw = await provider.analyze({
    learnerId: session.learnerId,
    transcript: turns,
    metrics,
    learnerContext,
    sessionTargets: learnerContext.currentSessionTargets,
  });
  const analysis = SessionAnalysisSchema.parse(raw); // throws → job retry/failure, no writes

  // 1) session scores + overall
  // A provider that cannot ground a score in audio must not contribute one:
  // the number is stripped here, not merely discouraged in the prompt
  // (spec §12.1 / §3 principle 7 — no fabricated measurement).
  //
  // The acoustic assessment below is the ONLY thing that can supply a
  // pronunciation score, and it runs on the retained audio rather than on the
  // provider's answer.
  const acoustic = assessPronunciation(d, sessionId, now);
  const scores: Scores = acoustic
    ? { ...analysis.scores, pronunciation: acoustic.intelligibility }
    : { ...analysis.scores, pronunciation: null };
  const overall = calculateOverall(scores);
  // The stored analysis carries the same stripped scores as the columns, so a
  // reader never sees a pronunciation number the score column denies.
  const stored = { ...analysis, scores };

  // 2) update learner memory (sequential statements; safe to re-run: the
  // idempotency guard at the top plus UNIQUE constraints make a crashed
  // mid-run retry a no-op)
  applyMemory(d, session.learnerId, sessionId, stored, overall, now);

  // 4) persist the difficulty profile (design.md §10) so the composite the
  // planner used can be explained component by component.
  persistDifficultyProfile(d, sessionId, session.learnerId, turns, metrics, now);


  // 5) persist the reviewable corrections (spec §11.3). Derived from the
  // stored analysis, so a retry writes the same rows; the `any existing` guard
  // means a re-run cannot duplicate them (spec §3 principle 6). Written before
  // the session row is marked analysed: a crash in between must not leave a
  // session that looks analysed but has no corrections, because the idempotency
  // guard at the top would then never run this code again.
  persistCorrections(d, sessionId, stored, now);

  d.update(sessions).set({
    status: "COMPLETED",
    fluencyScore: scores.fluency,
    grammarScore: scores.grammar,
    vocabularyScore: scores.vocabulary,
    pronunciationScore: scores.pronunciation,
    coherenceScore: scores.coherence,
    interactionScore: scores.interaction,
    overallScore: overall,
    analysis: JSON.stringify(stored),
  }).where(eq(sessions.id, sessionId)).run();

  // learner level estimate (longitudinal, spec §31)
  const completedCount = d.select().from(sessions)
    .where(and(eq(sessions.learnerId, session.learnerId), eq(sessions.status, "COMPLETED"))).all().length;
  const { level, confidence } = estimateLevel(overall, completedCount);
  d.update(learners).set({
    estimatedLevel: level,
    estimatedLevelConfidence: confidence,
    updatedAt: now,
  }).where(eq(learners.id, session.learnerId)).run();

  // 3) persist observations rows (evidence trail, spec §23)
  for (const o of analysis.observations) {
    d.insert(observations).values({
      id: `obs-${randomUUID()}`,
      sessionId,
      type: o.type,
      skillCode: o.skill,
      evidence: o.evidence,
      expected: o.expected ?? null,
      actual: o.actual ?? null,
      severity: o.severity ?? null,
      confidence: o.confidence,
      createdAt: now,
    }).run();
  }

  // 6) queue the planner
  try {
    d.insert(jobs).values({
      id: `job-${randomUUID()}`,
      type: "plan_next",
      sessionId,
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
      createdAt: now,
    }).run();
  } catch { /* duplicate no-op */ }
}

/**
 * Records a produced word against its canonical item and the learner's state
 * of it. Idempotent per session: the state moves once per session, so a
 * re-run of the analysis does not inflate mastery.
 */
/**
 * Computes and stores the session's six-part difficulty profile.
 *
 * Familiarity is measured against the words the learner used in EARLIER
 * sessions, so a topic they have spoken about before scores as less demanding
 * than a new one. One profile per session (UNIQUE session_id), so a re-run
 * overwrites rather than stacks.
 */
/**
 * Measures the session's retained audio and stores the assessment.
 *
 * Returns null when there is nothing to measure: no audio was retained (the
 * OpenAI Realtime provider does not keep samples), or the audio was too short
 * to judge. Either way the pronunciation dimension stays null — "not
 * assessed", never a number derived from the transcript.
 */
function assessPronunciation(
  d: DrizzleDb,
  sessionId: string,
  now: number,
): { intelligibility: number; stress: number; rhythm: number; confidence: number } | null {
  const rows = d.select().from(audioEvidence)
    .where(eq(audioEvidence.sessionId, sessionId)).all();
  if (rows.length === 0) return null;

  // Every retained turn is measured, and the results are averaged weighted by
  // how much audio each turn holds — a long turn says more than a clipped one.
  let weightSum = 0;
  let intelligibility = 0;
  let stress = 0;
  let rhythm = 0;
  let confidence = 0;
  for (const row of rows) {
    const pcm = decodePcm16(row.pcmBase64);
    const measurements = measureAudio(pcm, row.sampleRate);
    const scored = scorePronunciation(measurements);
    if (scored.confidence === 0) continue;
    const weight = measurements.durationSec;
    weightSum += weight;
    intelligibility += scored.intelligibility * weight;
    stress += scored.stress * weight;
    rhythm += scored.rhythm * weight;
    confidence += scored.confidence * weight;
    // The measurements are kept with the audio, so a score can be re-checked
    // against the samples that produced it.
    d.update(audioEvidence).set({ measurements: JSON.stringify(measurements) })
      .where(eq(audioEvidence.id, row.id)).run();
  }
  if (weightSum === 0) return null;

  const result = {
    intelligibility: Number((intelligibility / weightSum).toFixed(4)),
    stress: Number((stress / weightSum).toFixed(4)),
    rhythm: Number((rhythm / weightSum).toFixed(4)),
    confidence: Number((confidence / weightSum).toFixed(4)),
  };

  const evidenceId = rows[0].id;
  const existing = d.select().from(pronunciationAssessments)
    .where(eq(pronunciationAssessments.audioEvidenceId, evidenceId)).all()[0];
  if (existing) {
    d.update(pronunciationAssessments).set({
      intelligibility: result.intelligibility,
      stress: result.stress,
      rhythm: result.rhythm,
      confidence: result.confidence,
    }).where(eq(pronunciationAssessments.id, existing.id)).run();
  } else {
    d.insert(pronunciationAssessments).values({
      id: `pron-${randomUUID()}`,
      sessionId,
      audioEvidenceId: evidenceId,
      rubricVersion: PRONUNCIATION_RUBRIC_VERSION,
      intelligibility: result.intelligibility,
      stress: result.stress,
      rhythm: result.rhythm,
      confidence: result.confidence,
      createdAt: now,
    }).run();
  }
  return result;
}

function persistDifficultyProfile(
  d: DrizzleDb,
  sessionId: string,
  learnerId: string,
  turns: TranscriptTurn[],
  metrics: SessionMetrics,
  now: number,
): void {
  const learnerTurns = turns.filter((t) => t.speaker === "learner").map((t) => t.text);
  const coachTurns = turns.filter((t) => t.speaker === "coach").map((t) => t.text);
  const interventionCount = d.select().from(interventions).where(eq(interventions.sessionId, sessionId)).all().length;

  // Words used in earlier sessions — this session's own words do not count.
  const earlier = d.select().from(utterances)
    .where(and(eq(utterances.speaker, "learner"), ne(utterances.sessionId, sessionId))).all()
    .filter((u) => {
      const s = d.select().from(sessions).where(eq(sessions.id, u.sessionId)).all()[0];
      return s?.learnerId === learnerId;
    });
  const familiarWords = new Set<string>();
  for (const u of earlier) {
    for (const w of u.text.toLowerCase().match(/[a-z']+/g) ?? []) familiarWords.add(w);
  }

  const profile = decomposeDifficulty({
    learnerTurns, coachTurns, metrics, interventions: interventionCount, familiarWords,
  });

  const existing = d.select().from(difficultyProfiles)
    .where(eq(difficultyProfiles.sessionId, sessionId)).all()[0];
  if (existing) {
    d.update(difficultyProfiles).set({
      vocabularyComplexity: profile.vocabularyComplexity,
      grammaticalComplexity: profile.grammaticalComplexity,
      speechSpeed: profile.speechSpeed,
      abstraction: profile.abstraction,
      interactionPressure: profile.interactionPressure,
      topicFamiliarity: profile.topicFamiliarity,
      composite: profile.composite,
    }).where(eq(difficultyProfiles.id, existing.id)).run();
    return;
  }
  d.insert(difficultyProfiles).values({
    id: `diff-${randomUUID()}`,
    sessionId,
    vocabularyComplexity: profile.vocabularyComplexity,
    grammaticalComplexity: profile.grammaticalComplexity,
    speechSpeed: profile.speechSpeed,
    abstraction: profile.abstraction,
    interactionPressure: profile.interactionPressure,
    topicFamiliarity: profile.topicFamiliarity,
    composite: profile.composite,
    createdAt: now,
  }).run();
}

function trackCanonicalVocabulary(d: DrizzleDb, learnerId: string, word: string, now: number): void {
  // Resolve against what already exists: "negotiated" and "negotiate" must
  // land on the same canonical item, and the lemma candidates are how that
  // is decided without a rule that could merge two different words.
  const candidates = lemmaCandidates(word);
  if (candidates.length === 0) return;
  const existing = d.select().from(vocabularyItemsCanonical)
    .where(and(
      eq(vocabularyItemsCanonical.senseKey, "default"),
      inArray(vocabularyItemsCanonical.lemma, candidates),
    )).all();
  const canonical = existing.sort((a, b) => candidates.indexOf(a.lemma) - candidates.indexOf(b.lemma))[0];
  const lemma = canonical?.lemma ?? candidates[0];

  // The sense key is "default" because nothing in the pipeline distinguishes
  // senses yet. It is a column, not a convention, so a second sense can be
  // added later without merging it into this one (spec §6.5).
  const itemId = canonical?.id ?? `voc-${randomUUID()}`;
  if (!canonical) {
    d.insert(vocabularyItemsCanonical).values({
      id: itemId, lemma, senseKey: "default",
      partOfSpeech: null, definition: null,
      exampleSentences: null, collocations: null, register: null, topicTags: null,
      createdAt: now,
    }).run();
  }

  const stateRow = d.select().from(vocabularyState)
    .where(and(
      eq(vocabularyState.learnerId, learnerId),
      eq(vocabularyState.vocabularyItemId, itemId),
    )).all()[0];
  const prev = stateRow
    ? {
        recognitionMastery: stateRow.recognitionMastery,
        recallMastery: stateRow.recallMastery,
        productionMastery: stateRow.productionMastery,
        stability: stateRow.stability,
        difficulty: stateRow.difficulty,
        reviewCount: stateRow.reviewCount,
        lapseCount: stateRow.lapseCount,
        status: stateRow.status as VocabState["status"],
      }
    : INITIAL_VOCAB_STATE;
  const next = applyVocabEvidence(prev, { produced: true, recognised: true, recalled: true });

  if (stateRow) {
    d.update(vocabularyState).set({
      recognitionMastery: next.recognitionMastery,
      recallMastery: next.recallMastery,
      productionMastery: next.productionMastery,
      stability: next.stability,
      difficulty: next.difficulty,
      reviewCount: next.reviewCount,
      lapseCount: next.lapseCount,
      status: next.status,
      lastReviewedAt: now,
    }).where(eq(vocabularyState.id, stateRow.id)).run();
  } else {
    d.insert(vocabularyState).values({
      id: `vstate-${randomUUID()}`,
      learnerId, vocabularyItemId: itemId,
      recognitionMastery: next.recognitionMastery,
      recallMastery: next.recallMastery,
      productionMastery: next.productionMastery,
      stability: next.stability,
      difficulty: next.difficulty,
      reviewCount: next.reviewCount,
      lapseCount: next.lapseCount,
      lastRecallRating: null,
      status: next.status,
      lastReviewedAt: now,
      createdAt: now,
    }).run();
  }
}

function persistCorrections(d: DrizzleDb, sessionId: string, analysis: SessionAnalysis, now: number): void {
  const existing = d.select().from(correctedSentences)
    .where(eq(correctedSentences.sessionId, sessionId)).all();
  if (existing.length > 0) return;
  for (const c of deriveFeedback(analysis).corrections) {
    d.insert(correctedSentences).values({
      id: `corr-${randomUUID()}`,
      sessionId,
      original: c.original,
      suggested: c.suggested,
      explanation: c.explanation,
      skillCode: c.skill,
      evidence: c.evidence,
      confidence: c.confidence,
      learnerAction: "pending",
      createdAt: now,
    }).run();
  }
}

function applyMemory(
  d: DrizzleDb,
  learnerId: string,
  sessionId: string,
  analysis: SessionAnalysis,
  overall: number,
  now: number,
): void {
  // Skills: EMA update per observed skill (only confidence > 0.8 observations count)
  const errorsBySkill = new Map<string, { severity: number; confidence: number }>();
  for (const o of analysis.observations) {
    if (o.confidence <= 0.8) continue;
    if (o.type === "language_error") {
      const cur = errorsBySkill.get(o.skill);
      errorsBySkill.set(o.skill, {
        severity: Math.max(cur?.severity ?? 0, o.severity ?? 0.5),
        confidence: Math.max(cur?.confidence ?? 0, o.confidence),
      });
    }
    const existing = d.select().from(skills)
      .where(and(eq(skills.learnerId, learnerId), eq(skills.code, o.skill))).all()[0];
    if (existing) {
      const prev: SkillState = {
        mastery: existing.mastery, confidence: existing.confidence,
        observationCount: existing.observationCount, trend: existing.trend as SkillState["trend"],
      };
      const next = updateSkill(prev, PERFORMANCE[o.type](o), now);
      d.update(skills).set({
        mastery: next.mastery,
        confidence: next.confidence,
        observationCount: next.observationCount,
        trend: trendFromDelta(prev.mastery, next.mastery),
        lastAssessedAt: now,
      }).where(eq(skills.id, existing.id)).run();
    } else {
      d.insert(skills).values({
        id: `skill-${randomUUID()}`,
        learnerId,
        code: o.skill,
        mastery: 0.5,
        confidence: 0.1,
        trend: "stable",
        observationCount: 0,
        lastAssessedAt: now,
      }).run();
      // then update the fresh row
      const created = d.select().from(skills)
        .where(and(eq(skills.learnerId, learnerId), eq(skills.code, o.skill))).all()[0];
      d.update(skills).set({
        mastery: updateSkill(
          { mastery: 0.5, confidence: 0.1, observationCount: 0, trend: "stable" },
          PERFORMANCE[o.type](o), now,
        ).mastery,
        confidence: 0.15,
        observationCount: 1,
      }).where(eq(skills.id, created.id)).run();
    }
  }

  // Error patterns: upsert per (skill, pattern); pattern = recurring name if flagged, else "other"
  for (const [skill, e] of errorsBySkill) {
    const recurring = analysis.recurring_errors.find((r) => r.skill === skill);
    const pattern = recurring?.pattern ?? "other";
    const prevRow = d.select().from(errorPatterns)
      .where(and(
        eq(errorPatterns.learnerId, learnerId),
        eq(errorPatterns.skillCode, skill),
        eq(errorPatterns.pattern, pattern),
      )).all()[0];
    const prev: ErrorPatternInput | null = prevRow
      ? {
          skill, pattern, frequency: prevRow.frequency, severity: prevRow.severity,
          mastery: prevRow.mastery, confidence: prevRow.confidence, status: prevRow.status as "active" | "mastered",
          firstSeenAt: prevRow.firstSeenAt, lastSeenAt: prevRow.lastSeenAt,
        }
      : null;
    const count = analysis.observations.filter((o) => o.skill === skill && o.type === "language_error").length;
    let next = prev;
    for (let i = 0; i < count; i++) {
      next = upsertErrorInput(next, { skill, pattern, severity: e.severity, confidence: e.confidence }, now);
    }
    if (next) {
      if (prevRow) {
        d.update(errorPatterns).set({
          frequency: next.frequency,
          severity: next.severity,
          confidence: next.confidence,
          lastSeenAt: now,
        }).where(eq(errorPatterns.id, prevRow.id)).run();
      } else {
        d.insert(errorPatterns).values({
          id: `err-${randomUUID()}`,
          learnerId,
          skillCode: skill,
          pattern: next.pattern,
          frequency: next.frequency,
          severity: next.severity,
          confidence: next.confidence,
          firstSeenAt: now,
          lastSeenAt: now,
        }).run();
      }
    }
  }

  // Retirement: mark stale or outgrown patterns mastered (spec §10.3)
  for (const row of d.select().from(errorPatterns)
    .where(and(eq(errorPatterns.learnerId, learnerId), eq(errorPatterns.status, "active"))).all()) {
    const skillRow = d.select().from(skills)
      .where(and(eq(skills.learnerId, learnerId), eq(skills.code, row.skillCode))).all()[0];
    const input: ErrorPatternInput = {
      skill: row.skillCode, pattern: row.pattern, frequency: row.frequency,
      severity: row.severity, mastery: row.mastery, confidence: row.confidence,
      status: "active", firstSeenAt: row.firstSeenAt, lastSeenAt: row.lastSeenAt,
    };
    if (shouldRetire(input, skillRow?.mastery ?? 0, now)) {
      d.update(errorPatterns).set({ status: "mastered" }).where(eq(errorPatterns.id, row.id)).run();
    }
  }

  // Vocabulary: canonical item + per-learner state (spec §6.5).
  //
  // The canonical item is shared and keyed by (lemma, sense) so a polysemous
  // word keeps its meanings apart; the learner state tracks recognition,
  // recall and production separately, because knowing a word and using it are
  // different skills. The legacy `vocabulary_items` row is still written so
  // the existing review queue keeps working.
  for (const o of analysis.observations.filter((x) => x.type === "vocabulary_use")) {
    const word = (o.evidence.match(/[a-zA-Z]{4,}/g) ?? []).sort((a, b) => b.length - a.length)[0];
    if (!word) continue;
    trackCanonicalVocabulary(d, learnerId, word, now);
    const existing = d.select().from(vocabularyItems)
      .where(and(eq(vocabularyItems.learnerId, learnerId), eq(vocabularyItems.word, word))).all()[0];
    if (existing) {
      d.update(vocabularyItems).set({
        productionCount: existing.productionCount + 1,
        productionMastery: Math.min(0.95, existing.productionMastery + 0.05),
        lastUsedAt: now,
        nextReviewAt: now + Math.max(1, Math.floor(10 * (existing.productionMastery + 0.05))) * 86_400_000,
      }).where(eq(vocabularyItems.id, existing.id)).run();
    } else {
      d.insert(vocabularyItems).values({
        id: `vocab-${randomUUID()}`,
        learnerId, word,
        recognitionMastery: 0.3,
        productionMastery: 0.1,
        collocationMastery: 0,
        exposureCount: 0,
        productionCount: 1,
        lastUsedAt: now,
      }).run();
    }
  }
  void overall; // overall is persisted by the caller; retained for signature stability
}
