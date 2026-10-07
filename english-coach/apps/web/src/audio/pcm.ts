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
