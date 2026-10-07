import type WebSocket from "ws";
import type { SessionState, LearnerContext } from "@ec/domain";
import type { SpeechConversationProvider, ProviderEvent, TranscriptTurn } from "@ec/openai";
import { renderPrompt } from "@ec/prompts";
import type { SessionService } from "../services/session.js";

export type ClientMessage =
  | { t: "audio"; data: string }
  | { t: "control"; action: "start" | "end" | "mute" | "unmute" };

export type ServerMessage =
  | { t: "audio"; data: string; sampleRate: number }
  | { t: "transcript"; speaker: "learner" | "coach"; text: string; seq: number; startedAt: number; endedAt: number }
  | { t: "state"; state: SessionState }
  | { t: "intervention"; kind: "micro_coach" | "target_retry" | "challenge"; skill: string }
  | { t: "session_ended"; state: SessionState };

interface BridgeOpts {
  sessionId: string;
  provider: SpeechConversationProvider;
  service: SessionService;
  learnerContext: LearnerContext;
  difficulty: number;
  warmupMs: number;
  sessionTargetMs: number;
  onEnded: (result: { state: SessionState }) => void;
  onCleanup?: (sessionId: string) => void;
}

export class RealtimeBridge {
  state: SessionState = "STARTING";
  private client: WebSocket | null = null;
  private closed = false;
  private timers: NodeJS.Timeout[] = [];
  private seq = 0;
  private muted = false;

  constructor(private readonly opts: BridgeOpts) {}

  hasClient(): boolean { return this.client !== null; }

  attach(socket: WebSocket): boolean {
    if (this.client) return false;
    this.client = socket;
    this.start();
    socket.on("close", () => { this.client = null; });
    socket.on("message", (raw) => {
      try { this.handleClientMessage(JSON.parse(String(raw)) as ClientMessage); } catch { /* ignore malformed */ }
    });
    this.send({ t: "state", state: this.state });
    return true;
  }

  detach(): void { this.client = null; }

  private start(): void {
    void this.opts.provider.connect((e) => this.handleProviderEvent(e));
    const instructions = renderPrompt("conversation", {
      learner_context: JSON.stringify(this.opts.learnerContext),
      targets: this.opts.learnerContext.currentSessionTargets.join(", ") || "none",
      difficulty: String(this.opts.difficulty),
    });
    this.opts.provider.sendInstruction(instructions);
    this.transition("WARMUP");
    this.opts.provider.sendInstruction("Warmup: keep it light, no corrections, get the learner talking.");
    this.timers.push(setTimeout(() => this.maybeTransition("WARMUP", "CONVERSATION"), this.opts.warmupMs));
    this.timers.push(setTimeout(() => this.maybeTransition("CONVERSATION", "CHALLENGE", "challenge"), this.opts.sessionTargetMs));
  }

  private handleProviderEvent(e: ProviderEvent): void {
    if (this.closed) return;
    switch (e.t) {
      case "audio":
        if (!this.muted) this.send({ t: "audio", data: e.data.toString("base64"), sampleRate: e.sampleRate });
        break;
      case "transcript":
        this.handleTranscript(e.turn);
        break;
      case "tool_call":
        this.handleToolCall(e);
        break;
      case "closed":
        this.finish("FAILED", e.reason);
        break;
      case "connected":
        break;
    }
  }

  private handleTranscript(turn: TranscriptTurn): void {
    const { seq } = this.opts.service.recordUtterance(this.opts.sessionId, {
      speaker: turn.speaker, text: turn.text, startedAt: turn.startedAt, endedAt: turn.endedAt,
    });
    this.seq = seq;
    this.send({ t: "transcript", speaker: turn.speaker, text: turn.text, seq, startedAt: turn.startedAt, endedAt: turn.endedAt });
    if (turn.speaker === "learner") this.maybeTransition("WARMUP", "CONVERSATION");
    // Any turn (coach or learner) while inside an intervention resumes
    // normal conversation — the provider's follow-up is the coach nudging the
    // learner, not another practice attempt.
    if (this.state === "MICRO_COACH" || this.state === "TARGET_RETRY") {
      this.transition("CONVERSATION");
    }
  }

