import { useEffect, useRef, useState } from "react";
import { api } from "../api/client.js";
import { createCapture } from "../audio/capture.js";
import { createPlayer } from "../audio/player.js";
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
    const player = await createPlayer();
    await player.start();
    const capture = await createCapture(16000);
    // A socket's onclose fires asynchronously, so a previous session's close
    // event can land after the NEXT session has started. Every handler must
    // check the socket is still the current one before touching shared state,
    // or a stale close wipes the new session's state and sessionId.
    const live = () => socketRef.current === stopper;
    const stopper = {
      sendControl: (a: "start" | "end" | "mute" | "unmute") => socket.sendControl(a),
      quiet: () => { capture.stop(); player.stop(); }, // silence now, keep the socket
      // Full local teardown: idempotent (audio stops are already no-ops once
      // stopped), and the stale-guard so a dead session can't tear down a
      // newer one.
      teardown: () => { if (socketRef.current === stopper) socketRef.current = null; capture.stop(); player.stop(); ws.close(); },
    };
    const socket = new SessionSocket(ws as never, (m) => {
      if (!live()) return;
      if (m.t === "audio") player.playBase64(m.data, m.sampleRate);
      else if (m.t === "transcript") setTranscript((s) => applyTranscript(s, m));
      else if (m.t === "state") setState(m.state);
      else if (m.t === "intervention") setNote(`${m.kind === "micro_coach" ? "micro-correction" : m.kind} — ${m.skill}`);
      else if (m.t === "session_ended") { ended.current = true; setState(m.state); setSessionId(null); stopper.teardown(); }
    }, (reason) => { if (!live()) return; if (!ended.current) setState(`ended:${reason}`); setSessionId(null); stopper.teardown(); });
    await capture.start((pcm) => socket.sendAudio(pcm)); // tested base64 path
    socket.sendControl("start");
    // Expose the stopper only once fully started, so end() can't fire in the
    // setup window (which would stop() a not-yet-started capture, then
    // start() its already-closing AudioContext → InvalidStateError).
    socketRef.current = stopper;
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
