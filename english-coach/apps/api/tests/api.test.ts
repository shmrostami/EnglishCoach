import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocket } from "ws";
import { buildApp } from "../src/app.js";
import { openDb, db, migrate, ensureSeed } from "@ec/db";
import { SessionService } from "../src/services/session.js";
import { BridgeRegistry } from "../src/realtime/bridge.js";
import { MockSpeechProvider, type MockTurn, selectSpeechProvider, MOCK_DEMO_SCRIPT } from "@ec/openai";
import { LEARNER_ID } from "@ec/domain";

const SCRIPT: MockTurn[] = [
  { speaker: "coach", text: "Hello there?", pauseMs: 30 },
  { speaker: "learner", text: "Yesterday I go to the market.", pauseMs: 30 },
  { speaker: "coach", text: "Good.", pauseMs: 30 },
];

let app: Awaited<ReturnType<typeof buildApp>>;
let url: string;
let endedSessions: string[] = [];

beforeAll(async () => {
  const sqlite = openDb(":memory:");
  migrate(sqlite);
  ensureSeed(sqlite);
  const service = new SessionService(db(sqlite));
  const registry = new BridgeRegistry();
  app = await buildApp({
    service,
    db: db(sqlite),
    registry,
    selectSpeech: () => new MockSpeechProvider({ turns: SCRIPT, autoClose: false }),
    env: { PORT: 0, HOST: "127.0.0.1", DB_PATH: ":memory:", PROVIDER: "mock", WARMUP_MS: 50, SESSION_TARGET_MS: 60_000, OPENAI_API_KEY: undefined },
    queue: (type, sessionId) => { if (type === "analyze") endedSessions.push(sessionId); },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
});

afterAll(async () => { await app.close(); });

describe("HTTP API", () => {
  it("creates a session and rejects unknown learner ids", async () => {
    const ok = await app.inject({ method: "POST", url: `/v1/learners/${LEARNER_ID}/sessions` });
    expect(ok.statusCode).toBe(201);
    expect((ok.json() as { sessionId: string }).sessionId).toMatch(/^sess-/);
    const bad = await app.inject({ method: "POST", url: "/v1/learners/nobody/sessions" });
    expect(bad.statusCode).toBe(404);
  });

  it("ends a session exactly once: second end is 409 (Review Focus 3)", async () => {
    const created = (await app.inject({ method: "POST", url: `/v1/learners/${LEARNER_ID}/sessions` })).json() as { sessionId: string };
    const first = await app.inject({ method: "POST", url: `/v1/sessions/${created.sessionId}/end` });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "POST", url: `/v1/sessions/${created.sessionId}/end` });
    expect(second.statusCode).toBe(409);
    expect(endedSessions.filter((s) => s === created.sessionId)).toHaveLength(1);
  });

  it("returns session state and transcript via GET", async () => {
    const created = (await app.inject({ method: "POST", url: `/v1/learners/${LEARNER_ID}/sessions` })).json() as { sessionId: string };
    const res = await app.inject({ method: "GET", url: `/v1/sessions/${created.sessionId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("state");
  });

  it("mock mode plays the scripted demo end-to-end (README promise; the real factory wiring)", async () => {
    // This app is built the way server.ts builds it: the speech provider comes
    // from selectSpeechProvider with the demo script — not an injected literal.
    // Before the fix the server passed no script, the mock auto-closed on an
    // empty script, and every mock session ended FAILED with zero conversation.
    const sqlite = openDb(":memory:");
    migrate(sqlite);
    ensureSeed(sqlite);
    const service = new SessionService(db(sqlite));
    const registry = new BridgeRegistry();
    const local = await buildApp({
      service,
      db: db(sqlite),
      registry,
      selectSpeech: () => selectSpeechProvider({ PROVIDER: "mock", OPENAI_API_KEY: undefined }, MOCK_DEMO_SCRIPT),
      env: { PORT: 0, HOST: "127.0.0.1", DB_PATH: ":memory:", PROVIDER: "mock", WARMUP_MS: 50, SESSION_TARGET_MS: 600_000, OPENAI_API_KEY: undefined },
      queue: (type, sessionId) => { if (type === "analyze") endedSessions.push(sessionId); },
    });
    await local.listen({ port: 0, host: "127.0.0.1" });

    const created = (await local.inject({ method: "POST", url: `/v1/learners/${LEARNER_ID}/sessions`, payload: {} })).json() as { sessionId: string };
    const ws = new WebSocket(`ws://127.0.0.1:${(local.server.address() as { port: number }).port}/ws/session/${created.sessionId}`);
    const events: any[] = [];
    ws.on("message", (raw) => { events.push(JSON.parse(String(raw))); });
    await new Promise<void>((resolve) => { ws.on("open", resolve); });
    await new Promise((r) => setTimeout(r, 700)); // script: 6 turns x 25ms + toolCall

    const learnerTurns = events.filter((m) => m.t === "transcript" && m.speaker === "learner");
    expect(learnerTurns.length).toBeGreaterThanOrEqual(3); // the scripted learner spoke (recurring past-tense error)
    expect(events.some((m) => m.t === "intervention" && m.kind === "micro_coach")).toBe(true); // tool call fired

    ws.send(JSON.stringify({ t: "control", action: "end" }));
    await new Promise((r) => setTimeout(r, 200));
    expect(events.some((m) => m.t === "session_ended" && m.state === "ANALYZING")).toBe(true); // client end -> analysis, not FAILED
    expect(endedSessions.filter((s) => s === created.sessionId)).toHaveLength(1);
    ws.close();
    await local.close();
  });
});

describe("WebSocket session protocol", () => {
  it("streams transcript events and state changes, then session_ended", async () => {
    const created = (await app.inject({ method: "POST", url: `/v1/learners/${LEARNER_ID}/sessions` })).json() as { sessionId: string };
    const messages: any[] = [];
    const ws = new WebSocket(`${url.replace("http", "ws")}/ws/session/${created.sessionId}`);
    ws.on("message", (raw) => {
      messages.push(JSON.parse(String(raw)));
    });
    await new Promise<void>((resolve) => {
      ws.on("open", () => resolve());
    });
    // wait for the script to play out
    await new Promise((r) => setTimeout(r, 600));
    expect(messages.some((m) => m.t === "state" && m.state === "WARMUP")).toBe(true);
    expect(messages.some((m) => m.t === "transcript" && m.speaker === "learner")).toBe(true);
    ws.send(JSON.stringify({ t: "control", action: "end" }));
    await new Promise((r) => setTimeout(r, 200));
    expect(messages.some((m) => m.t === "session_ended" && m.state === "ANALYZING")).toBe(true);
    ws.close();
  }, 10_000);
});
