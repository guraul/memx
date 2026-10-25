import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { parseMemoryIndex, serializeMemoryIndex, getMemoryDir } from "../store/memory-md.ts";

const MAX_AUTO_FIXES_PER_RUN = 3;
const MEMORY_INDEX_MAX_LINES = 200;

const TYPE_ORDER: Record<string, number> = {
  user: 0,
  feedback: 1,
  project: 2,
  reference: 3,
};

export interface HealthReport {
  deadLinks: DeadLink[];
  orphanFiles: OrphanFile[];
  indexLineCount: number;
  autoFixed: AutoFixLog[];
  escalated: string[];
}

export interface DeadLink {
  slug: string;
  title: string;
  filePath: string;
  hook: string;
}

export interface OrphanFile {
  slug: string;
  filename: string;
  name: string;
  description: string;
  type: string;
}

export interface AutoFixLog {
  action: "removed-dead-pointer" | "added-pointer" | "escalated-manual";
  target: string;
  reason: string;
}

/** `~/.opencode/projects/.mem/`（空 slug 遗留目录）的存量现状 */
export interface LegacySlugDirReport {
  dir: string;
  /** 仍留在其中的卡片数（不含 `.trash`、不含非 `.md`） */
  files: number;
}

/** 索引里同一 filePath 被登记多次 */
export interface DuplicateEntryReport {
  filePath: string;
  count: number;
}

/**
 * #36 存量诊断（**只读，不搬迁**）：`projects/.mem/` 是 cwd=`/` 写出空 slug 时代的产物。
 * 卡片本身仍可读（索引指针 `projects//.mem/…` 在 POSIX 上等价于 `projects/.mem/…`），
 * 但新写入已归到 `projects/root/.mem/`，所以这里只报告、由人决定要不要手工搬。
 */
export function findLegacyEmptySlugDir(): LegacySlugDirReport | null {
  const dir = join(homedir(), ".opencode", "projects", ".mem");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((f) => f.isFile() && f.name.endsWith(".md")).length;
  return files === 0 ? null : { dir, files };
}

/**
 * #37 存量诊断（**只报不改**）：同一次写入被登记两次的时代留下的重复指针。
 * 清理是破坏性操作（要决定留哪条、hook 取哪个），不在 doctor/health 里自动做。
 * 跨节也算重复：空节头的指针曾被挂进上一个无关项目节，这种"同一文件两节各一条"正是它的指纹。
 */
export function findDuplicateEntries(indexContent: string): DuplicateEntryReport[] {
  const counts = new Map<string, number>();
  for (const section of parseMemoryIndex(indexContent).sections) {
    for (const entry of section.entries) {
      counts.set(entry.filePath, (counts.get(entry.filePath) ?? 0) + 1);
    }
  }
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([filePath, count]) => ({ filePath, count }));
}

export function runHealthCheck(indexContent: string, slug: string): HealthReport {
  const report: HealthReport = {
    deadLinks: [],
    orphanFiles: [],
    indexLineCount: 0,
    autoFixed: [],
    escalated: [],
  };

  const sections = parseMemoryIndex(indexContent).sections;
  const section = sections.find((s) => s.slug === slug);

  // Count index lines (non-empty, non-header)
  report.indexLineCount = sections.reduce((sum, s) => sum + s.entries.length, 0);

  // Check for index bloat
  if (report.indexLineCount >= MEMORY_INDEX_MAX_LINES) {
    report.escalated.push(
      `MEMORY.md at ${report.indexLineCount} lines, requires manual merge (threshold ${MEMORY_INDEX_MAX_LINES})`,
    );
  }

  // Find dead links (index points to non-existent files)
  if (section) {
    for (const entry of section.entries) {
      const actualPath = resolveIndexPath(entry.filePath);
      if (!existsSync(actualPath)) {
        report.deadLinks.push({
          slug,
          title: entry.title,
          filePath: entry.filePath,
          hook: entry.hook,
        });
      }
    }
  }

  // Find orphan files (.mem/*.md not in index)
  const memDir = getMemoryDir(slug);
  if (existsSync(memDir)) {
    const indexedFiles = new Set(
      (section?.entries ?? []).map((e) => extractFilename(e.filePath)),
    );
    const memFiles = readdirSync(memDir)
      .filter((f) => f.endsWith(".md") && !f.startsWith("."))
      .filter((f) => !indexedFiles.has(f));

    for (const filename of memFiles) {
      const filePath = join(memDir, filename);
      const content = readFileSync(filePath, "utf-8");
      const fm = parseFrontmatter(content);
      if (fm) {
        report.orphanFiles.push({
          slug,
          filename,
          name: fm.name,
          description: fm.description,
          type: fm.type,
        });
      }
    }
  }

  return report;
}

