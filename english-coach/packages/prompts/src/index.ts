import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

// No "memory" prompt: learner memory is written deterministically by the
// learning engine, and spec §16.5 forbids an LLM mutating authoritative learner
// state. The prompt that existed for it was registered but never called.
export type PromptName = "conversation" | "analysis" | "planning";

export interface PromptVersion {
  name: PromptName;
  version: string;
  model: string;
  temperature: number;
}

const REGISTRY: Record<PromptName, PromptVersion & { file: string }> = {
  conversation: { name: "conversation", version: "v1", model: "realtime", temperature: 0.7, file: "conversation/v1.txt" },
  analysis: { name: "analysis", version: "v1", model: "responses", temperature: 0.2, file: "analysis/v1.txt" },
  planning: { name: "planning", version: "v1", model: "responses", temperature: 0.4, file: "planning/v1.txt" },
};

export function promptMeta(name: PromptName): PromptVersion {
  const { file: _file, ...meta } = REGISTRY[name];
  return meta;
}

export function loadPrompt(name: PromptName): string {
  return readFileSync(path.join(root, "../prompts", REGISTRY[name].file), "utf8");
}

export function renderPrompt(name: PromptName, vars: Record<string, string>): string {
  return loadPrompt(name).replace(/\{\{(\w+)\}\}/g, (m, key: string) => (key in vars ? vars[key] : m));
}
