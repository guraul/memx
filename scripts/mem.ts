// memx 对外 CRUD 面（issue #13 / agent-mobile#62 路径 A · 切片 1）。
//
// 用法：pnpm mem <slug|list|search|get|status|write|forget> [...]
//   mem slug [--dir <path>]                          推导 slug（缺 --dir 用 cwd）
//   mem list [--json]                                列索引里的 slug 小节与条目
//   mem search <kw> [--slug <s>] [--json]            跨 .mem/*.md 检索（标题/hook/正文）
//   mem get <slug> <filename> [--json]               打印单条记忆
//   mem status [--json]                              计数 + 健康摘要
//   mem write --slug <s> [--dry-run] [--json]        stdin 读 JSON（MemoryProposal[]）
//   mem forget <keyword> --slug <s> [--dry-run] [--json]
//
// 核心约束（本切片的价值所在）：对外读写**只经 core 既有函数**——推导用 deriveSlug，
// 读用 readMemoryIndex/parseMemoryIndex/readMemoryFile，写用 withFileLock + applyMemoryProposals
// / forgetMemory + writeMemoryIndex。本文件**不含任何 markdown 解析、不直写记忆文件**。
//
// 退出码：0 成功 / 1 用法错误 / 2 业务错误（slug 不存在、未匹配、载荷非法）。
import { readdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

import { deriveSlug, MemoryProposalArraySchema } from "../src/core/memory-types.ts";
import {
  getMemoryDir,
  getMemoryFilePath,
  readMemoryIndex,
  writeMemoryIndex,
  readMemoryFile,
  applyMemoryProposals,
  forgetMemory,
  parseMemoryIndex,
  type MemoryIndexSection,
} from "../src/core/store/memory-md.ts";
import { withFileLock, memoryIndexLockPath } from "../src/core/store/lock.ts";
import { runHealthCheck } from "../src/core/health/memory-health.ts";
import { loadMemxConfig } from "../src/core/config.ts";
import { createFileAlertStore } from "../src/core/alerts.ts";
import { createSync } from "../src/core/sync.ts";

class UsageError extends Error {}
class BusinessError extends Error {}

type Flags = Record<string, string | true>;

function parseFlags(argv: string[]): { flags: Flags; positionals: string[] } {
  const flags: Flags = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") continue;
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[body] = next;
        i++;
      } else {
        flags[body] = true;
      }
      continue;
    }
    positionals.push(arg);
  }
  return { flags, positionals };
}

function strFlag(flags: Flags, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

/** `--slug` / `--dir` 二选一（`--dir` 走宿主同款 deriveSlug）；都缺时按需报用法错误。 */
function resolveSlug(flags: Flags, required: boolean): string | null {
  const slug = strFlag(flags, "slug");
  if (slug) return slug;
  const dir = strFlag(flags, "dir");
  if (dir) return deriveSlug(dir);
  if (required) throw new UsageError("缺少 --slug <s>（或用 --dir <path> 推导）");
  return null;
}

/** 记忆目录集合 = 索引里的 slug ∪ 磁盘上有 .mem 的 slug（纯 fs 读，不解析内容）。 */
function allSlugs(): string[] {
  const slugs = new Set(parseMemoryIndex(readMemoryIndex()).sections.map((s) => s.slug));
  const projectsDir = dirname(dirname(getMemoryDir("_")));
  if (existsSync(projectsDir)) {
    for (const ent of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      if (existsSync(getMemoryDir(ent.name))) slugs.add(ent.name);
    }
  }
  return [...slugs].sort();
}

function listMemoryFiles(slug: string): string[] {
  const dir = getMemoryDir(slug);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && !f.startsWith("."))
    .sort();
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function out(json: boolean, payload: unknown, human: string[]): void {
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  for (const line of human) console.log(line);
}

// ---- 命令 ----

function cmdSlug(flags: Flags, json: boolean): void {
  const dir = strFlag(flags, "dir") ?? process.cwd();
  const slug = deriveSlug(dir);
  out(json, { slug, dir }, [slug]);
}

function cmdList(json: boolean): void {
  const sections: MemoryIndexSection[] = parseMemoryIndex(readMemoryIndex()).sections;
  const slugs = sections.map((s) => ({
    slug: s.slug,
    entries: s.entries.map((e) => ({
      title: e.title,
      hook: e.hook,
      file: e.filePath.split("/").pop() ?? e.filePath,
    })),
  }));
  const entryCount = sections.reduce((sum, s) => sum + s.entries.length, 0);
  const human: string[] = [];
  for (const s of slugs) {
    human.push(`## ${s.slug}`);
    for (const e of s.entries) human.push(`  - ${e.title} (${e.file}) - ${e.hook}`);
  }
  human.push(`共 ${slugs.length} 个 slug / ${entryCount} 个条目`);
  out(json, { slugs, count: { slugs: slugs.length, entries: entryCount } }, human);
}

function cmdSearch(keyword: string, slugFilter: string | null, json: boolean): void {
  if (!keyword) throw new UsageError("用法：mem search <kw> [--slug <s>] [--json]");
  const slugs = slugFilter ? [slugFilter] : allSlugs();
  const kw = keyword.toLowerCase();
  const matches: Array<{ slug: string; file: string; line: number; text: string }> = [];
  for (const slug of slugs) {
    for (const file of listMemoryFiles(slug)) {
      const content = readMemoryFile(slug, file);
      if (!content) continue;
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.toLowerCase().includes(kw)) {
          matches.push({ slug, file, line: i + 1, text: line.trim() });
        }
      }
    }
  }
  if (matches.length === 0) throw new BusinessError(`未匹配：${keyword}`);
  const human = matches.map((m) => `${m.slug}/${m.file}:${m.line}: ${m.text}`);
  human.push(`共 ${matches.length} 处匹配`);
  out(json, { keyword, matches, count: matches.length }, human);
}

