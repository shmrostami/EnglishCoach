import { OpenAI } from "openai";
import { isSkillCode } from "@ec/domain";
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

/** What one LLM turn produced: a coach line, a tool call, or both. */
type LlmReply = {
  content: string;
  toolCall?: {
    id: string;
    name: "request_micro_coaching" | "request_target_retry";
    args: Record<string, unknown>;
    content?: string;
  };
};

/** Tool arguments arrive as a JSON string; a malformed one is not a crash. */
function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
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
  /**
   * Read-only tools the model may call to ground its coaching in the
   * learner's own state (spec §8.3). The executor is supplied by the API,
   * which owns the database — this package does not know how the state is
   * stored, only how to ask for it.
   */
  private toolExecutor?: (name: string) => unknown;
  private warmup = "";
  // Learner turns run one at a time, in arrival order. A second span can land
  // while turn 1 is still awaiting the (slow) LLM; without this chain two
  // pacers would emit audio into the same ring buffer at once and two
  // continuations would scramble `history`. Each turn awaits the previous one.
  private turnChain = Promise.resolve();
  /**
   * The audio of the learner's last turn, kept so a pronunciation assessment
   * can measure it (spec §12.1). A score needs the samples; the transcript
   * cannot substitute for them. Consumed by `takeLearnerAudio`.
   */
  private lastLearnerAudio: { pcm: Buffer; sampleRate: number } | null = null;

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

  /**
   * Registers the read-tool executor. Without one the model gets no read
   * tools, so a provider used outside the API behaves exactly as before.
   */
  setToolExecutor(executor: (name: string) => unknown): void {
    this.toolExecutor = executor;
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

  /**
   * The learner's audio for the last turn, or null when there is none.
   *
   * Reading it CLEARS it: the audio belongs to one turn, and a later turn's
   * audio must not be scored against an earlier turn's words.
   */
  takeLearnerAudio(): { pcm: Buffer; sampleRate: number } | null {
    const audio = this.lastLearnerAudio;
    this.lastLearnerAudio = null;
    return audio;
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

  /**
   * The two coaching tools, in the OpenAI-compatible chat format.
   *
   * These are the same two the OpenAI Realtime provider exposes. The local
   * provider had none, so micro-coaching and target-retry never fired in
   * local mode and only the timer-driven challenge did — the coach could see
   * an error but had no way to act on it mid-conversation.
   */
  /**
   * The read tools the model may call. Names must match the API's executor.
   */
  private static readonly READ_TOOLS = [
    "get_learner_context",
    "get_due_reviews",
    "get_active_learning_objectives",
    "get_recurring_errors",
  ];

  private static readonly TOOLS = [
    {
      type: "function" as const,
      function: {
        name: "request_micro_coaching",
        description: "Request a brief correction of a recurring or target error the learner just made.",
        parameters: {
          type: "object",
          properties: {
            skill: { type: "string", description: "The skill code, e.g. grammar.past_tense" },
            reason: { type: "string", description: "What the learner did that triggered this" },
          },
          required: ["skill", "reason"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "request_target_retry",
        description: "Create another opportunity for the learner to practise a target structure.",
        parameters: {
          type: "object",
          properties: { skill: { type: "string", description: "The skill code to practise" } },
          required: ["skill"],
        },
      },
    },
  ];

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
    // The endpoint gate already trimmed the silence, so this span is the
    // learner's speech and nothing else.
    this.lastLearnerAudio = { pcm: audio, sampleRate: 16_000 };

    // 2. Coach reply from the LLM — one retry, then a visible failure.
    //    Never fabricate a line: a dead coach is a FAILED session, not a
    //    made-up sentence the learning engine will score.
    const reply = await this.callLLM();
    if (this.closed) return;
    if (reply === null) { this.emitClosed("coach_unavailable"); return; }
    // A tool call is not a coach line: it asks the bridge to intervene. It is
    // emitted as its own event and the turn continues with the tool result
    // fed back, so the coach still says something afterwards.
    if (reply.toolCall) {
      this.emitToolCall(reply.toolCall);
      if (this.closed) return;
      this.history.push({
        role: "assistant",
        content: reply.toolCall.content ?? "",
        tool_calls: [{
          id: reply.toolCall.id,
          type: "function",
          function: { name: reply.toolCall.name, arguments: JSON.stringify(reply.toolCall.args) },
        }],
      });
      this.history.push({
        role: "tool",
        tool_call_id: reply.toolCall.id,
        content: "requested",
      });
    } else {
      this.emitTurn("coach", reply.content);
      this.history.push({ role: "assistant", content: reply.content });
    }

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

  /** The tools this provider offers: the two coaching tools, plus the read
   *  tools when an executor was registered. */
  private toolsFor(): { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }[] {
    if (!this.toolExecutor) return LocalSpeechProvider.TOOLS;
    return [
      ...LocalSpeechProvider.TOOLS,
      ...LocalSpeechProvider.READ_TOOLS.map((name) => ({
        type: "function" as const,
        function: {
          name,
          description: "Read the learner's own state to ground your coaching.",
          parameters: { type: "object", properties: {}, required: [] },
        },
      })),
    ];
  }

  /**
   * Runs a read tool the model asked for and feeds the result back.
   *
   * A read tool never mutates anything, so it is safe to answer immediately.
   * An unknown or failing tool returns an error string rather than a
   * fabricated result.
   */
  private async answerReadTool(call: { id: string; name: string; args: Record<string, unknown> }): Promise<void> {
    let content: string;
    try {
      content = JSON.stringify(this.toolExecutor!(call.name));
    } catch (e) {
      content = JSON.stringify({ error: e instanceof Error ? e.message : "tool failed" });
    }
    this.history.push({
      role: "tool",
      tool_call_id: call.id,
      content,
    });
  }

  /** Two attempts total (the SDK retries 0). Returns null when both fail. */
  private async callLLM(): Promise<LlmReply | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.client.chat.completions.create(
          { model: this.opts.llmModel, messages: this.history, tools: this.toolsFor() },
          { timeout: 60_000 }, // request option (2nd arg) — the create body type has no `timeout` field
        );
        const message = res.choices[0]?.message;
        const toolCall = message?.tool_calls?.[0];
        if (toolCall?.function?.name) {
          const rawName = toolCall.function.name;
          // A read tool is answered and the turn continues — it is a question,
          // not a coaching decision.
          if (LocalSpeechProvider.READ_TOOLS.includes(rawName)) {
            if (!this.toolExecutor) {
              return { content: typeof message?.content === "string" ? message.content : "" };
            }
            this.history.push({
              role: "assistant",
              content: typeof message?.content === "string" ? message.content : "",
              tool_calls: [{
                id: toolCall.id ?? `call-${rawName}`,
                type: "function",
                function: { name: rawName, arguments: JSON.stringify(toolCall.function.arguments ? parseArgs(toolCall.function.arguments) : {}) },
              }],
            });
            await this.answerReadTool({
              id: toolCall.id ?? `call-${rawName}`,
              name: rawName,
              args: parseArgs(toolCall.function.arguments),
            });
            // Ask the model again now that it has the answer.
            return await this.callLLM();
          }
          // Only the two coaching tools are known here; an unknown name from
          // the model is ignored rather than forwarded to the bridge.
          if (rawName !== "request_micro_coaching" && rawName !== "request_target_retry") {
            return null;
          }
          return {
            content: typeof message?.content === "string" ? message.content : "",
            toolCall: {
              id: toolCall.id ?? `call-${rawName}`,
              name: rawName,
              args: parseArgs(toolCall.function.arguments),
              content: typeof message?.content === "string" ? message.content : undefined,
            },
          };
        }
        const content = message?.content;
        if (typeof content === "string" && content.trim()) return { content: content.trim() };
        return null; // the endpoint answered but gave nothing usable — don't burn the retry on an empty-but-200 body
      } catch {
        /* attempt 1 failed; the loop makes exactly one more try (the SDK is maxRetries: 0, so this provider-level retry is the only one) */
      }
    }
    return null;
  }

  /**
   * Emits a tool call as the provider's `tool_call` event.
   *
   * The skill is validated against the known skill codes: a model that invents
   * "grammar.telepathy" would otherwise create an intervention for a skill
   * that does not exist, and the bridge would record it as a coaching action
   * the learner model can never use.
   */
  private emitToolCall(call: { id: string; name: string; args: Record<string, unknown> }): void {
    const name: "request_micro_coaching" | "request_target_retry" =
      call.name === "request_target_retry" ? "request_target_retry" : "request_micro_coaching";
    const skill = typeof call.args.skill === "string" ? call.args.skill : "";
    if (!isSkillCode(skill)) return;
    const reason = typeof call.args.reason === "string" ? call.args.reason : undefined;
    this.onEvent?.({ t: "tool_call", name, skill, reason });
  }

  private async emitPacedAudio(pcm: Buffer, sampleRate: number): Promise<void> {
    const samplesPerFrame = Math.max(1, Math.round((sampleRate * this.frameMs) / 1000));
    // Pace on an ABSOLUTE deadline, not sleep-after-send: each frame carries
    // frameMs of audio, so the send period must be frameMs too. Sleeping
    // frameMs *after* the send adds the per-frame cost (JSON + WS write) to
    // the period — measured 32 ms for 20 ms frames — and the client's ~170 ms
    // ring buffer starves, which is heard as crackle/noise.
    // Real wall clock on purpose: `now` is the injectable ENDPOINT clock and
    // is frozen in tests, which would turn this into ever-growing sleeps.
    const start = Date.now();
    let n = 0;
    for (let off = 0; off + samplesPerFrame * 2 <= pcm.length; off += samplesPerFrame * 2, n++) {
      if (this.closed) return;
      this.onEvent?.({ t: "audio", data: pcm.subarray(off, off + samplesPerFrame * 2), sampleRate });
      const wait = start + (n + 1) * this.frameMs - Date.now();
      if (wait > 0) await sleep(wait);
    }
  }
}
