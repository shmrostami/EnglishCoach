import { useEffect, useRef, useState } from "react";
import { api } from "../api/client.js";
import { createCapture, type Capture } from "../audio/capture.js";
import { createPlayer, type Player } from "../audio/player.js";
import { SessionSocket } from "../audio/wsClient.js";
import { initialTranscript, applyTranscript, type TranscriptState } from "../state/transcript.js";

// The live state chip: server states read as plain words; "ended:<reason>"
// is the quiet local close the client sees before the server's session_ended.
function stateLabel(state: string): string {
  if (state === "idle") return "Ready";
  if (state.startsWith("ended:")) return "Ended";
  return state;
}

function formatClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const WAVE_BARS = 11;

export function SessionView() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [state, setState] = useState("idle");
  const [transcript, setTranscript] = useState<TranscriptState>(initialTranscript());
  const [note, setNote] = useState("");
  const [seconds, setSeconds] = useState(0);
  const socketRef = useRef<{ sendControl: (a: "start" | "end" | "mute" | "unmute") => void; quiet: () => void; teardown: () => void } | null>(null);
  const ended = useRef(false); // this session already ended (user- or server-initiated)
  const startTs = useRef(0);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const isLive = sessionId !== null;

  useEffect(() => () => socketRef.current?.teardown(), []);

  // The on-air clock ticks only while a session is running.
  useEffect(() => {
    if (!isLive) return;
    const id = setInterval(() => setSeconds(Math.floor((Date.now() - startTs.current) / 1000)), 1000);
    return () => clearInterval(id);
  }, [isLive]);

  // The transcript scrolls to the newest turn as the conversation grows.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript.turns.length]);

  async function start() {
    ended.current = false;
    setNote("");
    setSeconds(0);
    startTs.current = Date.now();
    setTranscript(initialTranscript()); // a fresh session starts with a clean transcript
    const created = await api.createSession();
    setSessionId(created.sessionId);
    setState("STARTING");
    const ws = new WebSocket(`${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws/session/${created.sessionId}`);
    // A socket's onclose fires asynchronously, so a previous session's close
    // event can land after the NEXT session has started. Every handler must
    // check the socket is still the current one before touching shared state,
    // or a stale close wipes the new session's state and sessionId.
    const live = () => socketRef.current === stopper;
    // The server starts streaming the moment the socket connects, so the
    // message handler and socketRef must be in place SYNCHRONOUSLY here —
    // before any await — or the early transcript frames are dropped while
    // createCapture() is still blocked on the mic-permission prompt.
    // Hoisted above stopper so an early close/audio frame (arriving in the
    // await gap before the audio objects exist) can null-chain instead of
    // throwing a TDZ ReferenceError that the WS layer would swallow.
    let player: Player | null = null;
    let capture: Capture | null = null;
    const pending: ("start" | "end" | "mute" | "unmute")[] = [];
    const stopper = {
      // Queue control sent before the socket is OPEN (flushed in onopen), so
      // an early End click can't throw InvalidStateError on a closed socket.
      sendControl: (a: "start" | "end" | "mute" | "unmute") => {
        if (ws.readyState === WebSocket.OPEN) socket.sendControl(a);
        else pending.push(a);
      },
      quiet: () => { capture?.stop(); player?.stop(); }, // silence now, keep the socket
      // Full local teardown: idempotent (audio stops are already no-ops once
      // stopped), and the stale-guard so a dead session can't tear down a
      // newer one.
      teardown: () => { if (socketRef.current === stopper) socketRef.current = null; capture?.stop(); player?.stop(); ws.close(); },
    };
    const socket = new SessionSocket(ws as never, (m) => {
      if (!live()) return;
      if (m.t === "audio") player?.playBase64(m.data, m.sampleRate);
      else if (m.t === "transcript") setTranscript((s) => applyTranscript(s, m));
      else if (m.t === "state") setState(m.state);
      else if (m.t === "intervention") setNote(`${m.kind === "micro_coach" ? "micro-correction" : m.kind} — ${m.skill}`);
      else if (m.t === "session_ended") { ended.current = true; setState(m.state); if (m.reason) setNote(`Session ended: ${m.reason}`); setSessionId(null); stopper.teardown(); }
    }, (reason) => { if (!live()) return; if (!ended.current) setState(`ended:${reason}`); setSessionId(null); stopper.teardown(); });
    ws.onopen = () => { for (const a of pending.splice(0)) socket.sendControl(a); };
    socketRef.current = stopper;
    // Audio setup comes after: it may block on the mic-permission prompt for
    // seconds, and the transcript must already be captured by then. If the
    // session ends while the prompt is up, close what we created and bail out
    // before resuming an already-closed AudioContext (InvalidStateError).
    // ended.current is set synchronously by end(); re-checking it after each
    // await stops us from resuming an AudioContext the user already closed.
    player = await createPlayer();
    if (!live() || ended.current) { player.stop(); return; }
    await player.start();
    try {
      capture = await createCapture(16000);
    } catch {
      // Mic permission denied (getUserMedia rejects). Coach audio and the
      // transcript still work — keep the session, just note the missing mic.
      // (The player's AudioContext is closed by teardown when the session ends.)
      if (live() && !ended.current) setNote("Microphone unavailable — you can hear and read the coach, but you can't speak.");
      return;
    }
    if (!live() || ended.current) { capture.stop(); player.stop(); return; }
    await capture.start((pcm) => socket.sendAudio(pcm)); // tested base64 path
    if (!live() || ended.current) { capture.stop(); player.stop(); return; }
    stopper.sendControl("start");
  }

  // The socket is the session's lifecycle owner: `control:end` is the one
  // message that makes the server finish the session (analysis, cleanup,
  // closing our socket). REST `POST /end` only flips DB state and would
  // orphan the bridge/provider — so the client ends here, not over HTTP.
  async function end() {
    const stopper = socketRef.current;
    if (!stopper || ended.current || !sessionId) return;
    ended.current = true;
    setSessionId(null); // a new session can start while this one winds down
    stopper.sendControl("end");
    stopper.quiet(); // silence the mic + playback now; the server closes the socket
  }

  return (
    <section className="ec-session">
      <h1 className="ec-h1">Let's talk</h1>
      <p className="ec-lede">Speak freely — your coach listens, nudges, and remembers what to work on next.</p>

      <div className="ec-stage">
        <div className="ec-stage__head">
          <span className={"ec-live" + (isLive ? " is-live" : " is-idle")}>
            <span className="ec-live__dot" aria-hidden="true" />
            <span className="ec-live__state">{stateLabel(state)}</span>
          </span>
          {isLive && <span className="ec-timer">{formatClock(seconds)}</span>}
        </div>

        <div className={"ec-wave" + (isLive ? " is-live" : "")} aria-hidden="true">
          {Array.from({ length: WAVE_BARS }).map((_, i) => (
            <span key={i} className="ec-bar" style={{ height: `${[14, 22, 30, 24, 38, 44, 38, 24, 30, 22, 14][i]}px` }} />
          ))}
        </div>

        <div className="ec-actions">
          <button className="ec-btn ec-btn--primary" onClick={start} disabled={!!sessionId}>Start speaking</button>
          <button className="ec-btn" onClick={end} disabled={!sessionId}>End session</button>
        </div>

        {note && <p className="ec-intervention">{note}</p>}
      </div>

      <div className="ec-transcript" ref={transcriptRef}>
        {transcript.turns.length === 0 && (
          <p className="ec-empty">{isLive ? "The conversation is starting…" : "Say hello and the transcript will appear here."}</p>
        )}
        {transcript.turns.map((t) => (
          <div key={t.seq} className={"ec-turn " + (t.speaker === "learner" ? "is-learner" : "is-coach")}>
            <span className="ec-turn__name">{t.speaker === "learner" ? "You" : "Coach"}</span>
            <span className="ec-turn__text">{t.text}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
