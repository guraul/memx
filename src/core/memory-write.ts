// 出口①（issue #82 §B）：用户显式"这个记一下"的一次写入，落到 canonical 记忆库。
//
// 为什么放在 core 而不是宿主壳：多宿主目标（opencode 今天、DSH 未来）下，**格式 + 单遍应用 +
// 文件锁**必须只有一份实现；宿主壳只负责参数映射与回执文案（handoff-20261011 §4 阶段 1 的分层纪律）。
// 与后台提炼（`applyMemoryProposals`）共用同一套写盘路径，因此不存在"两条写路各写各的格式"。
import { createHash } from "crypto";
import { existsSync } from "fs";
import type { MemoryProposal, MemoryType } from "./memory-types.ts";
import { MEMORY_TYPES } from "./memory-types.ts";
import {
  applyMemoryProposals,
  getMemoryFilePath,
  readMemoryFile,
  readMemoryIndex,
  writeMemoryIndex,
} from "./store/memory-md.ts";
import { memoryIndexLockPath, withFileLock } from "./store/lock.ts";

/** 与 MemoryProposalSchema.content 的上限一致（超过就只能拆成两条，不能悄悄截断） */
export const MAX_MEMORY_TEXT = 500;

export interface MemoryWriteInput {
  /** 要记住的事实本身（陈述句，≤500 字） */
  text: string;
  /** 四类型，缺省 project */
  type?: string;
  /** 短标识，缺省从 text 截取 */
  name?: string;
  /** "何时该读这条"的钩子（含可匹配关键词），缺省取 text */
  description?: string;
  why?: string;
  how_to_apply?: string;
  /** 用户原话（用于 why 缺省值） */
  evidence?: string;
}

export interface MemoryWriteSuccess {
  ok: true;
  action: "append" | "update";
  type: MemoryType;
  name: string;
  filename: string;
  filePath: string;
  warnings: string[];
}

export type MemoryWriteOutcome = MemoryWriteSuccess | { ok: false; error: string };

function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === "string" && (MEMORY_TYPES as readonly string[]).includes(value);
}

/** 文件名 slug：只留 ASCII 字母数字，其余折叠成 `_`。
 *  纯中文名（折叠后为空）退化成名字的确定性短哈希——**必须确定性**，否则同名每次写都新建文件，
 *  去重/更新语义就废了。 */
export function slugifyMemoryName(name: string): string {
  const ascii = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  if (ascii) return ascii;
  return "h" + createHash("sha1").update(name).digest("hex").slice(0, 8);
}

export function deriveMemoryFilename(type: MemoryType, name: string): string {
  return `${type}_${slugifyMemoryName(name)}.md`;
}

/** fork 尾缀长度阶梯：6 hex（≈1677 万）够用；撞上不同内容才加长到 12（#31）。 */
const FORK_HASH_LENGTHS = [6, 12] as const;

/** 卡片正文尾部由写盘层追加的审计行（不是用户内容，比对内容时必须剥掉）。 */
const CARD_TRAILER_RE = /^\*\*(?:Why|How to apply|Supersedes|Merges|Superseded by):\*\*/;

/**
 * 内容归一化：只抹掉**不影响语义**的排版差异（CRLF、行尾空白、连续空行、首尾空白）。
 * 刻意**不**剥离 markdown 标记——`**粗体**`、`- 列表`、代码块都算内容差异。
 */
