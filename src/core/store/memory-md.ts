import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync, unlinkSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import type { MemoryProposal } from "../memory-types.ts";
import { ROOT_SLUG } from "../memory-types.ts";
import { trimBlankLines, trimTrailingBlankLines } from "./markdown-lines.ts";

export interface MemoryIndexSection {
  slug: string;
  entries: MemoryIndexEntry[];
  /** 非受管原文行（health 日志注释、用户手写说明等），原样保留 */
  extras?: string[];
}

export interface MemoryIndexEntry {
  title: string;
  filePath: string;
  hook: string;
  raw: string;
}

const INDEX_ENTRY_RE = /^- \[(.+?)\]\((.+?)\) - (.+)$/;
/** 小节头：`## <slug>`；`##` / `## `（空节头）也匹配，交给 parse 认领到 ROOT_SLUG。
 *  比 `/^## (.+)$/` 收紧：`### x` 仍不算小节头（第二个字符是 `#`，可选组吃不下）。 */
const SECTION_HEADER_RE = /^##(?:\s+(.*))?$/;

export interface MemoryIndexDoc {
  /** 首个 ## 小节之前的全部原文行（原样保留） */
  preamble: string[];
  sections: MemoryIndexSection[];
}

export function getMemoryIndexPath(): string {
  return join(homedir(), ".opencode", "MEMORY.md");
}

export function getMemoryDir(slug: string): string {
  return join(homedir(), ".opencode", "projects", slug, ".mem");
}

function getTrashDir(slug: string): string {
  return join(getMemoryDir(slug), ".trash");
}

export function getMemoryFilePath(slug: string, filename: string): string {
  return join(getMemoryDir(slug), filename);
}

export function readMemoryIndex(): string {
  const path = getMemoryIndexPath();
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf-8");
}

export function writeMemoryIndex(content: string): void {
  const dir = join(homedir(), ".opencode");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (existsSync(getMemoryIndexPath())) {
    backupMemoryIndex();
  }

  const path = getMemoryIndexPath();
  const tmpPath = `${path}.tmp.${Date.now()}`;
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, path);
}

export function backupMemoryIndex(): string | null {
  const path = getMemoryIndexPath();
  if (!existsSync(path)) return null;
  const bakPath = `${path}.bak.${Date.now()}`;
  const content = readFileSync(path, "utf-8");
  writeFileSync(bakPath, content, "utf-8");
  cleanupOldBackups(5);
  return bakPath;
}

function cleanupOldBackups(maxKeep = 5): void {
  const dir = join(homedir(), ".opencode");
  if (!existsSync(dir)) return;
  const prefix = `${basename(getMemoryIndexPath())}.bak.`;
  const backups = readdirSync(dir)
    .filter((f) => f.startsWith(prefix))
    .map((f) => join(dir, f))
    .sort()
    .reverse();
  for (const old of backups.slice(maxKeep)) {
    try { unlinkSync(old); } catch { /* ignore */ }
  }
}

/**
 * 解析 MEMORY.md 索引。受管集合 = `## <slug>` 小节 + 其中的 `- [t](p) - hook` 指针；
 * 其余一切（health 日志注释、用户手写说明、首个 ## 之前的散文）原样带走，写回不丢。
 *
 * **空节头**（`## ` / `##`，issue #36 的存量产物）**不降级成 extras，认领到 `ROOT_SLUG` 节**：
 * 降级会让它下面的指针行挂到 `current ?? lastManaged` —— 也就是**上一个无关项目的小节**，
 * 于是"任何项目都读不到"的记忆反而被注入到另一个项目的会话里（#37 现场实测）。
 */
export function parseMemoryIndex(content: string): MemoryIndexDoc {
  if (!content.trim()) return { preamble: [], sections: [] };
  const lines = content.split("\n");
  const preamble: string[] = [];
  const sections: MemoryIndexSection[] = [];
  let current: MemoryIndexSection | null = null;
  // 最近一个受管小节：非受管行挂到它身上，位置与原文一致
  let lastManaged: MemoryIndexSection | null = null;

  for (const line of lines) {
    const headerMatch = line.match(SECTION_HEADER_RE);
    if (headerMatch) {
      const slug = (headerMatch[1] ?? "").trim() || ROOT_SLUG;
      // 同 slug 的第二个节头合并进已有的那节：空节头被认领成 root 后必然与真正的 `## root`
      // 相遇，不合并就会序列化出两个 `## root`，注入/health 只读第一个，另一个的条目等于丢了。
      const existing = sections.find((s) => s.slug === slug);
      current = existing ?? { slug, entries: [] };
      if (!existing) sections.push(current);
      lastManaged = current;
      continue;
    }

    const entryMatch = current ? line.match(INDEX_ENTRY_RE) : null;
    if (entryMatch && current) {
      current.entries.push({
        title: entryMatch[1]!,
        filePath: entryMatch[2]!,
        hook: entryMatch[3]!,
        raw: line,
      });
      continue;
    }

    const owner = current ?? lastManaged;
    if (owner) {
      owner.extras = [...(owner.extras ?? []), line];
    } else {
      preamble.push(line);
    }
  }

  return { preamble: trimBlankLines(preamble), sections };
}

