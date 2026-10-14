import { useEffect, useState } from "react";
import { api } from "../api/client.js";

interface SkillRow {
  code: string;
  mastery: number;
  confidence: number;
  trend: string;
  // The API (Drizzle) serializes this camelCase — the old view read the
  // snake_case name, which the wire never sends, so the count was always blank.
  observationCount: number;
}

interface PlanRow {
  difficulty: number;
  primaryTargets: string[];
  secondaryTargets: string[] | null;
  topic: string | null;
  reasoning: string | null;
}

interface ProgressRow {
  id: string;
  startedAt: number;
  topic: string | null;
  scores: Record<string, number | null>;
  overall: number | null;
}

// The CEFR rungs, ordered as the level estimate climbs (matches planning.ts).
const LADDER = ["A2", "B1", "B1+", "B2+", "C1"] as const;
const FAMILY_LABEL: Record<string, string> = {
  grammar: "Grammar",
  vocabulary: "Vocabulary",
  fluency: "Fluency",
  pronunciation: "Pronunciation",
  discourse: "Discourse",
};

function familyOf(code: string): string {
  return code.split(".")[0] ?? "";
}

function formatPct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function formatDay(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function DashboardView() {
  const [profile, setProfile] = useState<Record<string, unknown> | null>(null);
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [plan, setPlan] = useState<PlanRow | null>(null);
  const [progress, setProgress] = useState<ProgressRow[]>([]);

  useEffect(() => {
    void api.profile().then(setProfile).catch(() => {});
    void api.skills().then((s) => setSkills(s as unknown as SkillRow[])).catch(() => {});
    void api.plan().then((p) => setPlan(p as unknown as PlanRow | null)).catch(() => {});
    void api.progress().then((p) => setProgress(p as unknown as ProgressRow[])).catch(() => {});
  }, []);

  const level = (profile?.estimatedLevel as string) ?? null;
  const confidence = (profile?.estimatedLevelConfidence as number) ?? 0;
  const ladderIdx = LADDER.indexOf(level as (typeof LADDER)[number]);

  // Group skills by family, preserving a stable family order.
  const byFamily = new Map<string, SkillRow[]>();
  for (const s of skills) {
    const f = familyOf(s.code);
    byFamily.set(f, [...(byFamily.get(f) ?? []), s]);
  }

  // Progress arrives oldest→newest; a delta is against the prior session.
  const rows = progress;

  return (
    <section className="ec-dashboard">
      <h1 className="ec-h1">Your progress</h1>
      <p className="ec-lede">Where you stand, what you're strong at, and what the next session will work on.</p>

      <div className="ec-ladder">
        <div className="ec-ladder__head">
          <span className="ec-level">{level ?? "—"}</span>
          <span className="ec-confidence">{level ? `estimated · ${formatPct(confidence)} confidence` : "no sessions yet"}</span>
        </div>
        <div className="ec-rungs">
          {LADDER.map((rung, i) => {
            const current = i === ladderIdx;
            const reached = ladderIdx >= 0 && i <= ladderIdx;
            return (
              <div key={rung} className={"ec-rung" + (current ? " is-current" : "")}>
                <span className="ec-rung__level">{rung}</span>
                <span className="ec-rung__bar">
                  <span className="ec-rung__fill" style={{ width: `${(reached ? 1 : 0) * 100}%` }} />
                </span>
                {current && <span className="ec-rung__note">you are here</span>}
              </div>
            );
          })}
        </div>
      </div>

      {plan && (
        <div className="section">
          <h2 className="section__title">Next session</h2>
          <div className="ec-plan">
            <p className="ec-plan__topic">{plan.topic ?? "—"}</p>
            <div className="ec-plan__targets">
              {(plan.primaryTargets ?? []).map((t) => <span key={t} className="ec-chip">{t}</span>)}
              {(plan.secondaryTargets ?? []).map((t) => <span key={t} className="ec-chip">{t}</span>)}
            </div>
            {plan.reasoning && <p className="ec-plan__meta" style={{ marginTop: 0.8 }}>{plan.reasoning}</p>}
          </div>
        </div>
      )}

      <div className="section">
        <h2 className="section__title">Skill mastery</h2>
        {byFamily.size === 0 ? (
          <p className="ec-empty">No skills assessed yet — finish a session to begin.</p>
        ) : (
          <div className="ec-mastery">
            {[...byFamily.entries()].map(([family, list]) => (
              <div key={family}>
                <div className="ec-mastery__group">{FAMILY_LABEL[family] ?? family}</div>
                {list.map((s) => (
                  <div key={s.code} className="ec-mastery__row">
                    <div className="ec-skill">
                      <div className="ec-skill__top">
                        <span className="ec-skill__name">{s.code.split(".").slice(1).join(".") || s.code}</span>
                        <span className={"ec-skill__trend ec-skill__trend--" + s.trend}>{s.trend}</span>
                      </div>
                      <div className="ec-meter"><div className="ec-meter__fill" style={{ width: `${s.mastery * 100}%` }} /></div>
                    </div>
                    <div className="ec-mastery__num">
                      {formatPct(s.mastery)}
                      <div className="ec-mastery__obs">{s.observationCount} observed</div>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="section">
        <h2 className="section__title">Recent sessions</h2>
        {rows.length === 0 ? (
          <p className="ec-empty">Nothing yet. Your most recent ten sessions will appear here.</p>
        ) : (
          <table className="ec-ledger">
            <thead>
              <tr><th>When</th><th>Topic</th><th style={{ textAlign: "right" }}>Score</th><th style={{ textAlign: "right" }}>Change</th></tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const prev = i > 0 ? rows[i - 1].overall : null;
                const delta = r.overall != null && prev != null ? r.overall - prev : null;
                return (
                  <tr key={r.id}>
                    <td>{formatDay(r.startedAt)}</td>
                    <td>{r.topic ?? "—"}</td>
                    <td className="ec-ledger__overall" style={{ textAlign: "right" }}>{r.overall != null ? formatPct(r.overall) : "—"}</td>
                    <td className={"ec-ledger__delta" + (delta == null ? "" : delta >= 0 ? " ec-ledger__delta--up" : " ec-ledger__delta--down")} style={{ textAlign: "right" }}>
                      {delta == null ? "—" : `${delta >= 0 ? "+" : "−"}${formatPct(Math.abs(delta))}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
