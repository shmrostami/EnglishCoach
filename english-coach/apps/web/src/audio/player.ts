import { resampleLinear, base64ToBytes, pcm16ToFloat } from "./pcm.js";

export interface Player {
  playBase64(b64: string, sampleRate: number): void;
  start(): Promise<void>;
  stop(): void;
}

export async function createPlayer(): Promise<Player> {
  // The local backend (Piper en_US-ryan-medium) emits 22050 Hz, so run the
  // context at that native rate: its playBase64 resampleLinear hits the
  // inRate===outRate fast path (no JS resampling) and the browser's
  // band-limited output resampler handles 22050→device. A naive linear
  // 22050→48000 upsample would inject spectral images that read as a
  // hissy/metallic shimmer. The OpenAI Realtime backend emits 24 kHz, so its
  // path takes a 24000→22050 resample here — a downsample, which does not
  // create the wide-band spectral images an upsample does. (Mock chunks are
  // 16 kHz silence — zeros resample to zeros, so that case is harmless.)
  const ctx = new AudioContext({ sampleRate: 22050 });
  await ctx.audioWorklet.addModule(new URL("./worklet.js", import.meta.url).toString());
  let node: AudioWorkletNode | null = null;
  let rate = ctx.sampleRate;
  return {
    async start() { await ctx.resume(); },
    playBase64(b64: string, sampleRate: number) {
      rate = sampleRate;
      if (!node) {
        node = new AudioWorkletNode(ctx, "ec-playback");
        node.connect(ctx.destination);
      }
      const u8 = base64ToBytes(b64);
      const pcm = new Int16Array(u8.buffer, u8.byteOffset, Math.floor(u8.byteLength / 2));
      const float = resampleLinear(pcm16ToFloat(pcm), sampleRate, ctx.sampleRate);
      node.port.postMessage(float);
    },
    // Idempotent: a second stop() (e.g. the user clicks End twice) must not
    // call close() on an already-closed AudioContext — that throws
    // InvalidStateError as an unhandled rejection.
    stop() { if (ctx.state === "closed") return; node?.disconnect(); node = null; void ctx.close(); },
  };
}
