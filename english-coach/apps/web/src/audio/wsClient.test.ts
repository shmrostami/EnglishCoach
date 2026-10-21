import { describe, it, expect, vi } from "vitest";
import { SessionSocket } from "./wsClient.js";
import type { WsLike, ServerMessage, ConnectionState } from "./wsClient.js";

/**
 * A fake socket that the test drives by hand. The real WebSocket fires
 * `onopen` asynchronously, so the mock does too — the client's outbox and
 * reconnect logic depend on it.
 */
function mockSocket(): WsLike & {
  out: string[];
  fireOpen(): void;
  fireMessage(msg: unknown): void;
  fireClose(reason: string): void;
} {
  const out: string[] = [];
  let onOpen: any, onMessage: any, onClose: any;
  const socket: any = {
    out,
    send: (d: string) => { out.push(d); },
    close: () => { onClose?.({ reason: "client_closed" }); },
    get onopen() { return onOpen; },
    set onopen(cb: any) { onOpen = cb; },
    get onmessage() { return onMessage; },
    set onmessage(cb: any) { onMessage = cb; },
    get onclose() { return onClose; },
    set onclose(cb: any) { onClose = cb; },
    fireOpen: () => onOpen?.({}),
    fireMessage: (msg: unknown) => onMessage?.({ data: JSON.stringify(msg) }),
    fireClose: (reason: string) => onClose?.({ reason }),
  };
  return socket;
}

describe("SessionSocket", () => {
  it("sends audio frames as base64 JSON", () => {
    const s = mockSocket();
    const socket = new SessionSocket({ connect: () => s, onMessage: () => {} });
    s.fireOpen();
    socket.sendAudio(new Int16Array([1, -2, 3]));
    const frame = JSON.parse(s.out[0]);
    expect(frame.t).toBe("audio");
    expect(typeof frame.data).toBe("string");
    expect(frame.data.length).toBeGreaterThan(0);
  });

  it("parses server messages to the callback", () => {
    const s = mockSocket();
    const received: ServerMessage[] = [];
    new SessionSocket({ connect: () => s, onMessage: (m) => received.push(m) });
    s.fireMessage({ t: "state", state: "CONVERSATION" });
    s.fireMessage({ t: "transcript", speaker: "learner", text: "hi", seq: 1, startedAt: 0, endedAt: 100 });
    expect(received.map((m) => m.t)).toEqual(["state", "transcript"]);
  });

  it("swallows malformed messages instead of throwing", () => {
    const s = mockSocket();
    const received: ServerMessage[] = [];
    new SessionSocket({ connect: () => s, onMessage: (m) => received.push(m) });
    // @ts-expect-error simulating a corrupt frame
    s.onmessage({ data: "{not json" });
    expect(received).toHaveLength(0);
  });

  it("forwards close reason after the retries are exhausted", () => {
    vi.useFakeTimers();
    try {
      const s = mockSocket();
      const reason = vi.fn();
      const socket = new SessionSocket({
        connect: () => s, onMessage: () => {}, onClose: reason,
        maxRetries: 1, baseDelayMs: 10,
      });
      s.fireClose("server_gone");
      expect(reason).not.toHaveBeenCalled(); // a drop is retried first
      vi.advanceTimersByTime(20);
      s.fireClose("server_gone");
      expect(reason).toHaveBeenCalledWith("server_gone");
      socket.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("queues frames sent before the socket opens and flushes them on open", () => {
    const s = mockSocket();
    const socket = new SessionSocket({ connect: () => s, onMessage: () => {} });
    socket.sendControl("start");
    expect(s.out).toHaveLength(0); // not open yet — buffered, not dropped
    s.fireOpen();
    expect(s.out).toHaveLength(1);
    expect(JSON.parse(s.out[0])).toEqual({ t: "control", action: "start" });
  });

  it("reconnects after an unexpected close and reports the connection state", () => {
    vi.useFakeTimers();
    try {
      const sockets: ReturnType<typeof mockSocket>[] = [];
      const states: ConnectionState[] = [];
      const socket = new SessionSocket({
        connect: () => { const s = mockSocket(); sockets.push(s); return s; },
        onMessage: () => {},
        onConnection: (c) => states.push(c),
        maxRetries: 3, baseDelayMs: 100, maxDelayMs: 400,
      });
      expect(states).toEqual(["connecting"]);
      sockets[0].fireOpen();
      expect(states).toEqual(["connecting", "open"]);

      sockets[0].fireClose("network");
      expect(states.at(-1)).toBe("reconnecting");
      // Backoff is bounded: the delay grows but never past maxDelayMs.
      vi.advanceTimersByTime(100);
      expect(sockets).toHaveLength(2);
      sockets[1].fireOpen();
      expect(states.at(-1)).toBe("open");
      socket.close();
      expect(states.at(-1)).toBe("closed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reconnect after a deliberate close", () => {
    vi.useFakeTimers();
    try {
      const sockets: ReturnType<typeof mockSocket>[] = [];
      const socket = new SessionSocket({
        connect: () => { const s = mockSocket(); sockets.push(s); return s; },
        onMessage: () => {},
        maxRetries: 3, baseDelayMs: 10,
      });
      socket.close();
      sockets[0].fireClose("client_closed");
      vi.advanceTimersByTime(100);
      expect(sockets).toHaveLength(1); // no reconnect attempt
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after the retry budget and reports the close", () => {
    vi.useFakeTimers();
    try {
      const sockets: ReturnType<typeof mockSocket>[] = [];
      const closed = vi.fn();
      const socket = new SessionSocket({
        connect: () => { const s = mockSocket(); sockets.push(s); return s; },
        onMessage: () => {},
        onClose: closed,
        maxRetries: 2, baseDelayMs: 10,
      });
      sockets[0].fireClose("network");
      vi.advanceTimersByTime(20);
      sockets[1].fireClose("network");
      vi.advanceTimersByTime(40);
      sockets[2].fireClose("network");
      expect(closed).toHaveBeenCalledTimes(1);
      expect(sockets).toHaveLength(3); // initial + 2 retries
      socket.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
