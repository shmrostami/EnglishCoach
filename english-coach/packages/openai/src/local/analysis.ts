import { OpenAI } from "openai";
import type { PlanDraft, SessionAnalysis } from "@ec/domain";
import { SessionAnalysisSchema, PlanDraftSchema, SKILL_CODES, isSkillCode } from "@ec/domain";
import { renderPrompt, promptMeta } from "@ec/prompts";
import type { AnalysisInput, AnalysisProvider, PlanInput } from "../providers/types.js";

/**
 * Analysis + planning over an OpenAI-compatible endpoint — the same local LLM
 * the conversation already uses (Ollama by default).
 *
 * Before this existed, `PROVIDER=local` scored sessions with the mock lexicon:
 * the mock matches three hardcoded regexes and returns fixed numbers for
 * grammar, vocabulary, coherence and interaction, so a learner's scores had no
 * relationship to what they said. The conversation was real; the assessment
 * was theatre.
 *
 * Two things the mock did implicitly and this must not:
 * 1. Pronunciation is never returned. A text model has no acoustic evidence
 *    (spec §12.1), so `capabilities.pronunciationEvidence` is false and the
 *    worker strips any number regardless. The prompt also asks for null.
 * 2. Evidence is quoted from the transcript. An observation whose `evidence`
 *    is not a substring of what the learner actually said is discarded here,
 *    not merely discouraged in the prompt — spec §8 "Do not allow an LLM to
 *    invent utterance IDs or evidence that was not supplied".
 */
export class LocalAnalysisProvider implements AnalysisProvider {
  readonly capabilities = { pronunciationEvidence: false };

  private client: OpenAI;

  constructor(private readonly opts: {
    baseURL: string;
    model: string;
    apiKey?: string;
    timeoutMs?: number;
  }) {
    this.client = new OpenAI({
      baseURL: opts.baseURL,
      apiKey: opts.apiKey ?? "",
      timeout: opts.timeoutMs ?? 180_000, // a small local model on CPU is slow
      maxRetries: 1,
    });
  }

  async analyze(input: AnalysisInput): Promise<SessionAnalysis> {
    const transcript = input.transcript
      .map((t) => `${t.speaker === "learner" ? "Learner" : "Coach"}: ${t.text}`)
      .join("\n");
    const prompt = renderPrompt("analysis", {
      metrics: JSON.stringify(input.metrics),
      learner_context: JSON.stringify(input.learnerContext),
      targets: input.sessionTargets.join(", ") || "none",
      transcript,
      skill_codes: SKILL_CODES.join("\n"),
    }) + LOCAL_ANALYSIS_SUFFIX;

    const text = await this.complete(prompt);
    const parsed = SessionAnalysisSchema.parse(repairAnalysis(parseJsonLoose(text)));
    // Pronunciation is not this provider's to give, whatever the model wrote.
    const analysis: SessionAnalysis = {
      ...parsed,
      scores: { ...parsed.scores, pronunciation: null },
      observations: parsed.observations.filter((o) =>
        evidenceIsGrounded(o.evidence, input.transcript),
      ),
    };
    return analysis;
  }

  async plan(input: PlanInput): Promise<PlanDraft> {
    const prompt = renderPrompt("planning", {
      learner_context: JSON.stringify(input.learnerContext),
      difficulty: String(input.difficulty),
      candidates: input.candidates.map((c, i) => `${i + 1}. ${c}`).join("\n"),
      recent_topics: input.learnerContext.recentTopics.join("; ") || "none",
    });
    return PlanDraftSchema.parse(parseJsonLoose(await this.complete(prompt)));
  }

  /** Chat completion; a local endpoint may not support the Responses API. */
  private async complete(prompt: string): Promise<string> {
    const res = await this.client.chat.completions.create({
      model: this.opts.model,
      temperature: promptMeta("analysis").temperature,
      // A 3B model needs room to finish the JSON; the default budget truncates
      // a long observations array mid-object.
      max_tokens: 2048,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: "Return the JSON object now. JSON only, no prose." },
      ],
    });
    const content = res.choices[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error(
        `local analysis endpoint returned an empty reply (finish_reason: ${res.choices[0]?.finish_reason ?? "unknown"})`,
      );
    }
    return content;
  }
}

/**
 * True when the observation's quote actually appears in something the learner
 * said. Compared on collapsed whitespace and case, because a transcription
 * quote may differ in spacing without being invented.
 */
