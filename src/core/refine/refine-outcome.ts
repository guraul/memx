// P0-2（handoff-20261011 §4 阶段 3-2）：提炼结果的显式三态。
//
// 旧实现把三件不同的事都返回成 `[]`，调用方无法区分：
//   ① LLM 裁决"这些信号不值得存"（合法空数组 / 全部被内容过滤）= adjudicated-empty
//      → 必须**清空缓冲结案**，否则同一批已裁决信号每轮重烧一次 LLM（永远不清）
//   ② LLM 输出坏 JSON（解析失败）= invalid-output
//      → 必须**保留缓冲重试**（模型偶发抽风）
//   ③ schema 校验失败（模型理解错了 schema）= invalid-output
//      → 同上；但连续 N 次仍坏说明模型/提示词真的坏，丢弃缓冲并记报警，防无限重试
//
// 类型放独立文件：refinement.ts 与 memory-refinement.ts 都要用，而后者已依赖前者的
// LLMClient——再让前者依赖后者的东西会成环。

export type AdjudicatedEmptyReason = "no-signals" | "llm-empty" | "all-filtered";

export type RefineOutcome<T> =
  | { kind: "proposals"; proposals: T[] }
  | { kind: "adjudicated-empty"; reason: AdjudicatedEmptyReason }
  | { kind: "invalid-output"; error: string; rawSnippet: string };

/** 连续 invalid-output 达到该次数即丢弃缓冲并记报警（P0-2 上限） */
export const INVALID_OUTPUT_STREAK_LIMIT = 3;

/** 只关心"有没有可落盘提案"时的便利取值（invalid-output 视为空） */
export function proposalsOf<T>(outcome: RefineOutcome<T>): T[] {
  return outcome.kind === "proposals" ? outcome.proposals : [];
}

/** 坏输出留痕：给出报文片段，便于 memx_status / kv 定位是模型坏还是 schema 坏 */
export function snippet(raw: string, max = 200): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, max);
}

/** zod issues → 一行摘要（不打印整棵错误树） */
export function formatIssues(issues: Array<{ path: Array<string | number | symbol>; message: string }>): string {
  return issues
    .slice(0, 5)
    .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
    .join("; ")
    .slice(0, 300);
}
