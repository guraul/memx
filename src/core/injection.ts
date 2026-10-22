// memx · system prompt 注入：内容装配的纯函数（无 IO，core 层零宿主依赖）。
//
// 为什么必须由插件自己注入：`opencode.json` 的 `instructions` 在 v2.0.26 是死字段——
// 宿主唯一的指令组装插件 (packages/core/src/config/plugin/instruction.ts) 只加载 AGENTS.md，
// 没有任何代码消费归一化后的 `config.instructions`。协议与 USER.md/MEMORY.md 从来没到过模型。
// 插件能触达的唯一通道是 `context` hook：宿主在 hook 触发前已经把 agent.system + AGENTS.md
// 正文放进 `event.system`（packages/core/src/session/model-request.ts:110-116），我们只**追加**，
// 绝不替换。
//
// 三块内容按固定顺序各占一个 SystemPart：协议 → Track 1 画像 → Track 2 记忆索引。
// 缺文件 = 静默跳过（不报错、不塞占位符）；三块都缺 = 一个 part 都不加。

/** 每块内容各自的行数上限。取 200 与 USER.md 写盘侧的 `isOverLimit(content, 200)` 对齐，
 *  写入端本来就会把画像压回这个量级，所以正常路径不会触发截断。 */
export const INJECT_MAX_LINES = 200;

/** 每块内容各自的字节数上限（25KB）。 */
export const INJECT_MAX_BYTES = 25 * 1024;

export interface InjectionLimits {
  maxLines: number;
  maxBytes: number;
}

export const DEFAULT_INJECT_LIMITS: InjectionLimits = {
  maxLines: INJECT_MAX_LINES,
  maxBytes: INJECT_MAX_BYTES,
};

export type InjectionSourceId = "protocol" | "user" | "memory";

/** 注入顺序即此数组顺序（协议在前：模型得先知道怎么发信号，才谈得上按画像作答）。 */
export const INJECTION_SOURCE_ORDER: readonly InjectionSourceId[] = ["protocol", "user", "memory"] as const;

export interface InjectionSources {
  protocol?: string | null | undefined;
  user?: string | null | undefined;
  memory?: string | null | undefined;
}

/** 与宿主 SystemPart 结构兼容的最小文本 part（core 不 import 宿主自己的 AI 包，hook 现场转型）。 */
export interface InjectionPart {
  type: "text";
  text: string;
}

export type CapReason = "none" | "lines" | "bytes";

export interface SourceFact {
  id: InjectionSourceId;
  /** 实际注入的行数 / 字节数（截断提示行算在内——模型看到的确实是这么多） */
  lines: number;
  bytes: number;
  /** 原文（截断前）的总行数 / 总字节数 */
  totalLines: number;
  totalBytes: number;
  truncated: boolean;
  /** 先触顶的那一维（按 lines→bytes 的检查顺序，报先命中的那个） */
  cappedBy: CapReason;
}

export interface InjectionBuild {
  parts: InjectionPart[];
  facts: SourceFact[];
  /** 实际注入的总字节数 */
  totalBytes: number;
  /** 本次发生截断的来源个数 */
  truncations: number;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf-8");
}

/** 按 UTF-8 字节切，绝不切碎多字节字符：看第一个被排除的字节是不是 continuation(10xxxxxx)，
 *  是就说明切在字符中间，回退到下一个 lead byte 之前。 */
export function sliceToBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  const buf = Buffer.from(text, "utf-8");
  let end = Math.min(maxBytes, buf.length);
  while (end > 0 && end < buf.length && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf-8");
}

/**
 * 截断提示行。**必须可见**：静默截断是这里唯一真正致命的失败模式——模型不知道自己的
 * 上下文缺了一块，会照着半份画像/索引作答，而诊断里也看不出发生过截断。
 * 四个数字全写出来（保留行/总行、保留字节/总字节），再加是哪一维触的顶。
 */
export function truncationNotice(
  keptLines: number,
  totalLines: number,
  keptBytes: number,
  totalBytes: number,
  cappedBy: Exclude<CapReason, "none">,
  limits: InjectionLimits = DEFAULT_INJECT_LIMITS,
): string {
  const cap = cappedBy === "lines" ? `${limits.maxLines}-line` : `${limits.maxBytes}-byte`;
  return `[memx: truncated — showing first ${keptLines} of ${totalLines} lines (${keptBytes} of ${totalBytes} bytes); ${cap} cap]`;
}

