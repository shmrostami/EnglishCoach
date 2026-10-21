import type { InterventionType } from "@ec/domain";

/**
 * Session types (design.md §30).
 *
 * The design says the system should rotate through several modes, and that
 * difficulty rises in COGNITIVE DEMAND, not vocabulary alone — a debate at B2
 * is harder than a story at B2 even with the same words.
 *
 * Each type carries its own cognitive demand, so the planner can pick a mode
 * the learner can handle rather than a topic that happens to be familiar.
 */
export type SessionType =
  | "conversation"
  | "storytelling"
  | "role_play"
  | "problem_solving"
  | "opinion_debate"
  | "professional_simulation";

export interface SessionTypeSpec {
  type: SessionType;
  label: string;
  /** Cognitive demand, 0..1 — what makes the mode hard, independent of words. */
  cognitiveDemand: number;
  /** The intervention this mode is best served by. */
  intervention: InterventionType;
  /** A template the topic generator can fill in. */
  promptTemplate: string;
  /** The vocabulary family this mode exercises most. */
  exercises: string;
}

export const SESSION_TYPES: SessionTypeSpec[] = [
  {
    type: "conversation",
    label: "Free conversation",
    // Below the others on purpose: this is the mode a beginner gets, and a
    // learner working below 0.23 still needs a task they can do.
    cognitiveDemand: 0.2,
    intervention: "natural_reuse",
    promptTemplate: "Talk freely about {topic}",
    exercises: "fluency",
  },
  {
    type: "storytelling",
    label: "Storytelling",
    cognitiveDemand: 0.45,
    intervention: "storytelling",
    promptTemplate: "Tell me a story about {topic}",
    exercises: "discourse",
  },
  {
    type: "role_play",
    label: "Role play",
    cognitiveDemand: 0.6,
    intervention: "role_play",
    promptTemplate: "You are {role}. Let's talk about {topic}",
    exercises: "vocabulary",
  },
  {
    type: "problem_solving",
    label: "Problem solving",
    cognitiveDemand: 0.7,
    intervention: "elicitation",
    promptTemplate: "Here is a problem: {topic}. Work out what to do, step by step.",
    exercises: "grammar",
  },
  {
    type: "opinion_debate",
    label: "Opinion and debate",
    cognitiveDemand: 0.78,
    intervention: "contrast",
    promptTemplate: "Do you agree? Take a position on {topic} and defend it.",
    exercises: "discourse",
  },
  {
    type: "professional_simulation",
    label: "Professional simulation",
    cognitiveDemand: 0.88,
    intervention: "micro_correction",
    promptTemplate: "You are {role}. Handle this situation: {topic}",
    exercises: "grammar",
  },
];

/**
 * Chooses the session type for the next session.
 *
 * The type follows the learner's difficulty: a beginner gets free
 * conversation, an advanced learner gets a professional simulation. The type
 * also rotates, so the same mode does not run three sessions in a row — the
 * design's "rotate between several modes".
 *
 * `recentTypes` is oldest→newest, so the last element is the previous type.
 */
export function selectSessionType(opts: {
  difficulty: number;
  recentTypes: SessionType[];
}): SessionTypeSpec {
  const candidates = SESSION_TYPES.filter((s) => s.cognitiveDemand <= opts.difficulty + 0.12);
  const pool = candidates.length > 0 ? candidates : [SESSION_TYPES[0]];
  const previous = opts.recentTypes.at(-1);
  // Prefer a mode the learner has not just done.
  const fresh = pool.filter((s) => s.type !== previous);
  // The MOST demanding mode the learner can handle, not the closest one.
  // "Closest" would hand an advanced learner free conversation, which is the
  // opposite of adaptive: the learner is stretched by the hardest task they
  // can still do, and the mode rotates so the same stretch is not repeated.
  const chosen = (fresh.length > 0 ? fresh : pool)
    .sort((a, b) => b.cognitiveDemand - a.cognitiveDemand)[0];
  return chosen;
}

/** Fills a mode's template with a topic. */
export function renderSessionPrompt(spec: SessionTypeSpec, topic: string, role?: string): string {
  return spec.promptTemplate
    .replace("{topic}", topic)
    .replace("{role}", role ?? "a colleague");
}
