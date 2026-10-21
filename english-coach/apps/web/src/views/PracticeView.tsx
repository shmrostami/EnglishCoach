import { useEffect, useState } from "react";
import { api, type Activity, type DiagnosticResult, type Objective } from "../api/client.js";

function formatPct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/**
 * Practice (spec §11.1 Practice/Lessons, backlog items 11–12): a diagnostic
 * the learner takes once, the objectives it seeds, and the activity the engine
 * recommends for the top objective.
 */
export function PracticeView() {
  const [diagnostic, setDiagnostic] = useState<DiagnosticResult | null | undefined>(undefined);
  const [objectives, setObjectives] = useState<Objective[]>([]);
  const [rec, setRec] = useState<{ activity: Activity | null; reason: string } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [note, setNote] = useState("");

  // Diagnostic form state.
  const [comfort, setComfort] = useState(0.5);
  const [grammar, setGrammar] = useState(0.5);
  const [frequency, setFrequency] = useState(3);
  const [focus, setFocus] = useState("");

  const load = () => {
    void api.diagnostic().then((r) => setDiagnostic(r.diagnostic)).catch(() => setLoadFailed(true));
    void api.objectives().then(setObjectives).catch(() => setLoadFailed(true));
    void api.recommendedActivity().then(setRec).catch(() => setLoadFailed(true));
  };
  useEffect(load, []);

  async function takeDiagnostic() {
    setNote("");
    try {
      const result = await api.runDiagnostic({
        speakingComfort: comfort,
        grammarConfidence: grammar,
        weeklySpeakingFrequency: frequency,
        focusSkills: focus.split(",").map((s) => s.trim()).filter(Boolean),
      });
      setDiagnostic(result);
      // The placement seeds a first objective so the learner has something to
      // practise immediately, rather than an empty practice screen.
      if (objectives.length === 0) {
        await api.addObjective({
          title: result.focusSkills[0] ?? "Speak more comfortably",
          description: `Starting objective from your ${result.band} placement.`,
          skillCodes: result.focusSkills,
          priority: 0.8,
        });
      }
      load();
    } catch (e) {
      setNote(`Couldn't save your placement: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  }

  async function start() {
    if (!rec?.activity) return;
    try {
      const attempt = await api.startAttempt(rec.activity.id);
      setNote(`Attempt started (${attempt.status}). Speak in a session, then submit it here.`);
    } catch {
      setNote("Couldn't start the activity — try again.");
    }
  }

  if (diagnostic === undefined) {
    return (
      <section>
        <h1 className="ec-h1">Practice</h1>
        <p className="ec-empty">Loading…</p>
      </section>
    );
  }

  return (
    <section>
      <h1 className="ec-h1">Practice</h1>
      <p className="ec-lede">A short placement, then one focused activity based on what you want to work on.</p>
      {loadFailed && (
        <p className="ec-loadfail" role="alert">Some practice data didn't load — check that the server is running and refresh.</p>
      )}

      <div className="section">
        <h2 className="section__title">Placement</h2>
        {diagnostic ? (
          <>
            <p className="ec-plan__topic">Starting level {diagnostic.band}</p>
            <p className="ec-review__note">
              Based on your own answers, not a measurement — confidence {formatPct(diagnostic.confidence)}.
              Your level updates as you actually speak.
            </p>
            {diagnostic.focusSkills.length > 0 && (
              <div className="ec-plan__targets">
                {diagnostic.focusSkills.map((s) => <span key={s} className="ec-chip">{s}</span>)}
              </div>
            )}
          </>
        ) : (
          <form className="ec-form" onSubmit={(e) => { e.preventDefault(); void takeDiagnostic(); }}>
            <p className="ec-empty" style={{ marginTop: 0 }}>
              Three questions. This places you, it doesn't score you.
            </p>
            <label className="ec-form__row">
              <span>Comfort speaking English ({formatPct(comfort)})</span>
              <input type="range" min={0} max={1} step={0.05} value={comfort}
                onChange={(e) => setComfort(Number(e.target.value))} />
            </label>
            <label className="ec-form__row">
              <span>Confidence in grammar ({formatPct(grammar)})</span>
              <input type="range" min={0} max={1} step={0.05} value={grammar}
                onChange={(e) => setGrammar(Number(e.target.value))} />
            </label>
            <label className="ec-form__row">
              <span>Days a week you speak English</span>
              <input className="ec-field" type="number" min={0} max={7} value={frequency}
                onChange={(e) => setFrequency(Number(e.target.value))} />
            </label>
            <label className="ec-form__row">
              <span>What to focus on</span>
              <input className="ec-field" placeholder="e.g. fluency.continuity, grammar.past_tense"
                value={focus} onChange={(e) => setFocus(e.target.value)} />
            </label>
            <button type="submit" className="ec-btn ec-btn--primary">Get my starting point</button>
          </form>
        )}
        {note && <p className="ec-review__note" role="status">{note}</p>}
      </div>

      <div className="section">
        <h2 className="section__title">Recommended activity</h2>
        {rec === null ? (
          <p className="ec-empty">Loading…</p>
        ) : rec.activity ? (
          <div className="ec-plan">
            <p className="ec-plan__topic">{rec.activity.title}</p>
            {rec.activity.prompt && <p className="ec-review__note">{rec.activity.prompt}</p>}
            <div className="ec-plan__targets">
              {rec.activity.targetSkillCodes.map((s) => <span key={s} className="ec-chip">{s}</span>)}
              {rec.activity.targetWords.map((w) => <span key={w} className="ec-chip">{w}</span>)}
            </div>
            <p className="ec-plan__meta">
              {rec.activity.estimatedMinutes} min · difficulty {formatPct(rec.activity.difficulty)} · {rec.reason}
            </p>
            <button className="ec-btn ec-btn--primary" onClick={() => void start()}>Start activity</button>
          </div>
        ) : (
          // No objective is a valid empty state, not an error.
          <p className="ec-empty">{rec.reason}</p>
        )}
      </div>

      {objectives.length > 0 && (
        <div className="section">
          <h2 className="section__title">Objectives</h2>
          <ul className="ec-review__list">
            {objectives.map((o) => (
              <li key={o.id} className="ec-review__item">
                <span className="ec-review__suggested">{o.title}</span>
                <span className="ec-chip">{o.status}</span>
                <span className="ec-review__note">{o.description}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
