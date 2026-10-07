class PlaybackProcessor extends AudioWorkletProcessor {
  static get processorName() { return "ec-playback"; }
  constructor() {
    super();
    this.ring = new Float32Array(8192);
    this.read = 0;
    this.write = 0;
    this.port.onmessage = (ev) => {
      const chunk = ev.data;
      if (this.write - this.read + chunk.length > this.ring.length) {
        // drop oldest to stay bounded (underrun preferred over growing latency)
        const drop = this.read + chunk.length - this.ring.length;
        this.ring.set(this.ring.subarray(drop, this.write));
        this.read = 0;
        this.write = this.write - drop;
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
registerProcessor("ec-playback", PlaybackProcessor);
