import type { StyleSignal, StyleProposal } from "../types";
import { StyleProposalArraySchema } from "../types";
import { REFINEMENT_SYSTEM_PROMPT } from "./prompts";
import { readUserMd } from "../store/user-md";

export interface LLMClient {
  chat(params: {
    system: string;
    messages: Array<{ role: string; content: string }>;
    temperature?: number;
    maxTokens?: number;
    model?: string;
  }): Promise<string>;
}

function buildUserMessage(signals: StyleSignal[], existingUserMd: string): string {
  const signalLines = signals
    .map(
      (s, i) =>
        `${i + 1}. [${s.category}] ${s.content} (confidence: ${s.confidence}, source: ${s.source})`,
    )
    .join("\n");

  return `现有风格信号:\n${signalLines}\n\n现有 USER.md 内容:\n${existingUserMd || "(空)"}\n\n请分析以上信号，判断哪些值得记录为长期偏好，输出 StyleProposal 数组。`;
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

export async function refine(
  signals: StyleSignal[],
  llm: LLMClient,
  existingContent?: string,
  model?: string,
): Promise<StyleProposal[]> {
  if (signals.length === 0) return [];

  const content = existingContent ?? readUserMd();

  const userMsg = buildUserMessage(signals, content);

  const chatParams: {
    system: string;
    messages: Array<{ role: string; content: string }>;
    temperature: number;
    maxTokens: number;
    model?: string;
  } = {
    system: REFINEMENT_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMsg }],
    temperature: 0.2,
    maxTokens: 1024,
  };
  if (model) chatParams.model = model;

  const raw = await llm.chat(chatParams);

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch {
    return [];
  }

  const result = StyleProposalArraySchema.safeParse(parsed);
  if (!result.success) return [];

  return result.data.filter((p) => p.content.length > 0);
}
