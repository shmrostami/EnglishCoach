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

describe("RealtimeBridge", () => {
  let service: SessionService;
  let sessionId: string;

  beforeEach(() => {
    const s = setup();
    service = s.service;
    sessionId = s.session.id;
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
    await new Promise((r) => setTimeout(r, 400));
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
    await new Promise((r) => setTimeout(r, 500));
    expect(client.sent.some((m) => m.t === "intervention" && m.kind === "target_retry" && m.skill === "grammar.past_tense")).toBe(true);
    // state passed through TARGET_RETRY and back to CONVERSATION
    expect(bridge.state).toBe("CONVERSATION");
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
    await new Promise((r) => setTimeout(r, 300)); // script runs out -> provider closed
    expect(bridge.state).toBe("FAILED");
    expect(client.sent.some((m) => m.t === "session_ended" && m.state === "FAILED")).toBe(true);
    expect(endedState).toBeNull(); // no analysis job for a FAILED session
    bridge.destroy("test");
  });
});
