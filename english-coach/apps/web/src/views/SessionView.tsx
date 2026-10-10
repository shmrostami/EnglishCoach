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
  const socketRef = useRef<{ sendControl: (a: "start" | "end" | "mute" | "unmute") => void; quiet: () => void; teardown: () => void } | null>(null);
  const ended = useRef(false); // this session already ended (user- or server-initiated)

  useEffect(() => () => socketRef.current?.teardown(), []);

  async function start() {
    ended.current = false;
    setTranscript(initialTranscript()); // a fresh session starts with a clean transcript
    setNote("");
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
      else if (m.t === "intervention") setNote(`[${m.kind}] ${m.skill}`);
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
