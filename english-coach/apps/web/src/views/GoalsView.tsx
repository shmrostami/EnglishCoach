import { useEffect, useState } from "react";
import { api } from "../api/client.js";

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

  const refresh = () => void api.goals().then((g) => setGoals(g as unknown as GoalRow[])).catch(() => {});
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

      <div className="ec-goals">
        {goals.length === 0 && <p className="ec-empty">No goals yet. Add one below.</p>}
        {goals.map((g) => (
          <div key={g.id} className={"ec-goal" + (g.status === "completed" ? " is-done" : "")}>
            <div>
              <div className="ec-goal__head">
                <span className="ec-goal__type">{g.type}</span>
              </div>
              <p className="ec-goal__desc" style={{ margin: "0.4rem 0 0" }}>{g.description}</p>
            </div>
            <div style={{ textAlign: "right" }}>
              {g.status === "completed"
                ? <span className="ec-chip">done</span>
                : (
                  <>
                    <span className="ec-goal__meta">priority {Math.round(g.priority * 100)}%</span>
                    <div style={{ marginTop: 0.5 }}>
                      <button className="ec-btn ec-btn--sm" onClick={() => void api.patchGoal(g.id, { status: "completed" }).then(refresh)}>Complete</button>
                    </div>
                  </>
                )}
            </div>
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
