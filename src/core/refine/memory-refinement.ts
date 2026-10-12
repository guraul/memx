import type { MemorySignal, MemoryProposal } from "../memory-types";
import { MemoryProposalArraySchema } from "../memory-types";
import { MEMORY_REFINEMENT_SYSTEM_PROMPT } from "./memory-prompts";
import { readMemoryIndex } from "../store/memory-md";
import type { LLMClient } from "./refinement";
import type { RefineOutcome } from "./refine-outcome";
import { formatIssues, snippet } from "./refine-outcome";

function buildUserMessage(signals: MemorySignal[], existingIndex: string): string {
  const signalLines = signals
    .map(
      (s, i) =>
        `${i + 1}. [${s.type}] ${s.name}: ${s.description} (confidence: ${s.confidence}, source: ${s.source})`,
    )
    .join("\n");

  return `Captured memory signals:\n${signalLines}\n\nExisting MEMORY.md index:\n${existingIndex || "(empty)"}\n\nAnalyze signals and output MemoryProposal array.`;
}

function extractJson(raw: string): string {
  const trimmed = raw.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1]!.trim();
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

/** P0-2：三态返回（合法空数组 / 坏 JSON / schema 失败），不再一律 `[]` */
export async function refineMemory(
  signals: MemorySignal[],
  llm: LLMClient,
  existingIndex?: string,
  model?: string,
): Promise<RefineOutcome<MemoryProposal>> {
  if (signals.length === 0) return { kind: "adjudicated-empty", reason: "no-signals" };

  const content = existingIndex ?? readMemoryIndex();
  const userMsg = buildUserMessage(signals, content);

  const chatParams: {
    system: string;
    messages: Array<{ role: string; content: string }>;
    temperature: number;
    maxTokens: number;
    model?: string;
  } = {
    system: MEMORY_REFINEMENT_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMsg }],
    temperature: 0.2,
    maxTokens: 2048,
  };
  if (model) chatParams.model = model;

  const raw = await llm.chat(chatParams);

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch (err) {
    return {
      kind: "invalid-output",
      error: `json-parse: ${err instanceof Error ? err.message : String(err)}`,
      rawSnippet: snippet(raw),
    };
  }

  const result = MemoryProposalArraySchema.safeParse(parsed);
  if (!result.success) {
    return {
      kind: "invalid-output",
      error: `schema: ${formatIssues(result.error.issues)}`,
      rawSnippet: snippet(raw),
    };
  }

  if (result.data.length === 0) return { kind: "adjudicated-empty", reason: "llm-empty" };

  const proposals = result.data.filter((p) => p.content.length > 0);
  if (proposals.length === 0) return { kind: "adjudicated-empty", reason: "all-filtered" };

  return { kind: "proposals", proposals };
}
