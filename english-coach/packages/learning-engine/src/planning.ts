import type { InterventionType } from "@ec/domain";
import { familyOf } from "@ec/domain";
import { rankCandidates, type TargetCandidate } from "./prioritization.js";

export function selectTargets(candidates: TargetCandidate[]): {
  primary: TargetCandidate[];
  secondary: TargetCandidate[];
} {
  const eligible = candidates.filter((c) => (c.mastery ?? 0) < 0.8);
  const ranked = rankCandidates(eligible);
  return {
    primary: ranked.slice(0, 2),
    secondary: ranked.slice(2, 3),
  };
}

const INTERVENTION_BY_FAMILY: Record<string, InterventionType> = {
  grammar: "natural_reuse",
  vocabulary: "repetition",
  fluency: "role_play",
  discourse: "storytelling",
  pronunciation: "contrast",
};

export function chooseIntervention(skillCode: string): InterventionType {
  const family = familyOf(skillCode);
  if (family === "grammar" && skillCode === "grammar.articles") return "micro_correction";
  return (family && INTERVENTION_BY_FAMILY[family]) ?? "natural_reuse";
}

export function estimateLevel(overall: number, sessionCount: number): { level: string; confidence: number } {
  let level: string;
  if (overall < 0.4) level = "A2";
  else if (overall < 0.55) level = "B1";
  else if (overall < 0.7) level = "B1+";
  else if (overall < 0.82) level = "B2+";
  else level = "C1";
  const confidence = Math.min(0.95, Math.max(0.3, 0.3 + sessionCount * 0.05));
  return { level, confidence };
}
