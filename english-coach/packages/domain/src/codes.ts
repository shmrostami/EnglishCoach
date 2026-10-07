export const FAMILIES = ["grammar", "vocabulary", "fluency", "pronunciation", "discourse"] as const;
export type Family = (typeof FAMILIES)[number];

export const SKILL_CODES: string[] = [
  "grammar.past_tense", "grammar.present_perfect", "grammar.conditionals",
  "grammar.articles", "grammar.prepositions", "grammar.word_order",
  "vocabulary.breadth", "vocabulary.precision", "vocabulary.collocations", "vocabulary.retrieval",
  "fluency.continuity", "fluency.hesitation", "fluency.retrieval_speed", "fluency.self_correction",
  "pronunciation.intelligibility", "pronunciation.stress", "pronunciation.rhythm",
  "discourse.coherence", "discourse.storytelling", "discourse.argumentation",
];

export function isSkillCode(code: string): boolean {
  return SKILL_CODES.includes(code);
}

export function familyOf(code: string): Family | null {
  const f = code.split(".")[0];
  return (FAMILIES as readonly string[]).includes(f) ? (f as Family) : null;
}
