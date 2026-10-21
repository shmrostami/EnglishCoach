import { clamp01 } from "./mastery.js";

/**
 * Vocabulary state (spec §6.5).
 *
 * Three masteries move independently, because they are three different
 * skills: recognising a word, recalling it when prompted, and producing it
 * unprompted. The old worker only ever touched `productionMastery`, so the
 * review scheduler was training on one axis and calling it the rest.
 */
export interface VocabState {
  recognitionMastery: number;
  recallMastery: number;
  productionMastery: number;
  stability: number;
  difficulty: number;
  reviewCount: number;
  lapseCount: number;
  status: "learning" | "known" | "lapsed";
}

export const INITIAL_VOCAB_STATE: VocabState = {
  recognitionMastery: 0,
  recallMastery: 0,
  productionMastery: 0,
  stability: 0,
  difficulty: 0.5,
  reviewCount: 0,
  lapseCount: 0,
  status: "learning",
};

/**
 * Lemma candidates for a surface form, best first.
 *
 * Rather than guessing one lemma, this returns the candidates that could be
 * the lemma, and the caller resolves them against what already exists. That
 * is how "negotiated" and "negotiate" end up as one item ("negotiate" is a
 * candidate of both) without a wrong rule merging two different words
 * (spec §6.5: distinct meanings must not be merged).
 *
 * The rules are deliberately conservative. A word whose stem cannot be derived
 * with confidence keeps its own form as the only candidate.
 */
export function lemmaCandidates(word: string): string[] {
  const w = word.toLowerCase().trim();
  if (!w) return [];
  const out: string[] = [];

  const push = (c: string) => {
    if (c && c.length >= 2 && !out.includes(c)) out.push(c);
  };

  // Nouns ending in -s that are not plurals of a singular noun.
  if (/(?:ss|us|is)$/.test(w)) {
    push(w);
    return out;
  }
  if (w.endsWith("ies") && w.length > 4) push(`${w.slice(0, -3)}y`);
  if (w.endsWith("sses") || w.endsWith("shes") || w.endsWith("ches") || w.endsWith("xes")) push(w.slice(0, -2));
  if (w.endsWith("s") && w.length > 3) push(w.slice(0, -1));

  // Verbs.
  if (w.endsWith("ied") && w.length > 4) push(`${w.slice(0, -3)}y`);
  if (w.endsWith("ed") && w.length > 4) {
    const stem = w.slice(0, -2);
    push(stem);
    // "negotiated" -> "negotiat" is wrong; "negotiate" is right.
    push(stem.endsWith("t") || stem.endsWith("d") ? `${stem}e` : stem);
    // "stopped" -> "stopp" is wrong; "stop" is right.
    if (stem.length > 2 && stem.at(-1) === stem.at(-2)) push(stem.slice(0, -1));
  }
  if (w.endsWith("ing") && w.length > 5) {
    const stem = w.slice(0, -3);
    push(stem);
    push(`${stem}e`);
    // "running" -> "runn" is wrong; "run" is right.
    if (stem.length > 2 && stem.at(-1) === stem.at(-2)) push(stem.slice(0, -1));
  }

  // The surface form itself is always the last resort — it is never wrong,
  // only imprecise.
  push(w);
  return out;
}

/**
 * The single best lemma key for a surface form.
 *
 * Used where there is nothing to resolve against (a new word). When the word
 * already has a canonical item, the caller should look through
 * `lemmaCandidates` instead and use the one that already exists.
 */
export function normalizeLemma(word: string): string {
  return lemmaCandidates(word)[0] ?? "";
}

/** How a piece of evidence moves each of the three masteries. */
export interface VocabEvidence {
  /** The learner said the word unprompted. */
  produced?: boolean;
  /** The learner recognised it when shown. */
  recognised?: boolean;
  /** The learner recalled it when prompted. */
  recalled?: boolean;
  /** The learner failed to produce it. */
  missed?: boolean;
}

/**
 * Applies one piece of evidence to a state. Deterministic, and conservative:
 * production is the hardest thing to earn and the easiest to lose.
 */
export function applyVocabEvidence(prev: VocabState, ev: VocabEvidence): VocabState {
  let { recognitionMastery, recallMastery, productionMastery } = prev;
  let { stability, difficulty, reviewCount, lapseCount, status } = prev;

  if (ev.produced) {
    // Unprompted use is the strongest signal: it moves production most, and
    // recognition/recall follow behind it.
    productionMastery = clamp01(productionMastery + 0.15);
    recallMastery = clamp01(recallMastery + 0.08);
    recognitionMastery = clamp01(recognitionMastery + 0.04);
    stability = clamp01(stability + 0.1);
    difficulty = clamp01(difficulty - 0.03);
  }
  if (ev.recalled) {
    recallMastery = clamp01(recallMastery + 0.1);
    recognitionMastery = clamp01(recognitionMastery + 0.04);
    stability = clamp01(stability + 0.06);
  }
  if (ev.recognised) {
    recognitionMastery = clamp01(recognitionMastery + 0.08);
  }
  if (ev.missed) {
    // A lapse costs production more than it costs recognition, and makes the
    // item harder rather than resetting it (spec §7.4 requirement 5).
    productionMastery = clamp01(productionMastery - 0.08);
    recallMastery = clamp01(recallMastery - 0.05);
    stability = clamp01(stability - 0.05);
    difficulty = clamp01(difficulty + 0.05);
    lapseCount = lapseCount + 1;
  }

  reviewCount = reviewCount + (ev.produced || ev.recalled || ev.recognised || ev.missed ? 1 : 0);
  // "Known" needs production, not just exposure: a word seen but never used
  // is not known.
  status = productionMastery >= 0.8 ? "known" : lapseCount > 0 && stability < 0.2 ? "lapsed" : "learning";

  return {
    recognitionMastery, recallMastery, productionMastery,
    stability, difficulty, reviewCount, lapseCount, status,
  };
}

/** The review queue should offer the weakest axis first. */
export function weakestAxis(s: VocabState): "recognition" | "recall" | "production" {
  const min = Math.min(s.recognitionMastery, s.recallMastery, s.productionMastery);
  if (min === s.recognitionMastery) return "recognition";
  if (min === s.recallMastery) return "recall";
  return "production";
}
