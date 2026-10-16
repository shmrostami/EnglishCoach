/**
 * Endpoint detection for the local voice provider. Pure: 20 ms PCM16
 * frames go in, turn spans come out. No timers, no sockets — a fake
 * clock makes every boundary testable. The adaptive RMS floor is what
 * keeps ambient noise (and Whisper's hallucination-on-silence) from
 * ever reaching the model: a turn must be VOICED before any audio is
 * buffered, and pure-silence streams never open a turn at all.
 */
export interface EndpointSpan {
  startedAt: number;
  endedAt: number;
  audio: Buffer;
}

interface FrameTime {
  rms: number;
  at: number;
}

export class VoiceEndpoint {
  private readonly now: () => number;
  private floor = 0.0001;
  private frames: FrameTime[] = [];
  private open = false; // an explicit flag — startedAt may legitimately be 0
  private startedAt = 0;
  private buffer: Buffer[] = [];
  private voicedFrames = 0;
  private lastVoicedAt = 0;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  push(frame: Buffer): EndpointSpan | null {
    const at = this.now();
    const f = { rms: rms(frame), at };
    this.frames.push(f);
    if (this.frames.length > 16) this.frames.shift();

    const threshold = Math.max(this.floor * 3, 0.0005);
    const voiced = f.rms >= threshold;

    if (voiced) {
      if (!this.open) { this.open = true; this.startedAt = at; }
      this.buffer.push(frame);
      this.voicedFrames += 1;
      this.lastVoicedAt = at;
    }

    // Adaptive floor: silent frames only — the rolling average of the recent
    // window tracks ambient noise, so a real utterance (above floor × 3) still
    // registers after the tail of the last one.
    if (!voiced) {
      const avg = this.frames.reduce((a, x) => a + x.rms, 0) / this.frames.length;
      this.floor = Math.max(avg, 0.0001);
    }

    if (!this.open) return null; // pure-silence stream: never opens a turn

    // 300 ms minimum VOICED span before a turn is real (drops clicks).
    // Measured as lastVoicedAt - startedAt, NOT wall-clock since open: a
    // blip is two voiced frames then silence, so once silent frames stop
    // advancing lastVoicedAt the span freezes (~200 ms) and the turn is
    // dropped even though the clock has long passed 300 ms.
    if (this.voicedFrames === 0 || this.lastVoicedAt - this.startedAt < 300) {
      // A gap > 600 ms with no re-voicing abandons the half-open turn.
      if (!voiced && at - this.lastVoicedAt > 600) this.abandon();
      return null;
    }

    // 600 ms of trailing silence ends the turn…
    if (at - this.lastVoicedAt >= 600) return this.finish(at);
    // …or the 15 s hard cap does.
    if (at - this.startedAt >= 15_000) return this.finish(at);
    return null;
  }

  private finish(at: number): EndpointSpan {
    const span = { startedAt: this.startedAt, endedAt: at, audio: Buffer.concat(this.buffer) };
    this.reset();
    return span;
  }

  private abandon(): void {
    this.open = false;
    this.startedAt = 0;
    this.buffer = [];
    this.voicedFrames = 0;
    this.lastVoicedAt = 0;
  }

  reset(): void {
    this.abandon();
    this.frames = [];
    this.floor = 0.0001;
  }
}

function rms(frame: Buffer): number {
  if (frame.length < 2) return 0;
  let sum = 0;
  const n = frame.length >> 1;
  for (let i = 0; i < n; i++) {
    const s = frame.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}
