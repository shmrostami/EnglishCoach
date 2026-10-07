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

  useEffect(() => () => socketRef.current?.stop(), []);

  async function start() {
    const created = await api.createSession();
    setSessionId(created.sessionId);
    setState("STARTING");
    const ws = new WebSocket(`ws://127.0.0.1:3100/ws/session/${created.sessionId}`);
    const player = await createPlayer();
    await player.start();
    const socket = new SessionSocket(ws as never, (m) => {
      if (m.t === "audio") player.playBase64(m.data, m.sampleRate);
      else if (m.t === "transcript") setTranscript((s) => applyTranscript(s, m));
      else if (m.t === "state") setState(m.state);
      else if (m.t === "intervention") setNote(`[${m.kind}] ${m.skill}`);
      else if (m.t === "session_ended") setState(m.state);
    }, (reason) => setState(`ended:${reason}`));
    const capture = await createCapture(16000);
    await capture.start((pcm) => socket.sendAudio(pcm)); // tested base64 path
    socket.sendControl("start");
    socketRef.current = { stop: () => { capture.stop(); player.stop(); socket.close(); } };
  }

  async function end() {
    if (sessionId) await api.endSession(sessionId).catch(() => {});
    socketRef.current?.stop();
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