function cmdGet(slug: string, filename: string, json: boolean): void {
  const filePath = getMemoryFilePath(slug, filename);
  if (!existsSync(filePath)) throw new BusinessError(`slug/文件不存在：${slug}/${filename}`);
  const content = readMemoryFile(slug, filename);
  out(json, { slug, file: filename, content }, [content.replace(/\n$/, "")]);
}

function cmdStatus(json: boolean): void {
  const sections = parseMemoryIndex(readMemoryIndex()).sections;
  const entries = sections.reduce((sum, s) => sum + s.entries.length, 0);
  const slugs = allSlugs();
  let files = 0;
  for (const slug of slugs) files += listMemoryFiles(slug).length;

  let deadLinks = 0;
  let orphanFiles = 0;
  let indexLineCount = 0;
  const escalated: string[] = [];
  const indexContent = readMemoryIndex();
  for (const slug of slugs) {
    const report = runHealthCheck(indexContent, slug);
    deadLinks += report.deadLinks.length;
    orphanFiles += report.orphanFiles.length;
    indexLineCount = report.indexLineCount;
    for (const msg of report.escalated) if (!escalated.includes(msg)) escalated.push(msg);
  }

  const health = { deadLinks, orphanFiles, indexLines: indexLineCount, escalated };
  const human = [
    `slug: ${slugs.length}`,
    `条目: ${entries}`,
    `文件: ${files}`,
    `健康: deadLinks=${deadLinks} orphanFiles=${orphanFiles} indexLines=${indexLineCount}`,
  ];
  for (const msg of escalated) human.push(`escalated: ${msg}`);
  out(json, { slugs: slugs.length, entries, files, health }, human);
}

