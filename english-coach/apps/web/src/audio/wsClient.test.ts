import { describe, it, expect, vi } from "vitest";
import { SessionSocket } from "./wsClient.js";
import type { WsLike, ServerMessage } from "./wsClient.js";

function mockSocket(): WsLike & { out: string[]; fireMessage(msg: unknown): void; fireClose(reason: string): void } {
  const out: string[] = [];
  let onMessage: any, onClose: any;
  const socket: any = {
    out,
    send: (d: string) => { out.push(d); },
    close: () => {},
    get onmessage() { return onMessage; },
    set onmessage(cb: any) { onMessage = cb; },
    get onclose() { return onClose; },
    set onclose(cb: any) { onClose = cb; },
    fireMessage: (msg: unknown) => onMessage?.({ data: JSON.stringify(msg) }),
    fireClose: (reason: string) => onClose?.({ reason }),
  };
  return socket;
}

describe("SessionSocket", () => {
  it("sends audio frames as base64 JSON", () => {
    const s = mockSocket();
    const socket = new SessionSocket(s, () => {}, () => {});
    socket.sendAudio(new Int16Array([1, -2, 3]));
    const frame = JSON.parse(s.out[0]);
    expect(frame.t).toBe("audio");
    expect(typeof frame.data).toBe("string");
    expect(frame.data.length).toBeGreaterThan(0);
  });

  it("parses server messages to the callback", () => {
    const s = mockSocket();
    const received: ServerMessage[] = [];
    new SessionSocket(s, (m) => received.push(m), () => {});
    s.fireMessage({ t: "state", state: "CONVERSATION" });
    s.fireMessage({ t: "transcript", speaker: "learner", text: "hi", seq: 1, startedAt: 0, endedAt: 100 });
    expect(received.map((m) => m.t)).toEqual(["state", "transcript"]);
  });

  it("swallows malformed messages instead of throwing", () => {
    const s = mockSocket();
    const received: ServerMessage[] = [];
    new SessionSocket(s, (m) => received.push(m), () => {});
    // @ts-expect-error simulating a corrupt frame
    s.onmessage({ data: "{not json" });
    expect(received).toHaveLength(0);
  });

  it("forwards close reason", () => {
    const s = mockSocket();
    const reason = vi.fn();
    new SessionSocket(s, () => {}, reason);
    s.fireClose("server_gone");
    expect(reason).toHaveBeenCalledWith("server_gone");
  });
});
