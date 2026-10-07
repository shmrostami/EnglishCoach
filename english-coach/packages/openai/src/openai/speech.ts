import WebSocket from "ws";
import { MODEL_CONFIG } from "../models.js";
import type {
  ProviderEvent, SpeechConversationProvider, TranscriptTurn,
} from "../providers/types.js";

/**
 * Server-held Realtime session. The browser sends raw 16 kHz PCM16 over the
 * app WebSocket; this class bridges it to the OpenAI Realtime WebSocket
 * (raw `ws` to wss://api.openai.com/v1/realtime — no vendor SDK; the event
 * JSON protocol is the only OpenAI-specific surface, isolated in translate()).
 * Instructions arrive after connect: the bridge calls sendInstruction()
 * with the full rendered conversation prompt (see bridge.start()).
 */
export class OpenAISpeechProvider implements SpeechConversationProvider {
  private ws: WebSocket | null = null;
  private onEvent: ((e: ProviderEvent) => void) | null = null;
  private closed = false;

  constructor(private readonly apiKey: string) {}

  async connect(onEvent: (e: ProviderEvent) => void): Promise<void> {
    this.onEvent = onEvent;
    this.ws = new WebSocket("wss://api.openai.com/v1/realtime", {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    await new Promise<void>((resolve, reject) => {
      this.ws!.once("open", () => {
        this.send({ type: "session.update", session: {
          model: MODEL_CONFIG.realtime,
          voice: "alloy",
          modalities: ["audio", "text"],
          temperature: MODEL_CONFIG.temperature.conversation,
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
          turn_detection: { type: "server_vad" },
          tools: [
            { type: "function", name: "request_micro_coaching",
              description: "Request a brief correction of a recurring, target, or comprehension-affecting error.",
              parameters: { type: "object", properties: { skill: { type: "string" }, reason: { type: "string" } }, required: ["skill", "reason"] } },
            { type: "function", name: "request_target_retry",
              description: "Create another opportunity for the learner to practice a target structure.",
              parameters: { type: "object", properties: { skill: { type: "string" } }, required: ["skill"] } },
          ],
        } });
        resolve();
      });
      this.ws!.once("error", (err) => reject(new Error(`realtime connect failed: ${String(err.message ?? err)}`)));
    });
    this.ws.on("message", (data) => {
      try { this.translate(JSON.parse(String(data))); } catch { /* ignore non-JSON frames */ }
    });
    this.ws.on("close", (code) => this.emitClosed(code === 1000 ? "closed" : `connection_lost_${code}`));
  }

  private translate(evt: Record<string, unknown>): void {
    switch (evt.type) {
      case "session.created":
        this.onEvent?.({ t: "connected" });
        break;
      case "input_audio_transcription.completed": {
        const turn: TranscriptTurn = {
          speaker: "learner",
          text: String(evt.transcript ?? ""),
          startedAt: Date.now(),
          endedAt: Date.now(),
        };
        this.onEvent?.({ t: "transcript", turn });
        break;
      }
      case "response.audio_transcript.done": {
        const turn: TranscriptTurn = {
          speaker: "coach",
          text: String(evt.transcript ?? ""),
          startedAt: Date.now(),
          endedAt: Date.now(),
        };
        this.onEvent?.({ t: "transcript", turn });
        break;
      }
      case "response.audio.delta":
        if (evt.delta) this.onEvent?.({ t: "audio", data: Buffer.from(String(evt.delta), "base64"), sampleRate: 24000 });
        break;
      case "conversation.item.created":
        break;
      case "response.output_item.added": {
        const item = evt.item as { type?: string; name?: string; arguments?: string } | undefined;
        if (item && item.type === "function_call" && item.name) {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(item.arguments ?? "{}"); } catch { /* empty args */ }
          this.handleFunctionCall(item.name, args);
        }
        break;
      }
      default:
        break;
    }
  }

  private handleFunctionCall(name: string, args: Record<string, unknown>): void {
    const skill = String(args.skill ?? "");
    if (name === "request_micro_coaching") {
      this.onEvent?.({ t: "tool_call", name, skill, reason: args.reason ? String(args.reason) : undefined });
    } else if (name === "request_target_retry") {
      this.onEvent?.({ t: "tool_call", name, skill });
    }
  }

  sendAudio(pcm16: Buffer): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send({ type: "input_audio_buffer.append", audio: pcm16.toString("base64") });
    }
  }

  sendInstruction(text: string): void {
    this.send({ type: "session.update", session: { instructions: text } });
  }

  close(): void {
    if (this.closed || !this.ws) return;
    this.closed = true;
    this.send({ type: "session.delete" });
    this.ws.close(1000, "client_closed");
  }

  private send(obj: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }
  private emitClosed(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.onEvent?.({ t: "closed", reason });
  }
}
