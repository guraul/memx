import type { StyleSignal, StyleProposal } from "../types.ts";
import { StyleProposalSchema } from "../types.ts";
import { REFINEMENT_SYSTEM_PROMPT } from "./prompts.ts";
import { readUserMd } from "../store/user-md.ts";
import type { RefineOutcome } from "./refine-outcome.ts";
import { formatIssues, snippet } from "./refine-outcome.ts";

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

  if (!Array.isArray(parsed)) {
    return {
      kind: "invalid-output",
      error: "schema: (root): expected array",
      rawSnippet: snippet(raw),
    };
  }

  if (parsed.length === 0) return { kind: "adjudicated-empty", reason: "llm-empty" };

  // #9 补丁：逐条校验。一条坏提案（如空 content 的 append）只丢弃自己，
  // 不再让同批合法提案陪跑成 invalid-output。
  const valid: StyleProposal[] = [];
  const warnings: string[] = [];
  parsed.forEach((item, i) => {
    const one = StyleProposalSchema.safeParse(item);
    if (one.success) {
      valid.push(one.data);
    } else {
      warnings.push(`proposal[${i}] dropped: ${formatIssues(one.error.issues)}`);
    }
  });

  // 全部条目都坏 → 仍按 invalid-output（保持原有语义：保留缓冲重试）
  if (valid.length === 0) {
    return {
      kind: "invalid-output",
      error: `schema: all ${parsed.length} proposals invalid: ${warnings.join("; ").slice(0, 300)}`,
      rawSnippet: snippet(raw),
    };
  }

  // #9：deprecate 不需要新内容（只按 target 定位），空 content 的废弃提案必须保留；
  // append/update 的空内容仍丢弃（schema 已拦一道，这里防御式再挡一次）。
  const proposals = valid.filter((p) => p.action === "deprecate" || p.content.length > 0);
  if (proposals.length === 0) return { kind: "adjudicated-empty", reason: "all-filtered" };

  if (warnings.length === 0) return { kind: "proposals", proposals };
  return { kind: "proposals", proposals, dropped: warnings.length, warnings };
}
