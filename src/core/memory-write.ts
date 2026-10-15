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

  const filename = deriveMemoryFilename(type, name);
  const filePath = getMemoryFilePath(slug, filename);
  // 存在即更新（同名同类型视为同一条记忆的修订），不存在即新增——`update` 在索引里也是 upsert
  const action: "append" | "update" = existsSync(filePath) ? "update" : "append";

  const proposal: MemoryProposal = {
    action,
    type,
    name,
    description,
    content: text,
    why,
    how_to_apply: howToApply && howToApply.length > 0 ? howToApply : null,
    target_file: filename,
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
  if ((type === "feedback" || type === "project") && proposal.how_to_apply == null) {
    warnings.push("how_to_apply 缺失（feedback/project 的惯例字段，建议补上「以后怎么用」）");
  }

  return { ok: true, action, type, name, filename, filePath, warnings };
}
