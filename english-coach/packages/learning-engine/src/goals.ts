/**
 * Goal decomposition (spec §6.1, §11.1 Goals: "creation, decomposition,
 * priorities, due dates").
 *
 * Milestones are checked deterministically against skill mastery, never marked
 * by a model. A milestone with no target skill is not auto-checkable, so its
 * status is left alone rather than guessed.
 */
export interface MilestoneInput {
  id: string;
  status: string;
  targetSkillCode: string | null;
  targetMastery: number | null;
}

export function milestoneMet(
  m: MilestoneInput,
  skillMastery: number | undefined,
): boolean {
  if (m.status === "achieved") return true;
  if (m.targetSkillCode === null || m.targetMastery === null) return false;
  if (skillMastery === undefined) return false;
  return skillMastery >= m.targetMastery;
}

/**
 * Suggests milestones for a goal from the learner's real weaknesses: one per
 * skill that is currently weak. Deterministic — the same state gives the same
 * suggestion, and nothing is invented that the learner has no evidence for.
 */
export function suggestMilestones(goalType: string, weakSkills: { code: string; mastery: number }[]): {
  title: string;
  targetSkillCode: string;
  targetMastery: number;
}[] {
  return weakSkills
    .filter((s) => s.code.split(".")[0] === goalType)
    .sort((a, b) => a.mastery - b.mastery)
    .slice(0, 3)
    .map((s) => ({
      title: `Raise ${s.code.split(".").slice(1).join(" ")} to 70%`,
      targetSkillCode: s.code,
      // A fixed, reachable bar: the engine already treats 0.8 as "mastered",
      // so 0.7 is a step on the way rather than a redefinition of mastered.
      targetMastery: 0.7,
    }));
}
