import { useEffect, useState } from "react";
import { api, type Preferences } from "../api/client.js";

const CORRECTION_STYLES = ["gentle", "moderate", "intensive"];

/**
 * Learner preferences (spec §6.1, §11.1 Settings). These are the learner's own
 * choices and are never read as evidence of proficiency — the dashboard's level
 * estimate comes from assessment alone.
 */
export function SettingsView() {
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [style, setStyle] = useState("");
  const [minutes, setMinutes] = useState("");
  const [language, setLanguage] = useState("");
  const [accent, setAccent] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void api.preferences().then((p) => {
      setPrefs(p);
      setStyle(p.correctionStyle ?? "");
      setMinutes(p.preferredSessionMinutes == null ? "" : String(p.preferredSessionMinutes));
      setLanguage(p.preferredFeedbackLanguage ?? "");
      setAccent(p.preferredAccent ?? "");
    }).catch(() => setLoadFailed(true));
  }, []);

  async function save() {
    setSaving(true);
    setNote("");
    try {
      await api.savePreferences({
        ...(style ? { correctionStyle: style } : {}),
        ...(language ? { preferredFeedbackLanguage: language } : {}),
        ...(accent ? { preferredAccent: accent } : {}),
        // Blank means "leave it alone" — never silently send 0.
        ...(minutes ? { preferredSessionMinutes: Number(minutes) } : {}),
      });
      setNote("Saved.");
      setPrefs(await api.preferences());
    } catch (e) {
      setNote(`Couldn't save: ${e instanceof Error ? e.message : "unknown error"}`);
    } finally {
      setSaving(false);
    }
  }

  if (loadFailed) {
    return (
      <section>
        <h1 className="ec-h1">Settings</h1>
        <p className="ec-loadfail" role="alert">Settings didn't load — check that the server is running and refresh.</p>
      </section>
    );
  }

  if (prefs === null) {
    return (
      <section>
        <h1 className="ec-h1">Settings</h1>
        <p className="ec-empty">Loading…</p>
      </section>
    );
  }

  return (
    <section>
      <h1 className="ec-h1">Settings</h1>
      <p className="ec-lede">How you want to be corrected and how long you want to practise. These are your choices — they never change your assessed level.</p>

      <form className="ec-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label className="ec-form__row">
          <span>Correction style</span>
          <select className="ec-field" value={style} onChange={(e) => setStyle(e.target.value)}>
            <option value="">Not set</option>
            {CORRECTION_STYLES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="ec-form__row">
          <span>Session length (minutes)</span>
          <input className="ec-field" type="number" min={1} max={120} value={minutes}
            onChange={(e) => setMinutes(e.target.value)} />
        </label>
        <label className="ec-form__row">
          <span>Feedback language</span>
          <input className="ec-field" placeholder="e.g. fa, en" value={language}
            onChange={(e) => setLanguage(e.target.value)} />
        </label>
        <label className="ec-form__row">
          <span>Preferred accent</span>
          <input className="ec-field" placeholder="e.g. en-US" value={accent}
            onChange={(e) => setAccent(e.target.value)} />
        </label>
        <button type="submit" className="ec-btn ec-btn--primary" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </form>

      {note && <p className="ec-review__note" role="status">{note}</p>}
      {prefs.updatedAt && (
        <p className="ec-review__note">Last saved {new Date(prefs.updatedAt).toLocaleString()}.</p>
      )}
    </section>
  );
}
