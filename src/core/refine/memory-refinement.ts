import type { MemorySignal, MemoryProposal } from "../memory-types";
import { MemoryProposalArraySchema } from "../memory-types";
import { MEMORY_REFINEMENT_SYSTEM_PROMPT } from "./memory-prompts";
import { readMemoryIndex } from "../store/memory-md";
import type { LLMClient } from "./refinement";

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

export async function refineMemory(
  signals: MemorySignal[],
  llm: LLMClient,
  existingIndex?: string,
  model?: string,
): Promise<MemoryProposal[]> {
  if (signals.length === 0) return [];

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
  } catch {
    return [];
  }

  const result = MemoryProposalArraySchema.safeParse(parsed);
  if (!result.success) return [];

  return result.data.filter((p) => p.content.length > 0);
}
