const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToBase64(u8: Uint8Array): string {
  let out = "";
  const len = u8.length;
  for (let i = 0; i < len; i += 3) {
    const b1 = u8[i];
    const b2 = i + 1 < len ? u8[i + 1] : 0;
    const b3 = i + 2 < len ? u8[i + 2] : 0;
    out += B64[(b1 >> 2) & 63];
    out += B64[((b1 & 3) << 4) | ((b2 >> 4) & 15)];
    out += i + 1 < len ? B64[((b2 & 15) << 2) | ((b3 >> 6) & 3)] : "=";
    out += i + 2 < len ? B64[b3 & 63] : "=";
  }
  return out;
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/=+$/, "");
  const outLen = Math.floor((clean.length * 3) / 4);
  const u8 = new Uint8Array(outLen);
  let j = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const idx = (k: number) => (k < clean.length ? B64.indexOf(clean[k]) : 0);
    const e1 = idx(i);
    const e2 = idx(i + 1);
    const e3 = idx(i + 2);
    const e4 = idx(i + 3);
    const n = (e1 << 18) | (e2 << 12) | (e3 << 6) | e4;
    u8[j++] = (n >> 16) & 255;
    if (j < u8.length) u8[j++] = (n >> 8) & 255;
    if (j < u8.length) u8[j++] = n & 255;
  }
  return u8;
}

export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export function pcm16ToFloat(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = input[i] / 0x8000;
  return out;
}

export function resampleLinear(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate) return input.slice();
  const ratio = inRate / outRate;
  const outLen = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIdx = i * ratio;
    const i0 = Math.min(Math.floor(srcIdx), input.length - 1);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcIdx - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

// High-quality resampler for the playback path (source rate -> the
// AudioContext's native device rate). Naive linear interpolation
// (resampleLinear) leaves images of the input spectrum at multiples of the
// source rate: a 22050 -> 48000 upsample mirrors the voice band into the
// 11-24 kHz range, which reads as a hissy/metallic shimmer. Windowed-sinc
// with cutoff at the lower Nyquist pushes those images 80+ dB down.
const K = 32; // Hann window half-length (65 taps at alpha === 1)
// ponytail: fixed tap count; a heavy downsample (source far above the
// device rate, alpha << 1) would need ~K/alpha taps to hold the same
// attenuation. Every real rate pair here (16k/22050/24k -> 44.1k/48k)
// keeps K/alpha <= 4.

// Streaming windowed-sinc resampler. TTS audio arrives in ~20 ms frames,
// but the window reaches back into the past: resampling each frame in
// isolation leaves a partial window at every frame edge, modulating the
// signal at the frame rate. Keeping a short tail of previous samples
// (history) makes each frame bit-identical to resampling the whole
// utterance at once, so frame boundaries are invisible.
export class SincResampler {
  private inRate = 0;
  private outRate = 0;
  private totalIn = 0;
  private emitted = 0;
  private history: Float32Array = new Float32Array(0);

  reset(): void {
    this.inRate = 0;
    this.outRate = 0;
    this.totalIn = 0;
    this.emitted = 0;
    this.history = new Float32Array(0);
  }