async function cmdWrite(slug: string, dryRun: boolean, json: boolean): Promise<void> {
  const raw = await readStdin();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new BusinessError(`stdin 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
  }
  const validated = MemoryProposalArraySchema.safeParse(parsed);
  if (!validated.success) {
    throw new BusinessError(`载荷不符合 MemoryProposal[]：${validated.error.issues[0]?.message ?? "校验失败"}`);
  }
  const proposals = validated.data;
  const added = proposals.filter((p) => p.action === "append").length;
  const updated = proposals.filter((p) => p.action === "update").length;
  const removed = proposals.filter((p) => p.action === "deprecate").length;
  const files = proposals.map((p) => p.target_file);

  if (dryRun) {
    const human = [
      `dry-run：added=${added} updated=${updated} removed=${removed}（未写盘）`,
      `slug: ${slug}`,
      ...files.map((f) => `  ~ ${f}`),
    ];
    out(json, { dryRun: true, slug, added, updated, removed, files, warnings: [], indexChanged: false }, human);
    return;
  }

  const warnings = await withFileLock(memoryIndexLockPath(), () => {
    const existing = readMemoryIndex();
    const result = applyMemoryProposals(proposals, existing, slug);
    writeMemoryIndex(result.content);
    return result.warnings;
  });

  const human = [
    `已写入：added=${added} updated=${updated} removed=${removed}`,
    `slug: ${slug}`,
    ...files.map((f) => `  + ${f}`),
  ];
  for (const w of warnings) human.push(`  ! ${w}`);
  out(json, { dryRun: false, slug, added, updated, removed, files, warnings, indexChanged: true }, human);
}

/** 与 core `forgetMemory` 同款谓词（title/hook/filePath 三处大小写不敏感包含）。 */
function forgetPreview(keyword: string, slug: string): string[] {
  const section = parseMemoryIndex(readMemoryIndex()).sections.find((s) => s.slug === slug);
  if (!section) return [];
  const kw = keyword.toLowerCase();
  return section.entries
    .filter(
      (e) =>
        e.title.toLowerCase().includes(kw) ||
        e.hook.toLowerCase().includes(kw) ||
        e.filePath.toLowerCase().includes(kw),
    )
    .map((e) => e.filePath.split("/").pop() ?? e.filePath);
}

/** 本地删除后立刻推一次云同步（issue #21）：不推的话下一轮 pull 会把刚删的文件原样拉回。
 *  未启用 / 失败都不影响本地删除结果——这里只做尽力收敛，绝不让同步问题把 forget 变成失败。 */
async function pushAfterForget(): Promise<string> {
  try {
    const config = (await loadMemxConfig()).sync;
    if (!config.enabled || config.machineName === "") return "";
    const sync = createSync({ config, alerts: createFileAlertStore() });
    const r = await sync.push();
    sync.dispose();
    return r.ok ? `；云同步：${r.message}` : `；云同步未推成功：${r.message}`;
  } catch (err) {
    return `；云同步异常（本地删除已生效）：${err instanceof Error ? err.message : String(err)}`;
  }
}

async function cmdForget(keyword: string, slug: string, dryRun: boolean, json: boolean): Promise<void> {
  if (!keyword) throw new UsageError("用法：mem forget <keyword> --slug <s> [--dry-run] [--json]");

  if (dryRun) {
    const matched = forgetPreview(keyword, slug);
    if (matched.length === 0) throw new BusinessError(`未匹配：${keyword} (slug=${slug})`);
    const human = [`dry-run：将移除 ${matched.length} 条（移入 .trash，未写盘）`, ...matched.map((f) => `  - ${f}`)];
    out(json, { dryRun: true, slug, keyword, removed: matched, indexChanged: false }, human);
    return;
  }

  const removed = await withFileLock(memoryIndexLockPath(), () => {
    const existing = readMemoryIndex();
    const result = forgetMemory(keyword, existing, slug);
    if (result.removed.length > 0) writeMemoryIndex(result.newIndex);
    return result.removed;
  });
  if (removed.length === 0) throw new BusinessError(`未匹配：${keyword} (slug=${slug})`);

  const syncNote = await pushAfterForget();
  const human = [`已移除 ${removed.length} 条（移入 .trash 并更新索引）`, ...removed.map((f) => `  - ${f}`)];
  if (syncNote) human.push(syncNote.slice(1));
  out(json, { dryRun: false, slug, keyword, removed, indexChanged: true }, human);
}

// ---- 分发 ----

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const { flags, positionals } = parseFlags(argv.slice(1));
  const json = flags["json"] === true;
  const dryRun = flags["dry-run"] === true;

  switch (command) {
    case "slug":
      return cmdSlug(flags, json);
    case "list":
      return cmdList(json);
    case "search":
      return cmdSearch(positionals[0] ?? "", resolveSlug(flags, true), json);
    case "get": {
      const slug = positionals[0];
      const filename = positionals[1];
      if (!slug || !filename) throw new UsageError("用法：mem get <slug> <filename> [--json]");
      return cmdGet(slug, filename, json);
    }
    case "status":
      return cmdStatus(json);
    case "write":
      return cmdWrite(resolveSlug(flags, true)!, dryRun, json);
    case "forget":
      return cmdForget(positionals[0] ?? "", resolveSlug(flags, true)!, dryRun, json);
    default:
      throw new UsageError(
        "用法：mem <slug|list|search|get|status|write|forget> [...]（详见 scripts/mem.ts 头部注释）",
      );
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  const code = err instanceof UsageError ? 1 : 2;
  console.error(`mem: ${msg}`);
  process.exitCode = code;
});
