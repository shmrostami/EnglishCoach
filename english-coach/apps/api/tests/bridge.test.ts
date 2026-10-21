import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { openDb, db, migrate, ensureSeed } from "@ec/db";
import { LEARNER_ID } from "@ec/domain";
import { SessionService } from "../src/services/session.js";
import { RealtimeBridge, type ServerMessage } from "../src/realtime/bridge.js";
import { MockSpeechProvider, type MockTurn } from "@ec/openai";

const SESSION_SCRIPT: MockTurn[] = [
  { speaker: "coach", text: "Hi! How was your week?", pauseMs: 30 },
  { speaker: "learner", text: "Yesterday I go to work by train.", pauseMs: 30 },
  { speaker: "coach", text: "Almost. Try again with 'went'.", pauseMs: 30 },
  { speaker: "learner", text: "Yesterday I went to work by train.", pauseMs: 30,
    toolCall: { name: "request_target_retry", skill: "grammar.past_tense" } },
  { speaker: "coach", text: "Good. What did you do at work?", pauseMs: 30 },
];

function setup() {
  const sqlite = openDb(":memory:");
  migrate(sqlite);
  ensureSeed(sqlite);
  const service = new SessionService(db(sqlite));
  const session = service.createSession(LEARNER_ID, Date.now());
  return { sqlite, service, session };
}

function fakeClient() {
  const sent: ServerMessage[] = [];
  return {
    sent,
    send: (msg: string) => { sent.push(JSON.parse(msg) as ServerMessage); },
    readyState: 1,
    on: () => { /* fake client: no socket event handlers */ },
    close: () => { /* fake client: no real socket to close */ },
  };
}

/**
 * Wait for a condition instead of a fixed number of milliseconds. The mock
 * provider plays its script on timers, so under load a hardcoded 400 ms could
 * land before the script had finished — which looked like a state-machine bug.
 */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** How many coach turns the client has received so far. */
function coachTurns(client: { sent: ServerMessage[] }): number {
  return client.sent.filter((m) => m.t === "transcript" && m.speaker === "coach").length;
}

/**
 * Provider seam that counts connect() calls and never closes on its own, so
 * re-attach behavior is observable (the MockSpeechProvider re-plays its script
 * on every connect, which masks a double-connect).
 */
function countingProvider() {
  let connectCalls = 0;
  const close = { n: 0 };
  const provider = {
    connect: async () => { connectCalls += 1; },
    sendAudio: () => {},
    sendInstruction: () => {},
    close: () => { close.n += 1; },
  };
  return {
    provider,
    connectCalls: () => connectCalls,
    closeCalls: () => close.n,
  };
}