export function serializeMemoryIndex(doc: MemoryIndexDoc): string {
  const result: string[] = [];
  if (doc.preamble.length > 0) {
    result.push(...doc.preamble, "");
  }
  for (const section of doc.sections) {
    const extras = trimTrailingBlankLines(section.extras ?? []);
    if (section.entries.length === 0 && extras.length === 0) continue;
    result.push(`## ${section.slug}`);
    for (const entry of section.entries) {
      result.push(entry.raw.startsWith("- ") ? entry.raw : `- [${entry.title}](${entry.filePath}) - ${entry.hook}`);
    }
    result.push(...extras);
    result.push("");
  }
  return result.join("\n");
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

/** 读卡片 frontmatter 里的 `created:`（只认 frontmatter 块内的行）。 */
function readCreatedDate(content: string): string | null {
  const block = content.match(FRONTMATTER_RE)?.[1];
  if (!block) return null;
  return block.match(/^created:\s*(\S+)\s*$/m)?.[1] ?? null;
}

/** 把现有卡片原样移入 `.trash/<file>.<ts>`；文件不存在返回 false（软删语义，不物理删除）。 */
function moveMemoryFileToTrash(slug: string, filename: string, stamp: number): boolean {
  const targetPath = getMemoryFilePath(slug, filename);
  if (!existsSync(targetPath)) return false;
  const trashDir = getTrashDir(slug);
  if (!existsSync(trashDir)) mkdirSync(trashDir, { recursive: true });
  renameSync(targetPath, join(trashDir, `${filename}.${stamp}`));
  return true;
}

export function writeMemoryFile(slug: string, proposal: MemoryProposal): void {
  const dir = getMemoryDir(slug);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const filePath = getMemoryFilePath(slug, proposal.target_file);
  const today = new Date().toISOString().slice(0, 10);
  // 旧卡必须在被移走**之前**读：created 原样保留，缺失则不伪造（doctor 显示「未知龄期」）。
  // 禁止用 mtime 兜底：update 会重置 mtime，sync pull 的 copyFileSync 也会重置。
  const previous = existsSync(filePath) ? readFileSync(filePath, "utf-8") : null;
  const created = previous == null ? today : readCreatedDate(previous);

  const lines: string[] = [
    "---",
    `name: ${proposal.name}`,
    `description: ${proposal.description}`,
    `type: ${proposal.type}`,
  ];
  if (created != null) lines.push(`created: ${created}`);
  lines.push(`updated: ${today}`, "---", "", proposal.content);

  if (proposal.why != null) {
    lines.push("", `**Why:** ${proposal.why}`);
  }
  if (proposal.how_to_apply != null) {
    lines.push(`**How to apply:** ${proposal.how_to_apply}`);
  }
  if (proposal.supersedes != null) {
    lines.push("", `**Supersedes:** ${proposal.supersedes} (reversed on ${today})`);
  }
  if (proposal.merges != null) {
    lines.push("", `**Merges:** ${proposal.merges} (merged on ${today})`);
  }

  // 三件套顺序不可换：① tmp 写完整 → ② 旧卡进 .trash → ③ tmp rename 到位。
  // 任何崩溃点都至少留一份完整内容（①②之间：旧卡在盘 + 新卡在 tmp；②③之间：旧卡在 trash + 新卡在 tmp）。
  // tmp 名不以 .md 结尾 → sync / memory_search / 健康检查（都按 endsWith(".md") 收文件）天然排除。
  const stamp = Date.now();
  const tmpPath = `${filePath}.tmp.${stamp}`;
  try {
    writeFileSync(tmpPath, lines.join("\n") + "\n", "utf-8");
    moveMemoryFileToTrash(slug, proposal.target_file, stamp);
    renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      /* 清理失败不掩盖原始异常 */
    }
    throw error;
  }
}

