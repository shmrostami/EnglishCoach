import { describe, it, expect } from "vitest";
import {
  updateSkill, trendFromDelta,
  upsertErrorInput, shouldRetire, isRecurring,
  rankCandidates, selectTargets, calculatePriority,
  adjustDifficulty, recentPerformance,
  type TargetCandidate, type ErrorPatternInput,
} from "@ec/learning-engine";
import type { SkillState } from "@ec/domain";

const DAY = 86_400_000;

interface Profile {
  name: string;
  // per skill: initial mastery and per-session performance series (10 sessions)
  skills: Record<string, { mastery: number; perf: number[] }>;
  // error patterns observed in specific sessions
  errors: Record<string, { sessions: number[]; pattern: string; severity: number; confidence: number }>;
}

function simulate(p: Profile) {
  const skills = new Map<string, SkillState>();
  const errors = new Map<string, ErrorPatternInput>();
  const planPerSession: string[][] = [];
  const difficulties: number[] = [0.5];
  const scores: number[] = [];

  for (let s = 0; s < 10; s++) {
    const now = s * 3 * DAY;
    for (const [code, sp] of Object.entries(p.skills)) {
      const prev = skills.get(code) ?? { mastery: sp.mastery, confidence: 0.1, observationCount: 0, trend: "stable" };
      const next = updateSkill(prev, sp.perf[s] ?? 0.5, now);
      skills.set(code, { ...next, trend: trendFromDelta(prev.mastery, next.mastery) });
    }
    for (const [code, e] of Object.entries(p.errors)) {
      if (e.sessions.includes(s)) {
        const prev = errors.get(code) ?? null;
        const next = upsertErrorInput(prev, {
          skill: code, pattern: e.pattern, severity: e.severity, confidence: e.confidence,
        }, now);
        if (next) errors.set(code, next);
      }
    }
    // difficulty step
    scores.push(Math.min(...[...Object.entries(p.skills)].map(([c, sp]) => sp.perf[s] ?? 0.5)));
    difficulties.push(adjustDifficulty(difficulties[difficulties.length - 1], recentPerformance(scores)));
    // target selection
    const goalTypes = ["grammar", "fluency"];
    const candidates: TargetCandidate[] = [...new Set([
      ...[...errors.entries()].filter(([c, e]) => e.status === "active").map(([c]) => c),
      ...Object.keys(p.skills).filter((c) => (skills.get(c)?.mastery ?? 0.5) < 0.5),
    ])].map((code) => {
      const e = errors.get(code);
      const m = skills.get(code)?.mastery ?? 0.5;
      return {
        skill: code,
        recurrence: e ? Math.min(1, e.frequency / 3) : 0,
        severity: e?.severity ?? 0.4,
        goalRelevance: goalTypes.includes(code.split(".")[0]) ? 1 : 0.3,
        communicativeImpact: e ? Math.min(1, e.severity) : 0.4,
        readiness: 1 - m,
        forgettingRisk: e ? 0.5 : 0,
        mastery: m,
      };
    });
    const { primary } = selectTargets(candidates);
    planPerSession.push(primary.map((t) => t.skill));
  }
  return { skills, errors, planPerSession, difficulties };
}

const A: Profile = {
  name: "A: strong vocabulary, weak grammar, good fluency",
  skills: {
    "vocabulary.breadth": { mastery: 0.8, perf: [0.85, 0.86, 0.84, 0.87, 0.85, 0.86, 0.88, 0.86, 0.87, 0.88] },
    "grammar.past_tense": { mastery: 0.4, perf: [0.3, 0.35, 0.34, 0.4, 0.42, 0.45, 0.5, 0.52, 0.55, 0.6] },
    "fluency.continuity": { mastery: 0.75, perf: [0.8, 0.78, 0.8, 0.82, 0.8, 0.8, 0.82, 0.8, 0.82, 0.8] },
  },
  errors: {
    "grammar.past_tense": { sessions: [0, 1, 2, 3], pattern: "present_after_past_expr", severity: 0.65, confidence: 0.9 },
  },
};

const B: Profile = {
  name: "B: strong grammar, weak fluency, frequent hesitation",
  skills: {
    "grammar.past_tense": { mastery: 0.85, perf: [0.9, 0.88, 0.9, 0.9, 0.88, 0.9, 0.9, 0.88, 0.9, 0.9] },
    "fluency.hesitation": { mastery: 0.3, perf: [0.25, 0.28, 0.3, 0.32, 0.35, 0.38, 0.4, 0.42, 0.45, 0.48] },
  },
  errors: {
    "fluency.hesitation": { sessions: [0, 2, 4, 6, 8], pattern: "filler_heaviness", severity: 0.4, confidence: 0.85 },
  },
};

const C: Profile = {
  name: "C: strong comprehension, poor vocabulary retrieval",
  skills: {
    "vocabulary.retrieval": { mastery: 0.25, perf: [0.2, 0.22, 0.25, 0.28, 0.3, 0.33, 0.35, 0.38, 0.4, 0.42] },
    "vocabulary.breadth": { mastery: 0.7, perf: [0.7, 0.72, 0.7, 0.72, 0.7, 0.72, 0.7, 0.72, 0.7, 0.72] },
  },
  errors: {
    "vocabulary.retrieval": { sessions: [0, 1, 3, 5, 7, 9], pattern: "word_search_pauses", severity: 0.5, confidence: 0.88 },
  },
};

for (const p of [A, B, C]) {
  describe(`profile ${p.name}`, () => {
    const out = simulate(p);

    it("selects the profile's weak skill as a target while it is weak", () => {
      const weak = p.name.startsWith("A") ? "grammar.past_tense"
        : p.name.startsWith("B") ? "fluency.hesitation"
        : "vocabulary.retrieval";
      const planned = out.planPerSession.filter((plan) => plan.includes(weak));
      expect(planned.length).toBeGreaterThanOrEqual(3);
    });

    it("does NOT overreact to isolated errors (no non-recurring skill targeted)", () => {
      // no profile has an isolated error; assert no target ever appears from a skill
      // whose error frequency < 3 and mastery >= 0.7
      for (const plan of out.planPerSession) {
        for (const skill of plan) {
          const e = out.errors.get(skill);
          const m = out.skills.get(skill)?.mastery ?? 0.5;
          if ((e?.frequency ?? 0) < 3 && m >= 0.7) {
            expect(plan, `isolated-error skill ${skill} should not be targeted`).not.toContain(skill);
          }
        }
      }
    });

    it("stops targeting a skill once it is mastered", () => {
      const final = out.planPerSession[9];
      for (const skill of final) {
        expect(out.skills.get(skill)?.mastery ?? 0.5).toBeLessThan(0.8);
      }
    });

    it("adjusts difficulty within bounds, monotonically non-chaotic", () => {
      for (const d of out.difficulties) {
        expect(d).toBeGreaterThanOrEqual(0.15);
        expect(d).toBeLessThanOrEqual(0.95);
      }
      for (let i = 1; i < out.difficulties.length; i++) {
        expect(Math.abs(out.difficulties[i] - out.difficulties[i - 1])).toBeLessThanOrEqual(0.051);
      }
    });
  });
}
