import { OpenAI } from "openai";
import { VoiceEndpoint } from "./endpoint.js";
import type { VoiceSidecar } from "./sidecar.js";
import type { ProviderEvent, SpeechConversationProvider, TranscriptTurn } from "../providers/types.js";

export interface LocalProviderOptions {
  llmBaseURL: string;
  llmModel: string;
  llmApiKey?: string;
  sidecar: VoiceSidecar;
  frameMs?: number;
  now?: () => number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The sidecar's response union (Task 4) is not op-discriminated, so `ok` alone
// can't narrow it. Each request resolves with exactly one member shape, so the
// casts at the call sites are exact — they only make the known shape explicit.
type SttResponse = { ok: true; text: string } | { ok: false; error: string };
type TtsResponse = { ok: true; audio: Buffer; sampleRate: number } | { ok: false; error: string };

/**
 * Local conversation provider: endpoint gate → Whisper (via the sidecar) →
 * learner transcript → OpenAI-compatible LLM (TS) → coach transcript (text
 * first, so the learner reads while the audio is still being made) → Piper
 * audio, emitted in ~20 ms paced frames because the web player's ring buffer
 * holds only ~170 ms and resamples each posted chunk independently.
 *
 * connect() NEVER rejects (the bridge fire-and-forgets it): every startup
 * failure path ends in an emitted closed{reason} instead.
 */
export class LocalSpeechProvider implements SpeechConversationProvider {
  private onEvent: ((e: ProviderEvent) => void) | null = null;
  private closed = false;
  private endpoint: VoiceEndpoint;
  private client: OpenAI;
  private readonly frameMs: number;
  private readonly now: () => number;
  private history: OpenAI.ChatCompletionMessageParam[] = [];
  private warmup = "";
  // Learner turns run one at a time, in arrival order. A second span can land
  // while turn 1 is still awaiting the (slow) LLM; without this chain two
  // pacers would emit audio into the same ring buffer at once and two
  // continuations would scramble `history`. Each turn awaits the previous one.
  private turnChain = Promise.resolve();

  constructor(private readonly opts: LocalProviderOptions) {
    this.now = opts.now ?? Date.now;
    this.endpoint = new VoiceEndpoint({ now: this.now });
    this.frameMs = opts.frameMs ?? 20;
    this.client = new OpenAI({
      baseURL: opts.llmBaseURL,
      apiKey: opts.llmApiKey ?? "",
      timeout: 30_000,
      maxRetries: 0, // the provider's own one-shot retry is the only retry
    });
  }

  async connect(onEvent: (e: ProviderEvent) => void): Promise<void> {
    this.onEvent = onEvent;
    this.opts.sidecar.onCrash(() => this.emitClosed("voice_engine_lost"));
    try {
      await this.opts.sidecar.ready();
    } catch (e) {
      this.emitClosed("stt_unavailable");
      return;
    }
    this.onEvent({ t: "connected" });
  }

  sendAudio(pcm16: Buffer): void {
    if (this.closed) return;
    const span = this.endpoint.push(pcm16);
    if (span) {
      // Queue behind the previous turn so a barge-in can't interleave two
      // coaches' audio or reorder `history`. A turn can only reject if the
      // bridge callback throws (our code never does) — swallow it so one bad
      // turn can't poison the chain and silently drop every later turn.
      this.turnChain = this.turnChain.then(() => this.handleLearnerTurn(span.audio)).catch(() => {});
    }
  }

  sendInstruction(text: string): void {
    if (text.startsWith("Warmup:")) {
      this.warmup = text;
      this.history.unshift({ role: "system", content: this.warmup });
      return;
    }
    // A directive (challenge / micro-coach) steers the next reply: it replaces
    // the standing system prompt rather than appending forever.
    this.history = this.history.filter((m) => m.content !== this.warmup);
    this.history.unshift({ role: "system", content: text });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // close() is how the BRIDGE ends a session — including the normal
    // client-end path (clientEnd → finish("ANALYZING") → provider.close()).
    // Emitting closed{...} here would make the bridge's closed handler turn
    // every clean end into a FAILED session. So the `closed` event is
    // failure-only; user-initiated and app-shutdown closes are silent.
    this.opts.sidecar.close();
  }

  private emitClosed(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.onEvent?.({ t: "closed", reason });
  }

  private emitTurn(speaker: "learner" | "coach", text: string): void {
    const turn: TranscriptTurn = {
      speaker,
      text,
      startedAt: this.now() - 1000,
      endedAt: this.now(),
    };
    this.onEvent?.({ t: "transcript", turn });
  }

  /** STT → learner transcript → LLM (one retry) → coach transcript → TTS. */
  private async handleLearnerTurn(audio: Buffer): Promise<void> {
    if (this.closed) return; // a queued turn must not talk to a closed sidecar
    // 1. Transcribe the voiced span. Silence was never in it (endpoint gate).
    let stt: SttResponse;
    try {
      stt = (await this.opts.sidecar.request("stt", { audio: audio.toString("hex") })) as SttResponse;
    } catch (e) {
      this.emitClosed("voice_engine_lost");
      return;
    }
    if (!stt.ok) { this.emitClosed("voice_engine_lost"); return; }
    const text = stt.text.trim();
    if (!text) return; // empty transcription is dropped silently (spec §7)
    this.emitTurn("learner", text);
    this.history.push({ role: "user", content: text });

    // 2. Coach reply from the LLM — one retry, then a visible failure.
    //    Never fabricate a line: a dead coach is a FAILED session, not a
    //    made-up sentence the learning engine will score.
    const reply = await this.callLLM();
    if (this.closed) return;
    if (reply === null) { this.emitClosed("coach_unavailable"); return; }
    this.emitTurn("coach", reply);
    this.history.push({ role: "assistant", content: reply });

    // 3. Speak it. Piper failing here must NOT kill the session: the text
    //    already landed, so drop the audio and keep the conversation alive.
    try {
      const tts = (await this.opts.sidecar.request("tts", { text: reply })) as TtsResponse;
      if (!tts.ok) return;
      if (this.closed) return;
      await this.emitPacedAudio(tts.audio, tts.sampleRate);
    } catch {
      // sidecar died mid-tts: the crash handler already emitted closed
      // (or will); nothing more to do here.
    }
  }

  /** Two attempts total (the SDK retries 0). Returns null when both fail. */
  private async callLLM(): Promise<string | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.client.chat.completions.create(
          { model: this.opts.llmModel, messages: this.history },
          { timeout: 30_000 }, // request option (2nd arg) — the create body type has no `timeout` field
        );
        const content = res.choices[0]?.message?.content;
        if (typeof content === "string" && content.trim()) return content.trim();
        return null; // the endpoint answered but gave nothing usable — don't burn the retry on an empty-but-200 body
      } catch {
        /* attempt 1 failed; the loop makes exactly one more try (the SDK is maxRetries: 0, so this provider-level retry is the only one) */
      }
    }
    return null;
  }

  private async emitPacedAudio(pcm: Buffer, sampleRate: number): Promise<void> {
    const samplesPerFrame = Math.max(1, Math.round((sampleRate * this.frameMs) / 1000));
    for (let off = 0; off + samplesPerFrame * 2 <= pcm.length; off += samplesPerFrame * 2) {
      if (this.closed) return;
      this.onEvent?.({ t: "audio", data: pcm.subarray(off, off + samplesPerFrame * 2), sampleRate });
      await sleep(this.frameMs);
    }
  }
}
