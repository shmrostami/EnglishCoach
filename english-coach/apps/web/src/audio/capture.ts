import { floatToPcm16, resampleLinear } from "./pcm.js";

export interface Capture {
  start(onFrame: (pcm: Int16Array) => void): Promise<number>; // returns source sample rate
  stop(): void;
}

export async function createCapture(sampleRate = 16000): Promise<Capture> {
  const ctx = new AudioContext();
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const source = ctx.createMediaStreamSource(stream);
  const node = ctx.createScriptProcessor(4096, 1, 1);
  let active = false;
  let started = 0;
  let stopped = false;
  let onFrame: (pcm: Int16Array) => void = () => {};

  node.onaudioprocess = (ev) => {
    if (!active) return;
    const input = ev.inputBuffer.getChannelData(0); // ctx.sampleRate rate
    const resampled = resampleLinear(input, ctx.sampleRate, sampleRate);
    const now = Date.now();
    if (now - started >= 20 || started === 0) {
      started = now;
      onFrame(floatToPcm16(resampled));
    }
  };
  source.connect(node);
  node.connect(ctx.destination); // ScriptProcessor requires a destination to run

  return {
    start: async (cb) => { onFrame = cb; await ctx.resume(); active = true; started = 0; return ctx.sampleRate; },
    // Idempotent: a second stop() (e.g. the user clicks End twice) must not
    // close an already-closed AudioContext — that throws InvalidStateError
    // as an unhandled rejection.
    stop: () => { if (stopped) return; stopped = true; active = false; node.disconnect(); source.disconnect(); void ctx.close(); stream.getTracks().forEach((t) => t.stop()); },
  };
}