export function autoFix(report: HealthReport, indexContent: string, slug: string): { newIndex: string; logs: AutoFixLog[] } {
  const logs: AutoFixLog[] = [];
  let fixCount = 0;
  const doc = parseMemoryIndex(indexContent);
  const sections = doc.sections;
  let section = sections.find((s) => s.slug === slug);
  if (!section) {
    section = { slug, entries: [] };
    sections.push(section);
  }

  // Fix 1: Remove dead links (auto, counts toward limit)
  for (const dead of report.deadLinks) {
    if (fixCount >= MAX_AUTO_FIXES_PER_RUN) {
      logs.push({
        action: "escalated-manual",
        target: dead.filePath,
        reason: `max auto-fixes (${MAX_AUTO_FIXES_PER_RUN}) reached, dead link not removed`,
      });
      continue;
    }
    section.entries = section.entries.filter((e) => e.filePath !== dead.filePath);
    logs.push({
      action: "removed-dead-pointer",
      target: dead.filePath,
      reason: `file not found in .mem/`,
    });
    fixCount++;
  }

  // Fix 2: Add pointers for orphan files (auto, counts toward limit)
  for (const orphan of report.orphanFiles) {
    if (fixCount >= MAX_AUTO_FIXES_PER_RUN) {
      logs.push({
        action: "escalated-manual",
        target: orphan.filename,
        reason: `max auto-fixes (${MAX_AUTO_FIXES_PER_RUN}) reached, orphan file pointer not added`,
      });
      continue;
    }
    const filePath = `~/.opencode/projects/${slug}/.mem/${orphan.filename}`;
    const raw = `- [${orphan.name}](${filePath}) - ${orphan.description}`;
    if (!section.entries.some((e) => e.filePath === filePath)) {
      section.entries.push({
        title: orphan.name,
        filePath,
        hook: orphan.description,
        raw,
      });
    }
    logs.push({
      action: "added-pointer",
      target: orphan.filename,
      reason: `orphan file detected, added pointer`,
    });
    fixCount++;
  }

  // Sort entries within each section by type (user -> feedback -> project -> reference)
  for (const s of sections) {
    s.entries.sort((a, b) => {
      const typeA = readEntryType(a.filePath);
      const typeB = readEntryType(b.filePath);
      const orderA = TYPE_ORDER[typeA] ?? 99;
      const orderB = TYPE_ORDER[typeB] ?? 99;
      return orderA - orderB;
    });
  }

  // Escalations (no auto-fix, just log)
  for (const msg of report.escalated) {
    logs.push({
      action: "escalated-manual",
      target: "(N/A)",
      reason: msg,
    });
  }

  const newIndex = serializeMemoryIndex(doc);
  return { newIndex, logs };
}

export function formatHealthLog(logs: AutoFixLog[]): string {
  if (logs.length === 0) return "";
  const today = new Date().toISOString().split("T")[0] ?? "";
  const lines = logs.map((log) => {
    const detail = log.reason.replace(/\n/g, " ");
    return `<!-- ${today} auto-fix: ${log.action} ${log.target} - ${detail} -->`;
  });
  return lines.join("\n");
}

