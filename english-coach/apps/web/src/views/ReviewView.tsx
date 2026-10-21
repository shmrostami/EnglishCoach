import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  api, type FeedbackResponse, type SessionFeedback, type PronunciationAssessment,
} from "../api/client.js";
import { ReviewSections } from "./ReviewSections.js";

const DIMENSION_LABEL: Record<string, string> = {
  fluency: "Fluency", grammar: "Grammar", vocabulary: "Vocabulary",
  pronunciation: "Pronunciation", coherence: "Coherence", interaction: "Interaction",
};

function formatPct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/**
 * Post-session review (spec §11.3). `/review` shows the newest completed
 * session; `/review/:sessionId` shows a specific one, so the review survives
 * leaving the session screen (spec §5 Phase 1 acceptance criteria).
 */
export function ReviewView() {
  const { sessionId } = useParams<{ sessionId?: string }>();
  const [data, setData] = useState<FeedbackResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pronunciation, setPronunciation] = useState<PronunciationAssessment | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    void (async () => {
      try {
        // No list endpoint for sessions: /progress already returns the last ten
        // completed ones oldest→newest, so the newest is its last element.
        const id = sessionId ?? (await api.progress() as unknown as { id: string }[]).at(-1)?.id;
        if (cancelled) return;
        if (!id) { setData(null); return; }
        const res = await api.feedback(id);
        if (cancelled) return;
        setData(res);
        // The pronunciation assessment exists only when there was audio to
        // measure, so a null here is the honest "not assessed" answer.
        try {
          const p = await api.pronunciation(id);
          if (!cancelled) setPronunciation(p.pronunciation);
        } catch {
          if (!cancelled) setPronunciation(null);
        }
      } catch {
        if (!cancelled) setLoadFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId]);

  if (loading) return <section className="ec-review"><p className="ec-empty">Loading your review…</p></section>;

  if (loadFailed) {
    return (
      <section className="ec-review">
        <h1 className="ec-h1">Review</h1>
        <p className="ec-loadfail" role="alert">Your review didn't load — check that the server is running and refresh.</p>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="ec-review">
        <h1 className="ec-h1">Review</h1>
        <p className="ec-empty">No finished session to review yet. What is already known about your learning is below.</p>
        <ReviewSections />
      </section>
    );
  }

  if (!data.feedback) {
    // Not an error: the analysis may still be running, or it may have failed.
    return (
      <section className="ec-review">
        <h1 className="ec-h1">Review</h1>
        <p className="ec-empty">
          {data.state === "FAILED"
            ? "The analysis for this session failed, so there is no review. Ask an operator to retry it."
            : `This session is still being analysed (${data.state}). Refresh in a moment.`}
        </p>
        <Link className="ec-btn" to="/">Back to speaking</Link>
      </section>
    );
  }

  return <FeedbackBody fb={data.feedback} pronunciation={pronunciation} onAction={(c, action) => {
    // Optimistic: the review is a list the learner is working through, and a
    // button that waits on a round trip feels broken. A failure reverts it.
    setData((d) => d?.feedback ? {
      ...d,
      feedback: {
        ...d.feedback,
        corrections: d.feedback.corrections.map((x) => x.id === c.id ? { ...x, learnerAction: action } : x),
      },
    } : d);
    void api.setCorrectionAction(data.feedback!.sessionId, c.id, action).catch(() => {
      setData((d) => d?.feedback ? {
        ...d,
        feedback: {
          ...d.feedback,
          corrections: d.feedback.corrections.map((x) => x.id === c.id ? { ...x, learnerAction: "pending" } : x),
        },
      } : d);
    });
  }} />;
}

