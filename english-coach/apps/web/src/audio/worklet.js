// Exported so the ring-buffer logic is unit-testable outside the worklet
// scope. In the worklet scope the real AudioWorkletProcessor/registerProcessor
// exist; on the main thread (tests) they don't, so fall back to stubs with
// the same surface the processor uses (port.onmessage assignment).
const BaseClass = globalThis.AudioWorkletProcessor ?? class {
  constructor() { this.port = { onmessage: null }; }
};

class PlaybackProcessor extends BaseClass {
  static get processorName() { return "ec-playback"; }
  constructor() {
    super();
    this.ring = new Float32Array(8192);
    this.read = 0;
    this.write = 0;
    this.port.onmessage = (ev) => {
      const chunk = ev.data;
      if (chunk.length >= this.ring.length) {
        // pathological chunk: keep only the freshest tail rather than grow
        this.ring.set(chunk.subarray(chunk.length - this.ring.length));
        this.read = 0;
        this.write = this.ring.length;
        return;
      }
      // `write` is an absolute index, so the set below overflows the ring
      // whenever write + chunk.length > ring.length — even when the live
      // tail plus the chunk would fit. Make room by shifting the live tail
      // [read, write) down to 0, dropping the oldest floats if the chunk
      // still doesn't fit (underrun preferred over growing latency).
      if (this.write + chunk.length > this.ring.length) {
        const inUse = this.write - this.read;
        const drop = Math.max(inUse + chunk.length - this.ring.length, 0);
        this.ring.copyWithin(0, this.read + drop, this.write);
        this.read = 0;
        this.write = inUse - drop;
      }
      this.ring.set(chunk, this.write);
      this.write += chunk.length;
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    for (let i = 0; i < out.length; i++) {
      if (this.read < this.write) {
        out[i] = this.ring[this.read % this.ring.length];
        this.read++;
      } else {
        out[i] = 0;
      }
    }
    return true;
  }
}
export function createPlaybackProcessor() { return new PlaybackProcessor(); }
if (globalThis.registerProcessor) globalThis.registerProcessor("ec-playback", PlaybackProcessor);
