import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync, unlinkSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import type { MemoryProposal } from "../memory-types";
export interface MemoryIndexSection {
  slug: string;
  entries: MemoryIndexEntry[];
}

export interface MemoryIndexEntry {
  title: string;
  filePath: string;
  hook: string;
  raw: string;
}

const INDEX_ENTRY_RE = /^- \[(.+?)\]\((.+?)\) - (.+)$/;

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

export function parseMemoryIndex(content: string): MemoryIndexSection[] {
  if (!content.trim()) return [];
  const lines = content.split("\n");
  const sections: MemoryIndexSection[] = [];
  let current: MemoryIndexSection | null = null;

  for (const line of lines) {
    const headerMatch = line.match(/^## (.+)$/);
    if (headerMatch) {
      const slug = headerMatch[1]!.trim();
      current = { slug, entries: [] };
      sections.push(current);
      continue;
    }
    const entryMatch = line.match(INDEX_ENTRY_RE);
    if (entryMatch && current) {
      current.entries.push({
        title: entryMatch[1]!,
        filePath: entryMatch[2]!,
        hook: entryMatch[3]!,
        raw: line,
      });
    }
  }
  return sections;
}

export function serializeMemoryIndex(sections: MemoryIndexSection[]): string {
  const result: string[] = [];
  for (const section of sections) {
    if (section.entries.length === 0) continue;
    result.push(`## ${section.slug}`);
    for (const entry of section.entries) {
      result.push(entry.raw.startsWith("- ") ? entry.raw : `- [${entry.title}](${entry.filePath}) - ${entry.hook}`);
    }
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

export function applyMemoryProposal(proposal: MemoryProposal, existingIndex: string, slug: string): string {
  writeMemoryFile(slug, proposal);

  const sections = parseMemoryIndex(existingIndex);
  let section = sections.find((s) => s.slug === slug);
  if (!section) {
    section = { slug, entries: [] };
    sections.push(section);
  }

  const filePath = `~/.opencode/projects/${slug}/.mem/${proposal.target_file}`;
  const entry: MemoryIndexEntry = {
    title: proposal.name,
    filePath,
    hook: proposal.description,
    raw: `- [${proposal.name}](${filePath}) - ${proposal.description}`,
  };

  switch (proposal.action) {
    case "append":
      if (!section.entries.some((e) => e.filePath === filePath)) {
        section.entries.push(entry);
      }
      break;
    case "update": {
      const idx = section.entries.findIndex((e) => e.filePath === filePath);
      if (idx !== -1) {
        section.entries[idx] = entry;
      } else {
        section.entries.push(entry);
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
      }
      section.entries = section.entries.filter((e) => e.filePath !== filePath);
      break;
    }
  }

  return serializeMemoryIndex(sections);
}

export function forgetMemory(keyword: string, indexContent: string, slug: string): { newIndex: string; removed: string[] } {
  const sections = parseMemoryIndex(indexContent);
  const section = sections.find((s) => s.slug === slug);
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
  return { newIndex: serializeMemoryIndex(sections), removed };
}

function extractFilename(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1] ?? "";
}
