/**
 * Pinned 2026-10-06 against platform.openai.com/docs/models.
 * Re-verify before a real key is plugged in (spec §16 open item 1):
 * realtime model names have changed repeatedly.
 *
 * VERIFY: docs fetch was blocked at build time (no network / enterprise
 * policy), so these are the plan's fallback placeholders, not verified
 * identifiers. The keyless guard means nothing breaks until a key is set,
 * but the first live run MUST re-check these against the live docs.
 */
export const MODEL_CONFIG = {
  realtime: "gpt-realtime-2", // VERIFY — realtime voice model id (input+output audio)
  analysis: "gpt-4.1", // VERIFY — text model id for structured-output analysis (Responses API)
  temperature: { conversation: 0.7, analysis: 0.2, planning: 0.4 },
} as const;
