import type { ProviderEvent, SpeechConversationProvider, TranscriptTurn } from "../providers/types.js";

export interface MockTurn {
  speaker: "learner" | "coach";
  text: string;
  pauseMs?: number;
  toolCall?: { name: "request_micro_coaching" | "request_target_retry"; skill: string; reason?: string };
}

/**
 * Emits a scripted dialogue on connect. `autoClose` (default true) emits a
 * `closed` event when the script is exhausted; pass `{ turns, autoClose: false }`
 * for long-running sessions where the client ends the call.
 */
export class MockSpeechProvider implements SpeechConversationProvider {
  private onEvent: ((e: ProviderEvent) => void) | null = null;
  private closed = false;

  constructor(private readonly script: { turns: MockTurn[]; autoClose?: boolean }) {}

  async connect(onEvent: (e: ProviderEvent) => void): Promise<void> {
    this.onEvent = onEvent;
    onEvent({ t: "connected" });
    this.play(0);
  }

  private async play(i: number): Promise<void> {
    for (; i < this.script.turns.length; i++) {
      if (this.closed) return;
      const turn = this.script.turns[i];
      const pause = turn.pauseMs ?? 150;
      await sleep(pause);
      if (this.closed) return;
      const startedAt = Date.now();
      const durationMs = Math.max(400, turn.text.split(" ").length * 300);
      const turnEvent: TranscriptTurn = {
        speaker: turn.speaker, text: turn.text,
        startedAt, endedAt: startedAt + durationMs,
      };
      this.onEvent?.({ t: "transcript", turn: turnEvent });
      this.onEvent?.({ t: "audio", data: Buffer.alloc(1280), sampleRate: 16000 }); // 40 ms silence @16 kHz
      if (turn.toolCall) {
        await sleep(50);
        this.onEvent?.({ t: "tool_call", name: turn.toolCall.name, skill: turn.toolCall.skill, reason: turn.toolCall.reason });
      }
    }
    if (!this.closed && this.script.autoClose !== false) {
      this.closed = true;
      this.onEvent?.({ t: "closed", reason: "script_finished" });
    }
  }

  sendAudio(_pcm16: Buffer): void { /* mock ignores learner audio */ }
  sendInstruction(_text: string): void { /* mock ignores instructions */ }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onEvent?.({ t: "closed", reason: "client_closed" });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
