import { useEffect, useRef, useState } from "react";
import { api } from "../api/client.js";
import { createCapture } from "../audio/capture.js";
import { createPlayer } from "../audio/player.js";
import { SessionSocket } from "../audio/wsClient.js";
import { initialTranscript, applyTranscript, type TranscriptState } from "../state/transcript.js";

export function SessionView() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [state, setState] = useState("idle");
  const [transcript, setTranscript] = useState<TranscriptState>(initialTranscript());
  const [note, setNote] = useState("");
  const socketRef = useRef<{ stop: () => void } | null>(null);
  const busy = useRef(false); // end() teardown in flight — blocks a second End

  useEffect(() => () => socketRef.current?.stop(), []);

  async function start() {
    busy.current = false;
    const created = await api.createSession();
    setSessionId(created.sessionId);
    setState("STARTING");
    const ws = new WebSocket(`${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws/session/${created.sessionId}`);
    const player = await createPlayer();
    await player.start();
    const socket = new SessionSocket(ws as never, (m) => {
      if (m.t === "audio") player.playBase64(m.data, m.sampleRate);
      else if (m.t === "transcript") setTranscript((s) => applyTranscript(s, m));
      else if (m.t === "state") setState(m.state);
      else if (m.t === "intervention") setNote(`[${m.kind}] ${m.skill}`);
      else if (m.t === "session_ended") { setState(m.state); setSessionId(null); }
    }, (reason) => { setState(`ended:${reason}`); setSessionId(null); });
    const capture = await createCapture(16000);
    await capture.start((pcm) => socket.sendAudio(pcm)); // tested base64 path
    socket.sendControl("start");
    // One-shot: both the unmount cleanup and end() call stoppers, and
    // stopping audio contexts twice throws InvalidStateError.
    const stopper = {
      stop: () => { if (socketRef.current === stopper) socketRef.current = null; capture.stop(); player.stop(); socket.close(); },
    };
    socketRef.current = stopper;
  }

  async function end() {
    if (busy.current || !sessionId) return;
    busy.current = true;
    const id = sessionId;
    const stopper = socketRef.current;
    setSessionId(null); // start a new session while the old one winds down
    try { await api.endSession(id); } catch { /* already ended — surfaced via the socket */ }
    stopper?.stop();
  }

  return (
    <div>
      <h1>Speaking session</h1>
      <p>State: <strong>{state}</strong> {note && <span>({note})</span>}</p>
      <button onClick={start} disabled={!!sessionId}>Start</button>
      <button onClick={end} disabled={!sessionId}>End</button>
      <div style={{ marginTop: 24, maxHeight: 400, overflowY: "auto", border: "1px solid #eee", padding: 12 }}>
        {transcript.turns.map((t) => (
          <p key={t.seq} style={{ margin: "4px 0" }}>
            <strong>{t.speaker === "learner" ? "You" : "Coach"}:</strong> {t.text}
          </p>
        ))}
      </div>
    </div>
  );
}
