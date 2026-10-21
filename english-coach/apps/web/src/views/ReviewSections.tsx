import { useEffect, useState } from "react";
import { api, type ErrorPattern, type ReviewQueueItem } from "../api/client.js";

function formatPct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/**
 * Recurring errors and the vocabulary due for review (spec §11.1 "Review").
 * Rendered inside the review screen, so a correction seen once and a pattern
 * seen across sessions sit next to each other.
 */
export function ReviewSections() {
  const [patterns, setPatterns] = useState<ErrorPattern[] | null>(null);
  const [queue, setQueue] = useState<ReviewQueueItem[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [note, setNote] = useState("");

  const load = () => {
    const fail = () => setLoadFailed(true);
    void api.errors().then((r) => setPatterns(r.patterns)).catch(fail);
    void api.reviewQueue().then(setQueue).catch(fail);
  };
  useEffect(load, []);

  async function answer(item: ReviewQueueItem, outcome: "correct" | "incorrect") {
    try {
      const res = await api.recordReview(item.word, { outcome, promptType: item.promptType });
      setNote(`“${item.word}” — next review in ${res.intervalDays} day${res.intervalDays === 1 ? "" : "s"}.`);
      // Drop the answered word; the server may still consider others due.
      setQueue((q) => (q ?? []).filter((x) => x.word !== item.word));
    } catch {
      setNote("That answer didn't save — try again.");
    }
  }

  // Errors that are still active; a retired pattern is history, not a to-do.
  const active = (patterns ?? []).filter((p) => p.status === "active");

  return (
    <>
      {loadFailed && (
        <p className="ec-loadfail" role="alert">Review data didn't load — check that the server is running and refresh.</p>
      )}

      <div className="section">
        <h2 className="section__title">Recurring errors</h2>
        {patterns === null ? (
          <p className="ec-empty">Loading…</p>
        ) : active.length === 0 ? (
          <p className="ec-empty">No recurring errors tracked yet — patterns appear once the same mistake shows up repeatedly.</p>
        ) : (
          <ul className="ec-review__list">
            {active.map((p) => (
              <li key={p.id} className="ec-review__correction">
                <div className="ec-review__meta">
                  <span className="ec-chip">{p.skill}</span>
                  <span className={"ec-trend ec-trend--" + (p.trend ?? "unknown")}>
                    {p.trend === null ? "not enough evidence for a trend" : p.trend}
                  </span>
                </div>
                <div className="ec-review__original">{p.pattern.replace(/_/g, " ")}</div>
                {p.description && <div className="ec-review__explanation">{p.description}</div>}
                {p.example && (
                  <>
                    <div className="ec-review__original">{p.example.original}</div>
                    {/* Null when no grounded replacement could be derived. */}
                    {p.example.suggested && <div className="ec-review__suggested">{p.example.suggested}</div>}
                  </>
                )}
                <div className="ec-review__meta">
                  <span>seen {p.frequency}×</span>
                  <span>{p.effectiveFrequency} recent</span>
                  <span>{formatPct(p.confidence)} confidence</span>
                  <span>last {new Date(p.lastSeenAt).toLocaleDateString()}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="section">
        <h2 className="section__title">Due for review</h2>
        {queue === null ? (
          <p className="ec-empty">Loading…</p>
        ) : queue.length === 0 ? (
          <p className="ec-empty">Nothing due right now — words come back here as their review date arrives.</p>
        ) : (
          <ul className="ec-review__list">
            {queue.map((item) => (
              <li key={item.word} className="ec-review__item">
                <span className="ec-review__suggested">{item.word}</span>
                <span className="ec-chip">{item.promptType}</span>
                <button className="ec-btn ec-btn--sm" onClick={() => void answer(item, "correct")}>I knew it</button>
                <button className="ec-btn ec-btn--sm" onClick={() => void answer(item, "incorrect")}>I forgot</button>
              </li>
            ))}
          </ul>
        )}
        {/* Outside the branch above: answering the last due word empties the
            queue, and a confirmation that vanished with it would read as a
            failed save. */}
        {note && <p className="ec-review__note" role="status">{note}</p>}
      </div>
    </>
  );
}