describe("RealtimeBridge", () => {
  let service: SessionService;
  let sessionId: string;
  let sqlite: Database.Database;

  beforeEach(() => {
    const s = setup();
    service = s.service;
    sessionId = s.session.id;
    sqlite = s.sqlite;
  });

  it("starts in WARMUP, moves to CONVERSATION on first learner utterance", async () => {
    const client = fakeClient();
    const provider = new MockSpeechProvider({ turns: SESSION_SCRIPT, autoClose: false });
    const bridge = new RealtimeBridge({
      sessionId, provider, service,
      learnerContext: service.getLearnerContext(sessionId),
      difficulty: 0.5,
      warmupMs: 10, sessionTargetMs: 999_999,
      onEnded: () => {},
    });
    expect(bridge.attach(client as never)).toBe(true);
    expect(bridge.state).toBe("WARMUP");
    // The script ends on a coach turn, and the state is CONVERSATION again by
    // then (it passes through TARGET_RETRY in the middle). Waiting for the
    // whole script is what makes the final state deterministic.
    await waitFor(
      () => bridge.state === "CONVERSATION" && coachTurns(client) === 3,
      "the script to finish in CONVERSATION",
    );
    expect(bridge.state).toBe("CONVERSATION");
    const learnerMsgs = client.sent.filter((m) => m.t === "transcript" && m.speaker === "learner");
    expect(learnerMsgs).toHaveLength(2);
    bridge.destroy("test");
  });

  it("logs intervention and transitions on tool_call (Review Focus 2 partial)", async () => {
    const client = fakeClient();
    const provider = new MockSpeechProvider({ turns: SESSION_SCRIPT, autoClose: false });
    const bridge = new RealtimeBridge({
      sessionId, provider, service,
      learnerContext: service.getLearnerContext(sessionId),
      difficulty: 0.5, warmupMs: 10, sessionTargetMs: 999_999, onEnded: () => {},
    });
    bridge.attach(client as never);
    await waitFor(
      () => client.sent.some((m) => m.t === "intervention" && m.kind === "target_retry") && bridge.state === "CONVERSATION",
      "the intervention and the return to CONVERSATION",
    );
    expect(client.sent.some((m) => m.t === "intervention" && m.kind === "target_retry" && m.skill === "grammar.past_tense")).toBe(true);
    // state passed through TARGET_RETRY and back to CONVERSATION
    expect(bridge.state).toBe("CONVERSATION");
    bridge.destroy("test");
  });

  it("writes a live intervention to `interventions`, not to `observations` (spec §23)", async () => {
    const client = fakeClient();
    const provider = new MockSpeechProvider({ turns: SESSION_SCRIPT, autoClose: false });
    const bridge = new RealtimeBridge({
      sessionId, provider, service,
      learnerContext: service.getLearnerContext(sessionId),
      difficulty: 0.5, warmupMs: 10, sessionTargetMs: 999_999, onEnded: () => {},
    });
    bridge.attach(client as never);
    await waitFor(
      () => client.sent.some((m) => m.t === "intervention") && coachTurns(client) === 3,
      "the intervention and the end of the script",
    );
    const interventions = sqlite.prepare("SELECT kind, skill_code FROM interventions WHERE session_id = ?").all(sessionId);
    expect(interventions).toEqual([{ kind: "target_retry", skill_code: "grammar.past_tense" }]);
    const obs = sqlite.prepare("SELECT COUNT(*) AS n FROM observations WHERE session_id = ?").get(sessionId) as { n: number };
    expect(obs.n).toBe(0);
    bridge.destroy("test");
  });

  it("rejects a second simultaneous client (Review Focus 4)", async () => {
    const provider = new MockSpeechProvider({ turns: [], autoClose: false });
    const bridge = new RealtimeBridge({
      sessionId, provider, service,
      learnerContext: service.getLearnerContext(sessionId),
      difficulty: 0.5, warmupMs: 10, sessionTargetMs: 999_999, onEnded: () => {},
    });
    expect(bridge.attach(fakeClient() as never)).toBe(true);
    expect(bridge.attach(fakeClient() as never)).toBe(false);
    bridge.destroy("test");
  });

  it("re-attaches after a client drops", async () => {
    const provider = new MockSpeechProvider({ turns: [], autoClose: false });
    const bridge = new RealtimeBridge({
      sessionId, provider, service,
      learnerContext: service.getLearnerContext(sessionId),
      difficulty: 0.5, warmupMs: 10, sessionTargetMs: 999_999, onEnded: () => {},
    });
    const first = fakeClient();
    expect(bridge.attach(first as never)).toBe(true);
    bridge.detach();                    // simulate network blip
    const second = fakeClient();
    expect(bridge.attach(second as never)).toBe(true);
    bridge.destroy("test");
  });

  function closeableClient() {
    const sent: ServerMessage[] = [];
    const handlers: Record<string, (...a: never[]) => void> = {};
    const socket = {
      sent,
      send: (msg: string) => { sent.push(JSON.parse(msg) as ServerMessage); },
      readyState: 1,
      on: (ev: string, cb: (...a: never[]) => void) => { handlers[ev] = cb; },
      close: () => { /* fake socket: no real teardown */ },
      // fire the handlers the bridge registered (e.g. "close" on socket drop)
      emit: (ev: string) => handlers[ev]?.(),
    };
    return socket;
  }

  it("re-attaches to the live provider without reconnecting it (Review Focus 4)", async () => {
    const { provider, connectCalls } = countingProvider();
    const bridge = new RealtimeBridge({
      sessionId, provider, service,
      learnerContext: service.getLearnerContext(sessionId),
      difficulty: 0.5, warmupMs: 999_999, sessionTargetMs: 999_999, onEnded: () => {},
    });
    const first = closeableClient();
    expect(bridge.attach(first as never)).toBe(true);
    expect(connectCalls()).toBe(1);
    (first as { emit: (ev: string) => void }).emit("close"); // network blip: socket closes
    expect(bridge.hasClient()).toBe(false);
    const second = closeableClient();
    expect(bridge.attach(second as never)).toBe(true);
    expect(connectCalls()).toBe(1); // provider connection reused, not re-opened
    expect(second.sent.at(-1)).toEqual({ t: "state", state: "WARMUP" }); // state resumes for the re-attaching client
    bridge.destroy("test");
  });

  it("a closing client socket does not close the provider (reconnect window)", async () => {
    const { provider, closeCalls } = countingProvider();
    const bridge = new RealtimeBridge({
      sessionId, provider, service,
      learnerContext: service.getLearnerContext(sessionId),
      difficulty: 0.5, warmupMs: 999_999, sessionTargetMs: 999_999, onEnded: () => {},
    });
    const socket = closeableClient();
    bridge.attach(socket as never);
    (socket as { emit: (ev: string) => void }).emit("close");
    expect(closeCalls()).toBe(0); // the upstream session stays alive for a reconnect
    bridge.destroy("test");
    expect(closeCalls()).toBe(1); // teardown is the only thing that closes it
  });

  it("marks the session FAILED and notifies the client if the provider drops mid-session (Review Focus 2)", async () => {
    const client = fakeClient();
    // autoClose=true so the mock fires `closed` right after a single turn
    const provider = new MockSpeechProvider({ turns: [
      { speaker: "coach", text: "Hello?", pauseMs: 20 },
    ] });
    let endedState: string | null = null;
    const bridge = new RealtimeBridge({
      sessionId, provider, service,
      learnerContext: service.getLearnerContext(sessionId),
      difficulty: 0.5, warmupMs: 999_999, sessionTargetMs: 999_999,
      onEnded: () => { endedState = "ANALYZING"; },
    });
    bridge.attach(client as never);
    await waitFor(() => bridge.state === "FAILED", "the provider drop"); // script runs out -> provider closed
    expect(bridge.state).toBe("FAILED");
    expect(client.sent.some((m) => m.t === "session_ended" && m.state === "FAILED")).toBe(true);
    expect(endedState).toBeNull(); // no analysis job for a FAILED session
    bridge.destroy("test");
  });
});
