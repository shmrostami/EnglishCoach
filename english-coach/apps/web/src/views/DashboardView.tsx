import { useEffect, useState } from "react";
import { api } from "../api/client.js";

interface SkillRow { code: string; mastery: number; confidence: number; trend: string; observation_count: number; }
// The API sends plan targets as PARSED arrays (the route JSON.parse's the
// stored JSON before responding) — this row must mirror the wire, not the DB.
interface PlanRow { difficulty: number; primaryTargets: string[]; secondaryTargets: string[] | null; topic: string | null; reasoning: string | null; }

export function DashboardView() {
  const [profile, setProfile] = useState<Record<string, unknown> | null>(null);
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [plan, setPlan] = useState<PlanRow | null>(null);
  const [progress, setProgress] = useState<Array<Record<string, unknown>>>([]);

  useEffect(() => {
    void api.profile().then(setProfile).catch(() => {});
    void api.skills().then((s) => setSkills(s as unknown as SkillRow[])).catch(() => {});
    void api.plan().then((p) => setPlan(p as unknown as PlanRow | null)).catch(() => {});
    void api.progress().then(setProgress).catch(() => {});
  }, []);

  const primary = plan && Array.isArray(plan.primaryTargets) ? plan.primaryTargets : [];
  const secondary = plan?.secondaryTargets && Array.isArray(plan.secondaryTargets) ? plan.secondaryTargets : [];

  return (
    <div>
      <h1>Progress</h1>
      {profile && (
        <p>
          Level: <strong>{String(profile.estimatedLevel ?? "—")}</strong>{" "}
          (confidence {Math.round(((profile.estimatedLevelConfidence as number) ?? 0) * 100)}%)
        </p>
      )}
      <h3>Skill mastery</h3>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr><th>Skill</th><th>Mastery</th><th>Trend</th><th>Obs</th></tr></thead>
        <tbody>
          {skills.map((s) => (
            <tr key={s.code} style={{ borderTop: "1px solid #eee" }}>
              <td>{s.code}</td>
              <td>{Math.round(s.mastery * 100)}%</td>
              <td>{s.trend}</td>
              <td>{s.observation_count}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {plan && (
        <div style={{ marginTop: 24 }}>
          <h3>Active plan</h3>
          <p>Topic: {plan.topic ?? "—"}</p>
          <p>Primary: {primary.join(", ") || "—"}</p>
          <p>Secondary: {secondary.join(", ") || "—"}</p>
          <p>Difficulty: {Math.round(plan.difficulty * 100)}%</p>
        </div>
      )}
      <h3>Last sessions</h3>
      <ul>{progress.map((p) => <li key={String(p.id)}>{String(p.topic ?? "—")} — overall {String(p.overall ?? "—")}</li>)}</ul>
    </div>
  );
}