  // Append a chunk of input samples and return the newly produced output
  // samples (empty when the chunk yields none). A rate change resets the
  // stream, so the caller may mix sources at different rates.
  push(chunk: Float32Array, inRate: number, outRate: number): Float32Array {
    if (inRate !== this.inRate || outRate !== this.outRate) this.reset();
    this.inRate = inRate;
    this.outRate = outRate;
    if (chunk.length === 0) return new Float32Array(0);
    if (inRate === outRate) {
      this.totalIn += chunk.length;
      this.emitted = this.totalIn;
      this.history = new Float32Array(0);
      return chunk.slice();
    }
    const ratio = inRate / outRate; // input samples per output sample
    const alpha = 1 / Math.max(1, ratio); // cutoff at the lower Nyquist, input-normalized
    const keff = Math.ceil(K / alpha) + 1; // furthest tap offset in input samples
    const buffer = new Float32Array(this.history.length + chunk.length);
    buffer.set(this.history);
    buffer.set(chunk, this.history.length);
    const base = this.totalIn - this.history.length; // input position of buffer[0]
    const total = this.totalIn + chunk.length;
    // Hold back the window's forward reach: output sample n is centered on
    // input position n*ratio and reads up to K/alpha samples AHEAD of it, so
    // it is only computable once total >= n*ratio + keff. Emitting samples
    // whose window extends past the received audio would clip it (and the
    // clipped window distorts every frame tail), so those samples wait for
    // the next push. Cost: ~keff/ratio output samples of latency (~2 ms).
    const target = Math.floor((total - keff) / ratio);
    const outLen = Math.max(0, Math.min(target, Math.round(total / ratio)) - this.emitted);
    const out = new Float32Array(outLen);
    for (let n = 0; n < outLen; n++) {
      const p = (this.emitted + n) * ratio; // input position this output sample is centered on
      const i0 = Math.floor(p);
      let acc = 0;
      let norm = 0;
      for (let m = -keff; m <= keff; m++) {
        const x = alpha * (p - (i0 + m));
        if (x < -K || x > K) continue;
        const j = i0 + m - base; // into buffer
        if (j < 0 || j >= buffer.length) continue; // outside the audio we hold: drop the tap AND its weight (normalizes partial windows at the stream edges)
        const w = 0.5 * (1 + Math.cos((Math.PI * x) / K));
        const s = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        const h = alpha * s * w;
        norm += h;
        acc += h * buffer[j];
      }
      out[n] = acc / norm;
    }
    this.totalIn = total;
    this.emitted += outLen;
    // Keep history back to where the NEXT push's first sample reaches:
    // that sample is centered on emitted*ratio >= total - keff - ratio, and
    // its window extends another keff before that. 2*keff+2 covers both
    // directions for any inRate <= outRate pair.
    const keep = Math.min(2 * keff + 2, total);
    this.history = new Float32Array(keep);
    this.history.set(buffer.subarray(buffer.length - keep));
    return out;
  }

  // Emit the samples push() held back (their window extends past the
  // received audio). The window is clipped exactly as a one-shot resample of
  // the whole utterance clips it at the end, so the tail is bit-identical.
  flush(): Float32Array {
    if (this.inRate === 0) return new Float32Array(0);
    if (this.inRate === this.outRate) return new Float32Array(0); // push already emitted everything
    const ratio = this.inRate / this.outRate;
    const alpha = 1 / Math.max(1, ratio);
    const keff = Math.ceil(K / alpha) + 1;
    const outLen = Math.max(0, Math.round(this.totalIn / ratio) - this.emitted);
    const out = new Float32Array(outLen);
    const buffer = this.history;
    const base = this.totalIn - buffer.length;
    for (let n = 0; n < outLen; n++) {
      const p = (this.emitted + n) * ratio;
      const i0 = Math.floor(p);
      let acc = 0;
      let norm = 0;
      for (let m = -keff; m <= keff; m++) {
        const x = alpha * (p - (i0 + m));
        if (x < -K || x > K) continue;
        const j = i0 + m - base;
        if (j < 0 || j >= buffer.length) continue;
        const w = 0.5 * (1 + Math.cos((Math.PI * x) / K));
        const s = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        const h = alpha * s * w;
        norm += h;
        acc += h * buffer[j];
      }
      out[n] = acc / norm;
    }
    this.emitted += outLen;
    this.history = new Float32Array(0);
    return out;
  }
}

// One-shot form (no history between calls). push() holds back the tail
// samples whose window reaches past the input, so flush() appends them
// (clipped at the end) to return the complete resampled signal.
export function resampleSinc(input: Float32Array, inRate: number, outRate: number): Float32Array {
  const r = new SincResampler();
  const body = r.push(input, inRate, outRate);
  const tail = r.flush();
  if (tail.length === 0) return body;
  const full = new Float32Array(body.length + tail.length);
  full.set(body);
  full.set(tail, body.length);
  return full;
}
