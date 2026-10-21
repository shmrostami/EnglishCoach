import { OpenAI } from "openai";
import {
  LearnerContext, PlanDraft, SessionAnalysis,
  PlanDraftSchema, SessionAnalysisSchema, SKILL_CODES,
} from "@ec/domain";
import { loadPrompt, promptMeta } from "@ec/prompts";
import type { AnalysisInput, AnalysisProvider } from "../providers/types.js";
import { MODEL_CONFIG } from "../models.js";

export class OpenAIAnalysisProvider implements AnalysisProvider {
  // The model reads text, not audio: it cannot ground a pronunciation score
  // (spec §12.1), so the worker strips any number it returns.
  readonly capabilities = { pronunciationEvidence: false };

  private client: OpenAI;
  constructor(private readonly apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async analyze(input: AnalysisInput): Promise<SessionAnalysis> {
    const transcript = input.transcript
      .map((t) => `${t.speaker === "learner" ? "Learner" : "Coach"}: ${t.text}`)
      .join("\n");
    const prompt = loadPrompt("analysis")
      .replace("{{metrics}}", JSON.stringify(input.metrics))
      .replace("{{learner_context}}", JSON.stringify(input.learnerContext))
      .replace("{{targets}}", input.sessionTargets.join(", ") || "none")
      .replace("{{transcript}}", transcript)
      .replace("{{skill_codes}}", SKILL_CODES.join("\n"));

    const res = await this.client.responses.create({
      model: MODEL_CONFIG.analysis,
      temperature: promptMeta("analysis").temperature,
      instructions: prompt,
      input: "Return the SessionAnalysis JSON now.",
    });
    const text = (res.output_text as string) ?? "";
    return SessionAnalysisSchema.parse(parseJsonLoose(text));
  }

  async plan(input: { difficulty: number; candidates: string[]; learnerContext: LearnerContext }): Promise<PlanDraft> {
    const prompt = loadPrompt("planning")
      .replace("{{learner_context}}", JSON.stringify(input.learnerContext))
      .replace("{{difficulty}}", String(input.difficulty))
      .replace("{{candidates}}", input.candidates.map((c, i) => `${i + 1}. ${c}`).join("\n"))
      .replace("{{recent_topics}}", input.learnerContext.recentTopics.join("; ") || "none");

    const res = await this.client.responses.create({
      model: MODEL_CONFIG.analysis,
      temperature: promptMeta("planning").temperature,
      instructions: prompt,
      input: "Return the plan JSON now.",
    });
    return PlanDraftSchema.parse(parseJsonLoose((res.output_text as string) ?? ""));
  }
}

/** Providers sometimes wrap JSON in markdown fences; extract the first {...} block. */
function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("provider returned no JSON object");
  return JSON.parse(trimmed.slice(start, end + 1));
}
