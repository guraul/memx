import type { StyleSignal, StyleProposal } from "../types";
import { StyleProposalArraySchema } from "../types";
import { REFINEMENT_SYSTEM_PROMPT } from "./prompts";
import { readUserMd } from "../store/user-md";
import type { RefineOutcome } from "./refine-outcome";
import { formatIssues, snippet } from "./refine-outcome";

export interface LLMClient {
  chat(params: {
    system: string;
    messages: Array<{ role: string; content: string }>;
    temperature?: number;
    maxTokens?: number;
    model?: string;
  }): Promise<string>;
}

/** P0-3(b)：给快照内容加行号前缀，`target_line` 兜底寻址时行号有据可依。
 * 行号 = 该行在 USER.md 文件里的 1-based 行号（与 parseUserMd 的 lineNumber 同源）。 */
export function numberLines(content: string): string {
  if (!content.trim()) return "(空)";
  return content
    .split("\n")
    .map((line, i) => `${String(i + 1).padStart(3, " ")}| ${line}`)
    .join("\n");
}

export function buildUserMessage(signals: StyleSignal[], existingUserMd: string): string {
  const signalLines = signals
    .map(
      (s, i) =>
        `${i + 1}. [${s.category}] ${s.content} (confidence: ${s.confidence}, source: ${s.source})`,
    )
    .join("\n");

  return `现有风格信号:\n${signalLines}\n\n现有 USER.md 内容（左边是行号，供 target_line 使用）:\n${numberLines(existingUserMd)}\n\n请分析以上信号，判断哪些值得记录为长期偏好，输出 StyleProposal 数组。`;
}

export function extractJson(raw: string): string {
  const trimmed = raw.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1]!.trim();
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

/** P0-2：三态返回（合法空数组 / 坏 JSON / schema 失败），不再一律 `[]` */
export async function refine(
  signals: StyleSignal[],
  llm: LLMClient,
  existingContent?: string,
  model?: string,
): Promise<RefineOutcome<StyleProposal>> {
  if (signals.length === 0) return { kind: "adjudicated-empty", reason: "no-signals" };

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
  } catch (err) {
    return {
      kind: "invalid-output",
      error: `json-parse: ${err instanceof Error ? err.message : String(err)}`,
      rawSnippet: snippet(raw),
    };
  }

  const result = StyleProposalArraySchema.safeParse(parsed);
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