  private handleToolCall(e: Extract<ProviderEvent, { t: "tool_call" }>): void {
    const kind = e.name === "request_micro_coaching" ? "micro_coach" : "target_retry";
    const to = e.name === "request_micro_coaching" ? "MICRO_COACH" : "TARGET_RETRY";
    if (!this.opts.service.transition(this.opts.sessionId, to, Date.now())) return;
    this.state = to;
    this.opts.service.recordIntervention(this.opts.sessionId, kind, e.skill, Date.now());
    this.send({ t: "intervention", kind, skill: e.skill });
    this.send({ t: "state", state: this.state });
    if (kind === "micro_coach") {
      this.opts.provider.sendInstruction(`Micro-coach the ${e.skill} issue (${e.reason ?? "observed error"}): one concise correction, then return to conversation.`);
    } else {
      this.opts.provider.sendInstruction(`Create a new situation where the learner must use the ${e.skill} structure naturally, then let them try it.`);
    }
  }

  private maybeTransition(from: SessionState, to: SessionState, intervention?: "challenge"): void {
    if (this.state !== from) return;
    if (!this.opts.service.transition(this.opts.sessionId, to, Date.now())) return;
    this.state = to;
    this.send({ t: "state", state: to });
    if (to === "CHALLENGE") {
      this.send({ t: "intervention", kind: "challenge", skill: "discourse.argumentation" });
      this.opts.provider.sendInstruction("Challenge: raise cognitive demand — ask follow-up why/how questions, ask the learner to elaborate and justify.");
    }
    void intervention;
  }

  private transition(to: SessionState): void {
    if (this.opts.service.transition(this.opts.sessionId, to, Date.now())) this.state = to;
  }

  private handleClientMessage(msg: ClientMessage): void {
    if (this.closed) return;
    if (msg.t === "audio") {
      if (!this.muted) this.opts.provider.sendAudio(Buffer.from(msg.data, "base64"));
    } else if (msg.t === "control") {
      if (msg.action === "mute") this.muted = true;
      if (msg.action === "unmute") this.muted = false;
      if (msg.action === "end") this.clientEnd();
    }
  }

  private clientEnd(): void {
    if (this.closed) return;
    const out = this.opts.service.endSession(this.opts.sessionId, Date.now());
    if (out.ok) this.finish("ANALYZING", "ended");
  }

  private finish(state: SessionState, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.opts.provider.close();
    // Persist the terminal state. The ANALYZING path is already in the DB
    // (endSession transitioned CLOSING->ANALYZING before calling finish);
    // the FAILED path (provider dropped mid-session) is not, so transition it.
    if (state === "FAILED") {
      this.opts.service.transition(this.opts.sessionId, "FAILED", Date.now());
    }
    this.state = state;
    this.send({ t: "session_ended", state });
    if (state === "ANALYZING") this.opts.onEnded({ state });
    this.client?.close();
    this.client = null;
    this.opts.onCleanup?.(this.opts.sessionId);
    void reason;
  }

  destroy(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.opts.provider.close();
    this.client?.close(1000, reason);
    this.client = null;
    this.opts.onCleanup?.(this.opts.sessionId);
  }

  private send(msg: ServerMessage): void {
    if (this.client && this.client.readyState === 1) this.client.send(JSON.stringify(msg));
  }
}

export class BridgeRegistry {
  private bridges = new Map<string, RealtimeBridge>();
  get(sessionId: string): RealtimeBridge | undefined { return this.bridges.get(sessionId); }
  set(sessionId: string, bridge: RealtimeBridge): void { this.bridges.set(sessionId, bridge); }
  delete(sessionId: string): void { this.bridges.delete(sessionId); }
}