export function readMemoryFile(slug: string, filename: string): string {
  const filePath = getMemoryFilePath(slug, filename);
  if (!existsSync(filePath)) return "";
  return readFileSync(filePath, "utf-8");
}

export interface MemoryApplyResult {
  content: string;
  warnings: string[];
}

function applyOneMemoryProposal(
  proposal: MemoryProposal,
  section: MemoryIndexSection,
  slug: string,
  warnings: string[],
): void {
  const filePath = `~/.opencode/projects/${slug}/.mem/${proposal.target_file}`;

  // deprecate 是软删：只把**原文件原样**挪进 .trash，绝不写提案内容。
  // （旧实现先 writeMemoryFile 把所有 action 一并覆盖，等于用提案内容毁掉原卡再丢弃。）
  if (proposal.action === "deprecate") {
    if (!moveMemoryFileToTrash(slug, proposal.target_file, Date.now())) {
      warnings.push(`deprecate 目标文件不存在: ${proposal.target_file}`);
    }
    const before = section.entries.length;
    section.entries = section.entries.filter((e) => e.filePath !== filePath);
    if (section.entries.length === before) {
      warnings.push(`deprecate 索引无此条目: ${proposal.target_file}`);
    }
    return;
  }

  writeMemoryFile(slug, proposal);

  const entry: MemoryIndexEntry = {
    title: proposal.name,
    filePath,
    hook: proposal.description,
    raw: `- [${proposal.name}](${filePath}) - ${proposal.description}`,
  };

  switch (proposal.action) {
    case "append":
      if (section.entries.some((e) => e.filePath === filePath)) {
        warnings.push(`append 已存在，未重复登记: ${proposal.target_file}`);
      } else {
        section.entries.push(entry);
      }
      break;
    case "update": {
      const idx = section.entries.findIndex((e) => e.filePath === filePath);
      if (idx !== -1) {
        section.entries[idx] = entry;
      } else {
        section.entries.push(entry);
        warnings.push(`update 索引无此条目 → 登记为新条目: ${proposal.target_file}`);
      }
      break;
    }
  }
}

/**
 * 单遍应用整批记忆提案：parse 一次索引 → 逐个落文件/改索引 → serialize 一次。
 * （与 USER.md 的 applyProposals 同源；记忆条目按 filePath 寻址，本不会批内漂移，
 *   但一次写盘可以少 5 次备份轮转与全文件序列化。）
 */
export function applyMemoryProposals(
  proposals: MemoryProposal[],
  existingIndex: string,
  slug: string,
): MemoryApplyResult {
  const doc = parseMemoryIndex(existingIndex);
  const warnings: string[] = [];
  let section = doc.sections.find((s) => s.slug === slug);
  if (!section) {
    section = { slug, entries: [] };
    doc.sections.push(section);
  }
  for (const proposal of proposals) {
    applyOneMemoryProposal(proposal, section, slug, warnings);
  }
  return { content: serializeMemoryIndex(doc), warnings };
}

/** 单条应用的兼容壳（内部仍走单遍实现） */
export function applyMemoryProposal(proposal: MemoryProposal, existingIndex: string, slug: string): string {
  return applyMemoryProposals([proposal], existingIndex, slug).content;
}

export function forgetMemory(keyword: string, indexContent: string, slug: string): { newIndex: string; removed: string[] } {
  const doc = parseMemoryIndex(indexContent);
  const section = doc.sections.find((s) => s.slug === slug);
  const removed: string[] = [];
  if (!section) return { newIndex: indexContent, removed };

  const lowerKeyword = keyword.toLowerCase();
  const toRemove = section.entries.filter(
    (e) =>
      e.title.toLowerCase().includes(lowerKeyword) ||
      e.hook.toLowerCase().includes(lowerKeyword) ||
      e.filePath.toLowerCase().includes(lowerKeyword),
  );

  for (const entry of toRemove) {
    const filename = extractFilename(entry.filePath);
    const targetPath = getMemoryFilePath(slug, filename);
    if (existsSync(targetPath)) {
      const trashDir = join(getMemoryDir(slug), ".trash");
      if (!existsSync(trashDir)) mkdirSync(trashDir, { recursive: true });
      const trashPath = join(trashDir, `${filename}.${Date.now()}`);
      renameSync(targetPath, trashPath);
    }
    removed.push(filename);
  }

  section.entries = section.entries.filter((e) => !toRemove.includes(e));
  return { newIndex: serializeMemoryIndex(doc), removed };
}

function extractFilename(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1] ?? "";
}
