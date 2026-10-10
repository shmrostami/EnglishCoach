// Typed surface of the plain-JS audio-worklet module. The class itself is not
// testable (it extends AudioWorkletProcessor); only the factory used to
// exercise the ring buffer in tests is exported and typed here.
export function createPlaybackProcessor(): {
  ring: Float32Array;
  read: number;
  write: number;
  port: { onmessage: ((ev: { data: Float32Array }) => void) | null };
  process(_inputs: unknown, outputs: [Float32Array[]]): boolean;
};
