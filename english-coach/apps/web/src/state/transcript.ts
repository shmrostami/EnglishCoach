export interface Turn { seq: number; speaker: string; text: string; }
export interface TranscriptState { turns: Turn[]; }
export type TranscriptMessage = Extract<import("../types/messages.js").ServerMessage, { t: "transcript" }>;

export function initialTranscript(): TranscriptState {
  return { turns: [] };
}

// Structural subset: the full wire message carries startedAt/endedAt, but the
// reducer only needs identity + speaker + text (tests exercise the subset).
export function applyTranscript(state: TranscriptState, m: { t: "transcript"; seq: number; speaker: string; text: string }): TranscriptState {
  if (state.turns.some((t) => t.seq === m.seq)) return state;
  const turns = [...state.turns, { seq: m.seq, speaker: m.speaker, text: m.text }]
    .sort((a, b) => a.seq - b.seq);
  return { turns };
}
