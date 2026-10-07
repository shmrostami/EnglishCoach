export type ClientMessage =
  | { t: "audio"; data: string }
  | { t: "control"; action: "start" | "end" | "mute" | "unmute" };

export type ServerMessage =
  | { t: "audio"; data: string; sampleRate: number }
  | { t: "transcript"; speaker: "learner" | "coach"; text: string; seq: number; startedAt: number; endedAt: number }
  | { t: "state"; state: string }
  | { t: "intervention"; kind: "micro_coach" | "target_retry" | "challenge"; skill: string }
  | { t: "session_ended"; state: string };
