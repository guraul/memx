import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync, unlinkSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import type { MemoryProposal } from "../memory-types.ts";
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
    const headerMatch = line.match(/^## (.+)$/);
    if (headerMatch) {
      const slug = headerMatch[1]!.trim();
      if (slug) {
        current = { slug, entries: [] };
        sections.push(current);
        lastManaged = current;
        continue;
      }
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

export function writeMemoryFile(slug: string, proposal: MemoryProposal): void {
  const dir = getMemoryDir(slug);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const filePath = getMemoryFilePath(slug, proposal.target_file);
  const lines: string[] = [
    "---",
    `name: ${proposal.name}`,
    `description: ${proposal.description}`,
    `type: ${proposal.type}`,
    "---",
    "",
    proposal.content,
  ];

  if (proposal.why != null) {
    lines.push("", `**Why:** ${proposal.why}`);
  }
  if (proposal.how_to_apply != null) {
    lines.push(`**How to apply:** ${proposal.how_to_apply}`);
  }
  if (proposal.supersedes != null) {
    const today = new Date().toISOString().split("T")[0] ?? "";
    lines.push("", `**Supersedes:** ${proposal.supersedes} (reversed on ${today})`);
  }
  if (proposal.merges != null) {
    const today = new Date().toISOString().split("T")[0] ?? "";
    lines.push("", `**Merges:** ${proposal.merges} (merged on ${today})`);
  }

  writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
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
  writeMemoryFile(slug, proposal);

  const filePath = `~/.opencode/projects/${slug}/.mem/${proposal.target_file}`;
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
    case "deprecate": {
      const targetPath = getMemoryFilePath(slug, proposal.target_file);
      if (existsSync(targetPath)) {
        const trashDir = getTrashDir(slug);
        if (!existsSync(trashDir)) mkdirSync(trashDir, { recursive: true });
        const trashPath = join(trashDir, `${proposal.target_file}.${Date.now()}`);
        renameSync(targetPath, trashPath);
      } else {
        warnings.push(`deprecate 目标文件不存在: ${proposal.target_file}`);
      }
      const before = section.entries.length;
      section.entries = section.entries.filter((e) => e.filePath !== filePath);
      if (section.entries.length === before) {
        warnings.push(`deprecate 索引无此条目: ${proposal.target_file}`);
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