/** 对单块内容施加行数/字节双上限（先到先算），必要时在末尾追加可见的截断提示行。 */
export function capSourceText(
  id: InjectionSourceId,
  text: string,
  limits: InjectionLimits = DEFAULT_INJECT_LIMITS,
): { text: string; fact: SourceFact } {
  const allLines = text.split("\n");
  const totalLines = allLines.length;
  const totalBytes = byteLength(text);

  let kept = allLines;
  let cappedBy: CapReason = "none";
  if (kept.length > limits.maxLines) {
    kept = kept.slice(0, limits.maxLines);
    cappedBy = "lines";
  }
  let out = kept.join("\n");
  if (byteLength(out) > limits.maxBytes) {
    out = sliceToBytes(out, limits.maxBytes);
    cappedBy = cappedBy === "none" ? "bytes" : cappedBy;
  }

  if (cappedBy === "none") {
    return {
      text: out,
      fact: { id, lines: totalLines, bytes: totalBytes, totalLines, totalBytes, truncated: false, cappedBy },
    };
  }

  const outLines = out.split("\n").length;
  const outBytes = byteLength(out);
  const notice = truncationNotice(outLines, totalLines, outBytes, totalBytes, cappedBy, limits);
  const finalText = out.endsWith("\n") ? `${out}${notice}` : `${out}\n${notice}`;
  return {
    text: finalText,
    fact: {
      id,
      lines: finalText.split("\n").length,
      bytes: byteLength(finalText),
      totalLines,
      totalBytes,
      truncated: true,
      cappedBy,
    },
  };
}

/**
 * 把三块来源装配成注入用的 SystemPart 列表。
 * 缺失 / 非字符串 / 只有空白 = 静默跳过（不报错、不塞占位符）。
 */
export function buildInjectionParts(
  sources: InjectionSources,
  limits: InjectionLimits = DEFAULT_INJECT_LIMITS,
): InjectionBuild {
  const parts: InjectionPart[] = [];
  const facts: SourceFact[] = [];
  for (const id of INJECTION_SOURCE_ORDER) {
    const raw = sources[id];
    if (typeof raw !== "string" || raw.trim() === "") continue;
    const capped = capSourceText(id, raw, limits);
    parts.push({ type: "text", text: capped.text });
    facts.push(capped.fact);
  }
  return {
    parts,
    facts,
    totalBytes: facts.reduce((sum, f) => sum + f.bytes, 0),
    truncations: facts.filter((f) => f.truncated).length,
  };
}

// ── agent 闸门 ────────────────────────────────────────────────────────────────
// memx 不认识任何具体 agent 名（仓库里不允许出现字面量 agent 名）：宿主无关是硬约束，
// 谁该被排除由消费方在 memx.config.json 里决定。

export interface AgentGate {
  enabled: boolean;
  includeAgents: string[] | "all";
  excludeAgents: string[];
}

export const DEFAULT_AGENT_GATE: AgentGate = { enabled: true, includeAgents: "all", excludeAgents: [] };

/**
 * 真值表（exclude 永远压过 include）：
 *   enabled=false                    → 否
 *   include="all"    - exclude 命中  → 否
 *   include="all"                     → 是
 *   include=[...]    - exclude 命中  → 否
 *   include=[...]    含该 agent     → 是
 *   include=[...]    不含（agent 未知/缺失也算"不含"）→ 否
 */
export function shouldInjectAgent(gate: AgentGate, agent: string | undefined | null): boolean {
  if (!gate.enabled) return false;
  const name = typeof agent === "string" ? agent : "";
  if (gate.excludeAgents.includes(name)) return false;
  if (gate.includeAgents === "all") return true;
  return gate.includeAgents.includes(name);
}

/** 诊断用：把有效闸门压成一行人话。 */
export function describeGate(gate: AgentGate): string {
  const include = gate.includeAgents === "all" ? "all" : `[${gate.includeAgents.join(",")}]`;
  const exclude = gate.excludeAgents.length > 0 ? `-[${gate.excludeAgents.join(",")}]` : "";
  return `${gate.enabled ? "on" : "off"} include=${include}${exclude}`;
}