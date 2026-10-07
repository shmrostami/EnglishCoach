import { bytesToBase64 } from "./pcm.js";
import type { ClientMessage, ServerMessage } from "../types/messages.js";

export type { ClientMessage, ServerMessage } from "../types/messages.js";

/** Minimal WebSocket surface so tests can supply a fake. */
export interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: ((ev: { reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export class SessionSocket {
  constructor(
    private readonly socket: WsLike,
    private readonly onMessage: (m: ServerMessage) => void,
    private readonly onClose: (reason: string) => void,
  ) {
    this.socket.onmessage = (ev) => {
      try { this.onMessage(JSON.parse(ev.data) as ServerMessage); } catch { /* corrupt frame */ }
    };
    this.socket.onclose = (ev) => this.onClose(String(ev.reason ?? "closed"));
    this.socket.onerror = () => { /* surfaced via onclose */ };
  }

  sendAudio(pcm: Int16Array): void {
    const u8 = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    this.socket.send(JSON.stringify({ t: "audio", data: bytesToBase64(u8) } satisfies ClientMessage));
  }

  sendControl(action: "start" | "end" | "mute" | "unmute"): void {
    this.socket.send(JSON.stringify({ t: "control", action } satisfies ClientMessage));
  }

  close(): void { this.socket.close(); }
}
