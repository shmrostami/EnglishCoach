import { useEffect, useState } from "react";
import { api, type Milestone } from "../api/client.js";

interface GoalRow {
  id: string;
  type: string;
  description: string;
  priority: number;
  status: string;
}

export function GoalsView() {
  const [goals, setGoals] = useState<GoalRow[]>([]);
  const [type, setType] = useState("");
  const [desc, setDesc] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const [openGoal, setOpenGoal] = useState<string | null>(null);
  const [milestones, setMilestones] = useState<Record<string, Milestone[]>>({});
  const [suggested, setSuggested] = useState<Record<string, { title: string; targetSkillCode: string; targetMastery: number }[]>>({});
  const [milestoneNote, setMilestoneNote] = useState("");

  async function openMilestones(goalId: string) {
    setMilestoneNote("");
    setOpenGoal(openGoal === goalId ? null : goalId);
    if (milestones[goalId]) return;
    try {
      const r = await api.milestones(goalId);
      setMilestones((m) => ({ ...m, [goalId]: r.milestones }));
      setSuggested((s) => ({ ...s, [goalId]: r.suggested }));
    } catch {
      setMilestoneNote("Milestones didn't load — try again.");
    }
  }

  async function addMilestone(goalId: string, m: { title: string; targetSkillCode?: string; targetMastery?: number }) {
    try {
      await api.addMilestone(goalId, m);
      const r = await api.milestones(goalId);
      setMilestones((all) => ({ ...all, [goalId]: r.milestones }));
      setSuggested((all) => ({ ...all, [goalId]: r.suggested }));
    } catch {
      setMilestoneNote("Couldn't add that milestone.");
    }
  }

  const refresh = () => void api.goals().then((g) => setGoals(g as unknown as GoalRow[])).catch(() => setLoadFailed(true));
  useEffect(() => { refresh(); }, []);

  async function add() {
    if (!type || !desc) return;
    await api.addGoal({ type, description: desc, priority: 0.5 });
    setType("");
    setDesc("");
    refresh();
  }

  return (
    <section className="ec-goals-view">
      <h1 className="ec-h1">Your goals</h1>
      <p className="ec-lede">Tell the coach what you want to get better at — it shapes every session.</p>
      {loadFailed && (
        <p className="ec-loadfail" role="alert">Goals didn't load — check that the server is running and refresh.</p>
      )}

      <div className="ec-goals">
        {goals.length === 0 && <p className="ec-empty">No goals yet. Add one below.</p>}
        {goals.map((g) => (
          <div key={g.id} className={"ec-goal" + (g.status === "completed" ? " is-done" : "")}>
            <div>
              <div className="ec-goal__head">
                <span className="ec-goal__type">{g.type}</span>
              </div>
              <p className="ec-goal__desc">{g.description}</p>
            </div>
            <div className="ec-goal__foot">
              {g.status === "completed"
                ? <span className="ec-chip">done</span>
                : (
                  <>
                    <span className="ec-goal__meta">priority {Math.round(g.priority * 100)}%</span>
                    <button className="ec-btn ec-btn--sm" onClick={() => void openMilestones(g.id)}>
                      {openGoal === g.id ? "Hide steps" : "Steps"}
                    </button>
                    <button className="ec-btn ec-btn--sm" onClick={() => void api.patchGoal(g.id, { status: "completed" }).then(refresh)}>Complete</button>
                  </>
                )}
            </div>
            {openGoal === g.id && (
              <div className="ec-goal__milestones">
                {(milestones[g.id] ?? []).length === 0 ? (
                  <p className="ec-empty">No steps yet — add one from the suggestions.</p>
                ) : (
                  <ul className="ec-review__list">
                    {(milestones[g.id] ?? []).map((m) => (
                      <li key={m.id} className="ec-review__item">
                        <span className="ec-review__suggested">{m.title}</span>
                        <span className="ec-chip">{m.status}</span>
                        {m.targetSkillCode && <span className="ec-review__note">{m.targetSkillCode}</span>}
                      </li>
                    ))}
                  </ul>
                )}
                {(suggested[g.id] ?? []).length > 0 && (
                  <>
                    <p className="ec-review__note">Suggested from your weakest skills:</p>
                    {suggested[g.id].map((sug) => (
                      <button key={sug.targetSkillCode} className="ec-btn ec-btn--sm"
                        onClick={() => void addMilestone(g.id, sug)}>
                        + {sug.title}
                      </button>
                    ))}
                  </>
                )}
                {milestoneNote && <p className="ec-review__note" role="status">{milestoneNote}</p>}
              </div>
            )}
          </div>
        ))}
      </div>

      <form
        className="ec-form"
        onSubmit={(e) => { e.preventDefault(); void add(); }}
      >
        <div className="ec-form__row">
          <input className="ec-field" placeholder="Focus — e.g. fluency, grammar, vocabulary" value={type} onChange={(e) => setType(e.target.value)} aria-label="Goal focus" />
          <input className="ec-field" placeholder="What do you want to achieve?" value={desc} onChange={(e) => setDesc(e.target.value)} aria-label="Goal description" />
        </div>
        <button type="submit" className="ec-btn ec-btn--primary" disabled={!type || !desc}>Add goal</button>
      </form>
    </section>
  );
}