export function evidenceIsGrounded(
  evidence: string,
  transcript: { speaker: "learner" | "coach"; text: string }[],
): boolean {
  const quote = normalize(evidence);
  if (quote.length === 0) return false;
  // An observation is about the learner, so it must be grounded in learner
  // speech — not in the coach's own words.
  return transcript.some((t) => t.speaker === "learner" && normalize(t.text).includes(quote));
}

/**
 * Case, whitespace and punctuation-insensitive comparison.
 *
 * A model that quotes the transcript back usually reproduces the learner's
 * typography, but not always: a straight apostrophe can come back curly and a
 * hyphen as an en dash. Those are the same sentence, so they must not be
 * treated as invented evidence.
 */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extra rules for a small local model.
 *
 * The shared prompt uses placeholders like "<quote from transcript>"; a 3B
 * model copies those literally instead of filling them in, and a literal
 * "<quote>" is not evidence — it is dropped by the grounding check. Saying so
 * explicitly is the difference between a usable analysis and an empty one.
 */
const LOCAL_ANALYSIS_SUFFIX = `

IMPORTANT — fill every placeholder with real content:
- "evidence" MUST be an exact substring of what the Learner said. Copy it
  character for character. Never write <quote>, <optional>, or any other
  placeholder.
- "actual" MUST be copied CHARACTER FOR CHARACTER from "evidence" — the
  shortest fragment that is wrong. If the evidence says "I go to the market",
  then "actual" is "I go" — not "I goes", not "I go to the market". Do not
  correct it, rephrase it, or fix its spelling. It must appear in the
  evidence exactly as written.
- "expected" MUST be the corrected form of that same fragment, so it should be
  the same length and shape: "I went".
- Use only skill codes from the list above. Never invent one.
- If you are unsure about an observation, leave the observations array empty
  rather than guessing.
- "type" MUST be exactly one of: language_error, strength, vocabulary_use,
  fluency_signal. Never write the pipe-separated list.`;

const OBSERVATION_TYPES = ["language_error", "strength", "vocabulary_use", "fluency_signal"] as const;

/**
 * Repairs a small model's shape errors before validation (spec §8: "Validate
 * all outputs with runtime schemas and reject or repair invalid results").
 *
 * The repairs are mechanical and never invent a measurement:
 * - a pipe-separated enum (`"language_error|strength|..."`) becomes its first
 *   member — a 3B model often copies the prompt's placeholder list verbatim;
 * - a numeric string becomes a number;
 * - a missing pronunciation score becomes null, which is the honest value.
 *
 * A value that cannot be repaired is left alone, and the schema then rejects
 * it — which fails the job rather than producing a fabricated analysis.
 */
export function repairAnalysis(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const obj = raw as Record<string, unknown>;

  if (obj.scores && typeof obj.scores === "object") {
    const scores = { ...(obj.scores as Record<string, unknown>) };
    for (const key of Object.keys(scores)) scores[key] = toNumber(scores[key]);
    if (scores.pronunciation === undefined) scores.pronunciation = null;
    obj.scores = scores;
  }

  if (Array.isArray(obj.observations)) {
    // Same for observations: an observation about a skill that does not exist
    // cannot be applied to the learner model, so it is dropped rather than
    // repaired into something plausible.
    obj.observations = obj.observations
      .filter((o) => o && typeof o === "object" && isSkillCode(String((o as Record<string, unknown>).skill)))
      .map((o) => {
        const obs = { ...(o as Record<string, unknown>) };
        obs.type = repairEnum(obs.type, OBSERVATION_TYPES);
        obs.confidence = toConfidence(obs.confidence);
        obs.severity = obs.severity === undefined ? undefined : toNumber(obs.severity);
        return obs;
      })
      // The wrong form must actually be in the quoted sentence. When it is
      // not, the model attributed an error to a sentence that does not contain
      // it. The observation is dropped only if the wrong form also appears
      // NOWHERE in the learner's speech — a form that is simply a phrase
      // rather than a token ("I go home and I watch a movie") still counts.
      .filter((o) => {
        const obs = o as Record<string, unknown>;
        if (typeof obs.actual !== "string" || obs.actual.length === 0) return true;
        if (typeof obs.evidence !== "string") return false;
        return normalize(obs.evidence).includes(normalize(obs.actual));
      })
      // A small model often emits the same observation once per turn. These
      // are one mistake, and counting them as three inflates the recurrence
      // the learner model learns from.
      .filter((o, i, all) => {
        const key = (x: unknown) => JSON.stringify([
          (x as Record<string, unknown>).type,
          (x as Record<string, unknown>).skill,
          (x as Record<string, unknown>).evidence,
          (x as Record<string, unknown>).actual,
        ]);
        return all.findIndex((y) => key(y) === key(o)) === i;
      });
  }

  if (Array.isArray(obj.strengths)) {
    // A strength with an invented skill code is dropped: the skill vocabulary is
    // closed, so an unknown code is a mistake, not a new skill.
    obj.strengths = obj.strengths
      .filter((s) => s && typeof s === "object" && isSkillCode(String((s as Record<string, unknown>).skill)))
      .map((s) => {
        const strength = { ...(s as Record<string, unknown>) };
        strength.confidence = toConfidence(strength.confidence);
        return strength;
      });
  }

  if (Array.isArray(obj.recurring_errors)) {
    obj.recurring_errors = obj.recurring_errors
      .filter((e) => e && typeof e === "object" && isSkillCode(String((e as Record<string, unknown>).skill)))
      .map((e) => {
        const err = { ...(e as Record<string, unknown>) };
        err.confidence = toConfidence(err.confidence);
        return err;
      });
  }

  if (Array.isArray(obj.recommended_targets)) {
    obj.recommended_targets = obj.recommended_targets.filter((t) => isSkillCode(String(t)));
  }

  return obj;
}