export interface HealthMaintenanceResult {
  /** 维护后的索引内容；无结构性修复时原样返回（不触发无意义的重写/备份） */
  index: string;
  logs: AutoFixLog[];
  report: HealthReport;
}

/**
 * P0-5（handoff-20261011 §4 阶段 3-5）：健康日志**不再写进 MEMORY.md**。
 *
 * 旧实现在 autoFix 后把 `formatHealthLog(logs)` 以 HTML 注释追加到索引尾部——那些行会被
 * 下一次 parseMemoryIndex→serializeMemoryIndex 吃掉（曾经整个日志消失）。现在的契约是：
 * 本函数只返回 `{index, logs, report}`，调用方把 logs 送 storage/报警出口（阶段 4 的
 * core/alerts），MEMORY.md 保持纯索引。
 *
 * 只有结构性修复（死链、孤儿文件）才改索引；仅有 escalated（索引膨胀等）时不动文件，
 * 避免"每次都重写+滚备份"。
 */
export function runHealthMaintenance(indexContent: string, slug: string): HealthMaintenanceResult {
  const report = runHealthCheck(indexContent, slug);
  const structural = report.deadLinks.length > 0 || report.orphanFiles.length > 0;
  if (!structural) {
    const logs: AutoFixLog[] = report.escalated.map((msg) => ({
      action: "escalated-manual" as const,
      target: "(N/A)",
      reason: msg,
    }));
    return { index: indexContent, logs, report };
  }
  const { newIndex, logs } = autoFix(report, indexContent, slug);
  return { index: newIndex, logs, report };
}

function readEntryType(filePath: string): string {
  try {
    const actualPath = resolveIndexPath(filePath);
    if (!existsSync(actualPath)) return "unknown";
    const content = readFileSync(actualPath, "utf-8");
    const fm = parseFrontmatter(content);
    return fm?.type ?? "unknown";
  } catch {
    return "unknown";
  }
}

function resolveIndexPath(filePath: string): string {
  // filePath is like ~/.opencode/projects/<slug>/.mem/<file>.md
  if (filePath.startsWith("~")) {
    return join(homedir(), filePath.slice(1).replace(/^\/+/, ""));
  }
  return filePath;
}

function extractFilename(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1] ?? "";
}

interface ParsedFrontmatter {
  name: string;
  description: string;
  type: string;
}

function parseFrontmatter(content: string): ParsedFrontmatter | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const yaml = match[1] ?? "";
  const nameMatch = yaml.match(/^name:\s*(.+)$/m);
  const descMatch = yaml.match(/^description:\s*(.+)$/m);
  const typeMatch = yaml.match(/^type:\s*(.+)$/m);
  if (!nameMatch || !descMatch || !typeMatch) return null;
  return {
    name: nameMatch[1]!.trim(),
    description: descMatch[1]!.trim(),
    type: typeMatch[1]!.trim(),
  };
}

export function rebuildIndex(slug: string): string {
  const memDir = getMemoryDir(slug);
  if (!existsSync(memDir)) return "";

  const entries: Array<{ filename: string; name: string; description: string; type: string }> = [];

  const files = readdirSync(memDir)
    .filter((f) => f.endsWith(".md") && !f.startsWith("."))
    .sort();

  for (const filename of files) {
    const filePath = join(memDir, filename);
    const content = readFileSync(filePath, "utf-8");
    const fm = parseFrontmatter(content);
    if (fm) {
      entries.push({ filename, name: fm.name, description: fm.description, type: fm.type });
    }
  }

  // Sort by type order (user -> feedback -> project -> reference)
  entries.sort((a, b) => {
    const orderA = TYPE_ORDER[a.type] ?? 99;
    const orderB = TYPE_ORDER[b.type] ?? 99;
    return orderA - orderB;
  });

  const indexPath = `~/.opencode/projects/${slug}/.mem`;
  const lines: string[] = [`## ${slug}`];
  for (const e of entries) {
    lines.push(`- [${e.name}](${indexPath}/${e.filename}) - ${e.description}`);
  }
  lines.push("");

  return lines.join("\n");
}
