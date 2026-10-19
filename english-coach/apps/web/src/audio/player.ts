import { SincResampler, base64ToBytes, pcm16ToFloat } from "./pcm.js";

export interface Player {
  playBase64(b64: string, sampleRate: number): void;
  start(): Promise<void>;
  stop(): void;
}

export async function createPlayer(): Promise<Player> {
  // The context runs at the device's native rate (the browser default, which
  // is always honored), and the incoming audio - 22050 Hz from Piper,
  // 24 kHz from OpenAI Realtime, 16 kHz mock silence - is resampled to that
  // rate in JS by a windowed-sinc filter whose spectral images are 80+ dB
  // down. The earlier approach asked for a 22050 Hz context and let the
  // browser do 22050 -> device; that only stayed clean when the browser
  // honored the rate AND its own output resampler was band-limited, which
  // the user's machine was not. With the JS resampler producing samples at
  // the context's own rate, the browser never resamples at all.
  // SincResampler carries a short history between chunks so the 20 ms frame
  // boundaries are audibly invisible (see pcm.ts).
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule(new URL("./worklet.js", import.meta.url).toString());
  const resampler = new SincResampler();
  let node: AudioWorkletNode | null = null;
  return {
    async start() { await ctx.resume(); },
    playBase64(b64: string, sampleRate: number) {
      if (!node) {
        node = new AudioWorkletNode(ctx, "ec-playback");
        node.connect(ctx.destination);
      }
      const u8 = base64ToBytes(b64);
      const pcm = new Int16Array(u8.buffer, u8.byteOffset, Math.floor(u8.byteLength / 2));
      const float = resampler.push(pcm16ToFloat(pcm), sampleRate, ctx.sampleRate);
      node.port.postMessage(float);
    },
    // Idempotent: a second stop() (e.g. the user clicks End twice) must not
    // call close() on an already-closed AudioContext - that throws
    // InvalidStateError as an unhandled rejection.
    stop() { if (ctx.state === "closed") return; node?.disconnect(); node = null; void ctx.close(); },
  };
}
