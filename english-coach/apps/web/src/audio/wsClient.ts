import { bytesToBase64 } from "./pcm.js";
import type { ClientMessage, ConnectionState, ControlAction, ServerMessage } from "../types/messages.js";

export type { ClientMessage, ServerMessage, ConnectionState, ControlAction } from "../types/messages.js";

/** Minimal WebSocket surface so tests can supply a fake. */
export interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: ((ev: { reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface SessionSocketOptions {
  /** Opens the socket. Called again for every reconnect attempt. */
  connect: () => WsLike;
  onMessage: (m: ServerMessage) => void;
  /** The session ended for good (server closed it, or the client gave up). */
  onClose?: (reason: string) => void;
  onOpen?: () => void;
  /** Connection state changes: connecting → open → reconnecting → closed. */
  onConnection?: (state: ConnectionState) => void;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 8_000;

/**
 * The session's WebSocket, with a bounded reconnect.
 *
 * The server keeps the bridge and the provider alive across a client drop, so
 * re-attaching resumes the same conversation instead of opening a second
 * provider session (spec §5).
 */
export class SessionSocket {
  private socket: WsLike | null = null;
  private opts: SessionSocketOptions;
  private closed = false;
  private open = false;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private outbox: string[] = [];

  constructor(opts: SessionSocketOptions) {
    this.opts = opts;
    this.dial();
  }

  private dial(): void {
    this.setConnection(this.attempts === 0 ? "connecting" : "reconnecting");
    const socket = this.opts.connect();
    this.socket = socket;
    socket.onopen = () => {
      this.open = true;
      this.attempts = 0;
      this.setConnection("open");
      this.flush();
      this.opts.onOpen?.();
    };
    socket.onmessage = (ev) => {
      try { this.opts.onMessage(JSON.parse(ev.data) as ServerMessage); } catch { /* corrupt frame */ }
    };
    socket.onclose = (ev) => this.handleClose(String(ev.reason ?? "closed"));
    socket.onerror = () => { /* surfaced via onclose */ };
  }

  private handleClose(reason: string): void {
    this.open = false;
    if (this.closed) { this.setConnection("closed"); return; }
    const maxRetries = this.opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    if (this.attempts >= maxRetries) {
      this.closed = true;
      this.setConnection("closed");
      this.opts.onClose?.(reason);
      return;
    }
    this.attempts += 1;
    this.setConnection("reconnecting");
    const base = this.opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    const max = this.opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    const delay = Math.min(max, base * 2 ** (this.attempts - 1));
    this.timer = setTimeout(() => this.dial(), delay);
  }

  private flush(): void {
    if (!this.open || !this.socket) return;
    for (const frame of this.outbox.splice(0)) this.socket.send(frame);
  }

  private setConnection(state: ConnectionState): void {
    this.opts.onConnection?.(state);
  }

  sendAudio(pcm: Int16Array): void {
    const u8 = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    this.send({ t: "audio", data: bytesToBase64(u8) });
  }

  sendControl(action: ControlAction): void {
    this.send({ t: "control", action });
  }

  private send(msg: ClientMessage): void {
    const frame = JSON.stringify(msg);
    if (this.open && this.socket) this.socket.send(frame);
    else this.outbox.push(frame);
  }

  /** Deliberate close: no reconnect follows. */
  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.socket?.close();
    this.setConnection("closed");
  }
}