function repairEnum(value: unknown, options: readonly string[]): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (options.includes(trimmed)) return trimmed;
  // The model copied the prompt's option list — take the first real member.
  if (trimmed.includes("|")) {
    const first = trimmed.split("|").map((s) => s.trim()).find((s) => options.includes(s));
    if (first) return first;
  }
  return value;
}

/**
 * Ceiling on a model's self-reported confidence.
 *
 * A 3B model asked for a 0..1 number will answer 1.0, and the engine treats
 * confidence >= 0.8 as "recurring" — so an unbounded 1.0 would let an
 * unreviewed guess harden into a tracked error pattern. The cap only lowers
 * overconfidence; it never raises a number (spec §7.1: confidence must
 * reflect evidence, not just that a session happened).
 */
const MAX_MODEL_CONFIDENCE = 0.95;

function toConfidence(value: unknown): unknown {
  const n = toNumber(value);
  if (typeof n === "number" && n > MAX_MODEL_CONFIDENCE) return MAX_MODEL_CONFIDENCE;
  return n;
}

function toNumber(value: unknown): unknown {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return value;
}

/**
 * Extracts the JSON object from a model reply.
 *
 * Handles fences, a leading sentence, and — the case a small model actually
 * produces — a reply truncated mid-object because it ran out of tokens. The
 * truncated case is salvaged by closing the open structure, so a reply that
 * got 90% of the way through still yields the parts that were complete.
 */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  if (start === -1) {
    throw new Error(`provider returned no JSON object; reply began: ${text.slice(0, 200).replace(/\s+/g, " ")}`);
  }
  const end = trimmed.lastIndexOf("}");
  if (end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // Fall through to the salvage path — the tail may be prose after a
      // truncated object.
    }
  }
  const salvaged = salvageTruncated(trimmed.slice(start));
  if (salvaged) return salvaged;
  throw new Error("provider returned no JSON object");
}

/**
 * Closes a truncated JSON object by dropping the incomplete tail and
 * balancing the brackets. Returns null when nothing usable survives.
 */
function salvageTruncated(text: string): unknown | null {
  // Walk the text tracking string state and bracket depth, remembering the
  // last position where the object was certainly complete (a value ended).
  let depth = 0;
  let inString = false;
  let escaped = false;
  let lastComplete = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{" || ch === "[") { depth++; continue; }
    if (ch === "}" || ch === "]") {
      depth--;
      // A closed value inside an open structure is a safe truncation point.
      if (depth >= 1) lastComplete = i;
      continue;
    }
    if (depth >= 1 && ch === ",") lastComplete = i - 1;
  }
  if (lastComplete < 0) return null;
  let head = text.slice(0, lastComplete + 1).trimEnd();
  // A trailing comma before the cut must go.
  head = head.replace(/,\s*$/, "");
  // Close whatever is still open.
  const open: string[] = [];
  let inStr = false;
  let esc = false;
  for (const ch of head) {
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{" || ch === "[") open.push(ch);
    else if (ch === "}" || ch === "]") open.pop();
  }
  for (let i = open.length - 1; i >= 0; i--) open[i] === "{" ? head += "}" : (head += "]");
  try {
    return JSON.parse(head);
  } catch {
    return null;
  }
}
