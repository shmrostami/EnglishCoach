import { useEffect, useState } from "react";
import { api } from "../api/client.js";

interface GoalRow { id: string; type: string; description: string; priority: number; status: string; }

export function GoalsView() {
  const [goals, setGoals] = useState<GoalRow[]>([]);
  const [type, setType] = useState("");
  const [desc, setDesc] = useState("");

  const refresh = () => void api.goals().then((g) => setGoals(g as unknown as GoalRow[])).catch(() => {});
  useEffect(() => { refresh(); }, []);

  async function add() {
    if (!type || !desc) return;
    await api.addGoal({ type, description: desc, priority: 0.5 });
    setType(""); setDesc("");
    refresh();
  }

  return (
    <div>
      <h1>Goals</h1>
      <ul>
        {goals.map((g) => (
          <li key={g.id}>
            [{g.type}] {g.description} (priority {g.priority}) — {g.status}
            <button onClick={() => void api.patchGoal(g.id, { status: "completed" }).then(refresh)}> Complete</button>
          </li>
        ))}
      </ul>
      <form onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <input placeholder="type (fluency/grammar/vocabulary)" value={type} onChange={(e) => setType(e.target.value)} />
        <input placeholder="description" value={desc} onChange={(e) => setDesc(e.target.value)} />
        <button type="submit">Add goal</button>
      </form>
    </div>
  );
}
