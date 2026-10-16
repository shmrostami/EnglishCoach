import { spawn, type ChildProcess } from "node:child_process";

/** One JSON op, one response — the wire shape the Python sidecar speaks. */
export type SidecarResponse =
  | { ok: true; text: string }
  | { ok: true; audio: Buffer; sampleRate: number }
  | { ok: true }
  | { ok: false; error: string };

export interface SidecarOptions {
  python: string;
  script: string;
  env?: Record<string, string>;
  requestTimeoutMs?: number;
  readyTimeoutMs?: number;
}

interface Pending {
  resolve: (r: SidecarResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Owner of the Python voice sidecar (see scripts/voice_sidecar.py). Spawns the
 * interpreter, completes the ready handshake, and pairs one JSON request with
 * one JSON response by `id`. It never restarts the child: a pre-ready exit
 * fails the handshake (stt_unavailable) and a post-ready exit fires onCrash
 * exactly once (voice_engine_lost). The spec's "restart-on-crash" was
 * superseded by its own failure table: restarting a dead audio engine just
 * delays the visible failure by a model reload.
 */
export class VoiceSidecar {
  private readonly python: string;
  private readonly script: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly requestTimeoutMs: number;
  private child: ChildProcess | null = null;
  private lineBuf = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private readyState: "starting" | "ready" | "dead" = "starting";
  private readyWaiters: { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];
  private crashHandler: ((code: number | null) => void) | null = null;
  private crashFired = false;
  private closed = false;

  constructor(opts: SidecarOptions) {
    this.python = opts.python;
    this.script = opts.script;
    // Strip null/undefined: callers pass optional config through, and spawn()
    // rejects non-string env values.
    const merged: NodeJS.ProcessEnv = { ...process.env };
    for (const [k, v] of Object.entries(opts.env ?? {})) if (v != null) merged[k] = v;
    this.env = merged;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
    this.spawnChild(opts.readyTimeoutMs ?? 180_000);
  }

  private spawnChild(readyTimeoutMs: number): void {
    const child = spawn(this.python, [this.script], {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.env,
    });
    this.child = child;

    child.stdout!.on("data", (d: Buffer) => this.onData(d));
    child.stderr!.on("data", (d: Buffer) => {
      // Surfaced on the next ready() reject — the child's traceback is the
      // "pip install faster-whisper piper-tts" a user actually needs to see.
      this.stderrTail = (this.stderrTail + d.toString("utf8")).slice(-2_000);
    });
    child.on("exit", (code) => this.onExit(code));
    // A spawn failure (python missing / bad path) arrives as 'error'. An
    // 'error' emission with no listener throws in the API process — so this
    // handler is mandatory, and it routes the failure through the same
    // stt_unavailable surface as a dying child.
    child.on("error", (err) => this.failReady(new Error(`stt_unavailable: ${String(err.message ?? err)}`)));
    const timer = setTimeout(() => this.failReady(new Error(`stt_unavailable: timeout waiting for sidecar ready (python: ${this.python})`)), readyTimeoutMs);
    this.readyTimers.push(timer);
  }

  private stderrTail = "";
  private readyTimers: NodeJS.Timeout[] = [];

  ready(): Promise<void> {
    if (this.readyState === "ready") return Promise.resolve();
    if (this.readyState === "dead") return Promise.reject(new Error(`stt_unavailable: ${this.stderrTail || "sidecar exited before ready"}`.trim()));
    return new Promise((resolve, reject) => {
      this.readyWaiters.push({
        resolve: () => resolve(),
        reject: (e) => reject(e),
        timer: setTimeout(() => reject(new Error("stt_unavailable: timeout waiting for sidecar ready")), 180_000),
      });
    });
  }

  private failReady(err: Error): void {
    if (this.readyState !== "starting") return;
    this.readyState = "dead";
    this.killChild();
    for (const w of this.readyWaiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  request(op: "stt" | "tts", payload: Record<string, unknown>): Promise<SidecarResponse> {
    if (this.closed) return Promise.reject(new Error("sidecar closed"));
    if (!this.child || this.readyState === "dead") {
      return Promise.reject(new Error("stt_unavailable: sidecar died"));
    }
    const id = this.nextId++;
    const line = { id, op, ...payload };
    const timer = setTimeout(() => {
      // settle() is the single exactly-once choke point (it deletes the id
      // itself) — deleting first would make settle a no-op and leave the
      // caller's promise unsettled forever.
      this.settle(id, null, new Error(`sidecar timeout after ${this.requestTimeoutMs} ms`));
    }, this.requestTimeoutMs);
    return new Promise<SidecarResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin!.write(JSON.stringify(line) + "\n");
    });
  }

  private onData(d: Buffer): void {
    this.lineBuf += d.toString("utf8");
    let idx: number;
    while ((idx = this.lineBuf.indexOf("\n")) >= 0) {
      const line = this.lineBuf.slice(0, idx);
      this.lineBuf = this.lineBuf.slice(idx + 1);
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // never let a half-line kill the reader
      }
      if (msg.ready) {
        // Only a not-yet-ready handshake is meaningful — a ready line after
        // close() is stale pipe noise, not a state transition.
        if (this.readyState === "starting") {
          this.readyState = "ready";
          for (const t of this.readyTimers) clearTimeout(t);
          this.readyTimers = [];
          const ws = this.readyWaiters.splice(0);
          for (const w of ws) {
            clearTimeout(w.timer);
            w.resolve();
          }
        }
        continue;
      }
      const id = typeof msg.id === "number" ? msg.id : null;
      if (id === null) continue; // a line that pairs to nothing is noise, not an error
      // TTS audio crosses the wire as a hex string; the response type promises a Buffer.
      const res = (typeof msg.audio === "string"
        ? { ...msg, audio: Buffer.from(msg.audio, "hex") }
        : msg) as unknown as SidecarResponse;
      this.settle(id, res, null);
    }
  }

  private onExit(code: number | null): void {
    if (this.closed) return; // close() already killed it — nothing to report
    if (this.readyState === "starting") {
      // The child died (or was killed) before it ever said ready.
      this.failReady(new Error(`stt_unavailable: sidecar exited before ready (code=${code})${this.stderrTail ? `: ${this.stderrTail}` : ""}`));
      return;
    }
    // Post-ready exit. A clean exit (bye/stdin EOF, code 0) is teardown, not a
    // crash — but the contract is that close() suppresses everything, and a
    // code-0 exit without close() means the child ended on its own: still
    // surface it, because a "clean" exit mid-session is a defect worth seeing.
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("stt_unavailable: sidecar died"));
    }
    this.pending.clear();
    if (!this.crashFired && this.crashHandler) {
      this.crashFired = true;
      this.crashHandler(code);
    }
  }

  onCrash(handler: (code: number | null) => void): void {
    this.crashHandler = handler;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.readyTimers) clearTimeout(t);
    for (const w of this.readyWaiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new Error("stt_unavailable: sidecar closed before ready"));
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("sidecar closed"));
    }
    this.pending.clear();
    this.readyState = "dead";
    this.killChild();
  }

  private killChild(): void {
    const child = this.child;
    if (!child) return;
    this.child = null;
    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, 2_000).unref?.();
  }

  /** Resolve one pending request, exactly once. */
  private settle(id: number, res: SidecarResponse | null, err: Error | null): void {
    const p = this.pending.get(id);
    if (!p) return; // already settled (timeout raced the response) — drop the loser
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (err) p.reject(err);
    else p.resolve(res as SidecarResponse);
  }
}
