// memx backfill:created —— 存量卡片 `created` 一次性回填（issue #34）
//
// 用法：
//   node --experimental-strip-types scripts/backfill-created.ts --dry-run
//   node --experimental-strip-types scripts/backfill-created.ts
//
// 为什么需要：`created` 是 f8f3622 才加进 frontmatter 的字段，之前写下的卡都没有 →
// doctor 的龄期分布全是「未知」。**禁止用 mtime 兜底**（update 会重置 mtime，sync pull 的
// copyFileSync 也会重置），只认 sync-repo 的 git 首次新增时间；查不到就保持未知，不猜。
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

import { readCreatedDate, patchCreatedDate } from "../src/core/store/memory-md.ts";
import { withFileLock, memoryIndexLockPath } from "../src/core/store/lock.ts";

export interface BackfillOptions {
  /** memx 根目录，默认 `~/.opencode` */
  root?: string;
  /** 同步镜像仓库，默认 `<root>/memx-sync-repo` */
  syncRepo?: string;
  dryRun?: boolean;
  log?: (line: string) => void;
}

export interface BackfillResult {
  /** 本次写入（或 dry-run 下将写入）的卡数 */
  filled: number;
  /** 已有 created、跳过 */
  already: number;
  /** git 里查不到首次提交，保持未知 */
  unknown: number;
  /** 涉及的文件名（相对 `<slug>/.mem/`），供日志展示 */
  files: string[];
}

interface CardRef {
  slug: string;
  file: string;
  abs: string;
  repoPath: string;
}

/** 列出所有卡片（跳过 `.trash/` 与 `.bak.*`，与 sync 的镜像规则保持一致）。 */
function listCards(root: string): CardRef[] {
  const out: CardRef[] = [];
  const projectsDir = join(root, "projects");
  if (!existsSync(projectsDir)) return out;
  for (const slug of readdirSync(projectsDir).sort()) {
    const memDir = join(projectsDir, slug, ".mem");
    if (!existsSync(memDir) || !statSync(memDir).isDirectory()) continue;
    const walk = (dir: string, prefix: string): void => {
      for (const name of readdirSync(dir).sort()) {
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) {
          if (name === ".trash") continue;
          walk(full, `${prefix}${name}/`);
          continue;
        }
        if (!st.isFile() || !name.endsWith(".md") || name.includes(".bak.")) continue;
        out.push({ slug, file: name, abs: full, repoPath: `projects/${slug}/.mem/${prefix}${name}` });
      }
    };
    walk(memDir, "");
  }
  return out;
}

/** sync-repo 里该路径**首次新增**的提交时间（`YYYY-MM-DD`）；查不到返回 null。 */
export function firstCommitDate(syncRepo: string, repoPath: string): string | null {
  if (!existsSync(join(syncRepo, ".git"))) return null;
  const res = spawnSync("git", ["-C", syncRepo, "log", "--diff-filter=A", "--format=%aI", "--", repoPath], {
    encoding: "utf-8",
  });
  if (res.status !== 0) return null;
  const lines = (res.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  // git log 默认新→旧，首次新增 = 最后一条
  const iso = lines[lines.length - 1];
  if (iso === undefined) return null;
  const date = iso.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

export async function backfillCreated(options: BackfillOptions = {}): Promise<BackfillResult> {
  const root = options.root ?? join(homedir(), ".opencode");
  const syncRepo = options.syncRepo ?? join(root, "memx-sync-repo");
  const log = options.log ?? (() => {});
  const cards = listCards(root);

  const pending: Array<{ card: CardRef; created: string }> = [];
  let already = 0;
  let unknown = 0;

  for (const card of cards) {
    const content = readFileSync(card.abs, "utf-8");
    if (readCreatedDate(content) != null) {
      already += 1;
      continue;
    }
    const created = firstCommitDate(syncRepo, card.repoPath);
    if (created == null) {
      unknown += 1;
      continue;
    }
    pending.push({ card, created });
  }

  if (options.dryRun) {
    log(`[dry-run] 将回填 ${pending.length} / 已有 ${already} / 保留未知 ${unknown}`);
    for (const item of pending.slice(0, 10)) log(`  将回填 ${item.card.slug}/${item.card.file} → ${item.created}`);
    return { filled: pending.length, already, unknown, files: pending.map((i) => i.card.file) };
  }

  // 与写盘共用一把锁：回填是 read-modify-write，不能和 memory_write / 提炼并发
  await withFileLock(memoryIndexLockPath(), () => {
    for (const item of pending) {
      patchCreatedDate(item.card.slug, item.card.file, item.created);
    }
  });

  return { filled: pending.length, already, unknown, files: pending.map((i) => i.card.file) };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const result = await backfillCreated({ dryRun, log: (line) => console.log(line) });
  if (!dryRun) {
    console.log(`已回填 ${result.filled} / 已有 ${result.already} / 保留未知 ${result.unknown}`);
    for (const file of result.files.slice(0, 10)) console.log(`  ✓ ${file}`);
  }
}

// 只在直接执行时跑 main（被测试 import 时不要触发）
if (process.argv[1]?.endsWith("backfill-created.ts")) {
  void main();
}