export function normalizeMemoryContent(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 取卡片里「用户内容」那一段：去 frontmatter，再切掉尾部 `**Why:**` 等审计行。 */
export function extractCardContent(card: string): string {
  const body = card.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  const lines = body.split("\n");
  const cut = lines.findIndex((line, i) => (i === 0 || lines[i - 1]!.trim() === "") && CARD_TRAILER_RE.test(line));
  return (cut === -1 ? lines : lines.slice(0, cut)).join("\n");
}

/** 同名判定「同义」：归一化后逐字相等（不做语义近似——那是 LLM 裁决的活，见 refine 路径）。 */
export function isSameMemoryContent(card: string, text: string): boolean {
  return normalizeMemoryContent(extractCardContent(card)) === normalizeMemoryContent(text);
}

/** 内容 hash（sha256 前 N 位），对**归一化后**的内容取——纯中文/纯 ASCII 同一条确定性路径。 */
export function hashMemoryContent(text: string, length = 6): string {
  return createHash("sha256").update(normalizeMemoryContent(text)).digest("hex").slice(0, length);
}

/** 同名不同义时的 fork 文件名：`<type>_<slug>--<内容 hash>`（`--` 与 slug 的下划线区分，避免歧义）。 */
export function deriveForkFilename(type: MemoryType, name: string, text: string, hashLength = 6): string {
  return `${type}_${slugifyMemoryName(name)}--${hashMemoryContent(text, hashLength)}.md`;
}

interface ResolvedTarget {
  filename: string;
  action: "append" | "update";
  /** fork 时指向原卡文件名（null = 没有 fork，就是原卡本身） */
  sameNameAs: string | null;
}

/**
 * 决定这次写到哪个文件（#31）：
 * - 文件不存在 → append；
 * - 存在且**内容同义**（归一化后相等）→ update 原卡（修订语义不变）；
 * - 存在但内容不同 → fork 出 `<slug>--<内容 hash>` 新卡，原卡保留并在其尾部记 `**Superseded by:**`；
 * - fork 卡已存在且内容同义 → update 它（同 name + 同内容反复写永远命中同一张，幂等）。
 */
export function resolveMemoryTarget(
  slug: string,
  type: MemoryType,
  name: string,
  text: string,
): ResolvedTarget | { error: string } {
  const base = deriveMemoryFilename(type, name);
  if (!existsSync(getMemoryFilePath(slug, base))) return { filename: base, action: "append", sameNameAs: null };
  if (isSameMemoryContent(readMemoryFile(slug, base), text)) return { filename: base, action: "update", sameNameAs: null };

  for (const hashLength of FORK_HASH_LENGTHS) {
    const candidate = deriveForkFilename(type, name, text, hashLength);
    if (!existsSync(getMemoryFilePath(slug, candidate))) {
      return { filename: candidate, action: "append", sameNameAs: base };
    }
    if (isSameMemoryContent(readMemoryFile(slug, candidate), text)) {
      return { filename: candidate, action: "update", sameNameAs: base };
    }
  }
  return { error: `同名不同义但 fork 文件名 hash 碰撞（${base}）——请换个 name` };
}

function firstLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? "";
}

/** MEMORY.md 顶部面包屑：摘掉旧 `<!-- memx:` 行，有新面包屑则置顶（空串 = 只清旧行）。
 *  纯函数；字符串由宿主传入（core 不反向 import alerts）。 */
export function applyBreadcrumbLine(content: string, breadcrumb: string): string {
  const lines = content.split("\n");
  let start = 0;
  while (start < lines.length && lines[start]!.trim() === "") start++;
  if (start < lines.length && lines[start]!.startsWith("<!-- memx:")) {
    lines.splice(start, 1);
  }
  if (breadcrumb) {
    lines.unshift(breadcrumb, "");
  }
  return lines.join("\n");
}

export async function writeProjectMemory(
  slug: string,
  input: MemoryWriteInput,
  breadcrumb?: string,
): Promise<MemoryWriteOutcome> {
  const text = (input.text ?? "").trim();
  if (!text) return { ok: false, error: "text 不能为空" };
  if (text.length > MAX_MEMORY_TEXT) {
    return {
      ok: false,
      error: `text 超长（${text.length} > ${MAX_MEMORY_TEXT} 字）——请拆成多条 memory_write`,
    };
  }

  const type: MemoryType = isMemoryType(input.type) ? input.type : "project";
  const name = (input.name?.trim() || firstLine(text).slice(0, 60) || "memory").slice(0, 60);
  const description = (input.description?.trim() || firstLine(text)).slice(0, 150);
  const why = (input.why?.trim() || `用户显式要求记住${input.evidence ? `：${input.evidence.trim()}` : ""}`).slice(0, 200);
  const howToApply = input.how_to_apply?.trim().slice(0, 200);

  const resolved = resolveMemoryTarget(slug, type, name, text);
  if ("error" in resolved) return { ok: false, error: resolved.error };
  const { filename, action, sameNameAs } = resolved;
  const filePath = getMemoryFilePath(slug, filename);

  const proposal: MemoryProposal = {
    action,
    type,
    name,
    description,
    content: text,
    why,
    how_to_apply: howToApply && howToApply.length > 0 ? howToApply : null,
    target_file: filename,
    ...(sameNameAs != null ? { same_name_as: sameNameAs } : {}),
    reason: "用户显式记录（memory_write）",
  };

  // 与后台提炼共用一把锁：read-modify-write 必须在锁内**重读**索引
  const applied = await withFileLock(memoryIndexLockPath(), () => {
    const result = applyMemoryProposals([proposal], readMemoryIndex(), slug);
    // 面包屑由宿主算好传入（formatBreadcrumb(alertStore)）：工具写盘也能刷新 MEMORY.md 顶部那一行
    const indexContent = breadcrumb !== undefined ? applyBreadcrumbLine(result.content, breadcrumb) : result.content;
    writeMemoryIndex(indexContent);
    return result;
  });

  const warnings = [...applied.warnings];
  if (sameNameAs != null) {
    warnings.push(`同名不同义：旧卡 ${sameNameAs} 保留未改，本次${action === "append" ? "另存为" : "更新"} ${filename}`);
  }
  if ((type === "feedback" || type === "project") && proposal.how_to_apply == null) {
    warnings.push("how_to_apply 缺失（feedback/project 的惯例字段，建议补上「以后怎么用」）");
  }

  return { ok: true, action, type, name, filename, filePath, warnings };
}