function FeedbackBody({ fb, onAction, pronunciation }: {
  fb: SessionFeedback;
  onAction: (c: SessionFeedback["corrections"][number], action: "accepted" | "dismissed") => void;
  pronunciation: PronunciationAssessment | null;
}) {
  const dims = Object.keys(fb.scores);
  return (
    <section className="ec-review">
      <h1 className="ec-h1">Review</h1>
      <p className="ec-lede">{fb.topic || "Free conversation"} · {new Date(fb.startedAt).toLocaleDateString()}</p>

      <div className="section">
        <h2 className="section__title">How it went</h2>
        <div className="ec-review__dims">
          {dims.map((key) => {
            const v = fb.scores[key];
            const notAssessed = v == null;
            return (
              <div key={key} className="ec-review__dim">
                <span className="ec-review__dim-name">{DIMENSION_LABEL[key] ?? key}</span>
                <span className={"ec-review__dim-value" + (notAssessed ? " is-missing" : "")}>
                  {notAssessed ? "not assessed" : formatPct(v)}
                </span>
              </div>
            );
          })}
        </div>
        {fb.notAssessed.length > 0 && (
          <p className="ec-review__note">
            Not assessed this time: {fb.notAssessed.map((k) => DIMENSION_LABEL[k] ?? k).join(", ")}.
            We only report what the analysis can actually evidence.
          </p>
        )}
      </div>

      {pronunciation && (
        <div className="section">
          <h2 className="section__title">How it sounded</h2>
          <div className="ec-review__dims">
            {(["intelligibility", "stress", "rhythm"] as const).map((key) => (
              <div key={key} className="ec-review__dim">
                <span className="ec-review__dim-name">{key}</span>
                <span className="ec-review__dim-value">
                  {pronunciation[key] == null ? "not assessed" : formatPct(pronunciation[key]!)}
                </span>
              </div>
            ))}
          </div>
          <p className="ec-review__note">
            Measured from your audio ({pronunciation.rubricVersion}), {formatPct(pronunciation.confidence)} confidence.
            This is a prosody measurement, not a phoneme score.
          </p>
        </div>
      )}

      {fb.strengths.length > 0 && (
        <div className="section">
          <h2 className="section__title">What worked</h2>
          <ul className="ec-review__list">
            {fb.strengths.map((s, i) => (
              <li key={`${s.skill}-${i}`} className="ec-review__item">
                <span className="ec-chip">{s.skill}</span>
                <span className="ec-review__quote">“{s.evidence}”</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="section">
        <h2 className="section__title">Corrections</h2>
        {fb.corrections.length === 0 ? (
          <p className="ec-empty">No corrections from this session — nothing the analysis could confidently fix.</p>
        ) : (
          <ul className="ec-review__list">
            {fb.corrections.map((c) => (
              <li key={c.id} className="ec-review__correction">
                <div className="ec-review__original">{c.original}</div>
                {c.suggested && <div className="ec-review__suggested">{c.suggested}</div>}
                {/* No `suggested` means the wrong form was not found in the
                    quoted sentence, so no replacement is invented — the
                    explanation still names the target form. */}
                <div className="ec-review__explanation">{c.explanation}</div>
                <div className="ec-review__meta">
                  <span className="ec-chip">{c.skill}</span>
                  <span>{formatPct(c.confidence)} confidence</span>
                  {/* Persisted, so the choice survives leaving the screen. */}
                  {c.learnerAction === "pending" ? (
                    <>
                      <button className="ec-btn ec-btn--sm" onClick={() => onAction(c, "accepted")}>Got it</button>
                      <button className="ec-btn ec-btn--sm" onClick={() => onAction(c, "dismissed")}>Dismiss</button>
                    </>
                  ) : (
                    <span className={"ec-trend ec-trend--" + (c.learnerAction === "accepted" ? "improving" : "unknown")}>
                      {c.learnerAction}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {fb.vocabulary.length > 0 && (
        <div className="section">
          <h2 className="section__title">Words to keep</h2>
          <div className="ec-review__vocab">
            {fb.vocabulary.map((w) => <span key={w} className="ec-chip">{w}</span>)}
          </div>
        </div>
      )}

      <div className="section">
        <h2 className="section__title">Next session</h2>
        {fb.next ? (
          <div className="ec-plan">
            <p className="ec-plan__topic">{fb.next.topic ?? "—"}</p>
            <div className="ec-plan__targets">
              {fb.next.targets.map((t) => <span key={t} className="ec-chip">{t}</span>)}
            </div>
            {fb.next.reason && <p className="ec-plan__meta">{fb.next.reason}</p>}
          </div>
        ) : (
          <p className="ec-empty">No plan yet — the coach plans the next session after this one.</p>
        )}
      </div>

      <ReviewSections />

      <Link className="ec-btn ec-btn--primary" to="/">Speak again</Link>
    </section>
  );
}
