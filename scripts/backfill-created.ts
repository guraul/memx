// memx backfill:created —— 存量卡片 `created` 一次性回填（issue #34，修正见 #34 follow-up）
//
// 用法：
//   node --experimental-strip-types scripts/backfill-created.ts --dry-run
//   node --experimental-strip-types scripts/backfill-created.ts
//
// 为什么需要：`created` 是 f8f3622 才加进 frontmatter 的字段，之前写下的卡都没有 →
// doctor 的龄期分布全是「未知」。**禁止用 mtime 兜底**（update 会重置 mtime，sync pull 的
// copyFileSync 也会重置），只认 sync-repo 的 git 首次新增时间；查不到就保持未知，不猜。
//
// 两条语义修正（生产 dry-run 实测）：
//   ① **引导提交（root commit）不算创建时刻**：`memx-sync-repo` 是 2026-10-13 一次性导入建成，
//      随镜像首导进仓的卡在 `git log --diff-filter=A` 里同样"有新增记录"，但那是**导入日**。
//      照它回填等于给几十张卡盖同一根假柱子 → 这里判 unknown（不写）。判据：首次新增 commit
//      的 SHA ∈ `git rev-list --max-parents=0 HEAD`（可能有多个根提交，全算）。
//   ② **`projects/.mem/` 下的空 slug 遗留卡要也能被看见**：它们直接躺在 `projects/.mem/`，
//      不在任何 `<slug>/.mem/` 里，旧实现漏扫。但 slug `""` 在 memx 里是**哨兵**
//      （`deriveSlug` 对"宿主取不到 cwd"返回 `""`，`writeMemoryFile` 对它失败），
//      不是合法项目 → 只列出 + 计数，**不写盘**（人工处理）。
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
  /** 保持未知（git 里查不到首次提交，或首次提交就是引导提交） */
  unknown: number;
  /** `unknown` 中因"随镜像首导（引导提交）进仓"而不可知的数量 */
  unknownBootstrap: number;
  /** 空 slug 遗留卡（`projects/.mem/` 下），需人工处理，不写盘 */
  skipped: number;
  /** 涉及的文件名（相对 `<slug>/.mem/`，空 slug 卡为 `projects/.mem/<file>`），供日志展示 */
  files: string[];
}

interface CardRef {
  slug: string;
  /** 相对 `.mem/` 的路径（含子目录前缀） */
  file: string;
  abs: string;
  repoPath: string;
  /** 空 slug 遗留卡（`projects/.mem/` 直接落盘，slug 为哨兵 `""`）——只报不写 */
  legacy: boolean;
}

/** 遍历一个 `.mem/` 目录，收集卡片（跳过 `.trash/` 与 `.bak.*`，与 sync 的镜像规则一致）。 */
function walkMemDir(
  memDir: string,
  slug: string,
  repoPathPrefix: string,
  legacy: boolean,
  out: CardRef[],
): void {
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
      out.push({
        slug,
        file: `${prefix}${name}`,
        abs: full,
        repoPath: `${repoPathPrefix}${prefix}${name}`,
        legacy,
      });
    }
  };
  walk(memDir, "");
}

/** 列出所有卡片（`projects/<slug>/.mem/` + `projects/.mem/` 空 slug 遗留）。 */
function listCards(root: string): CardRef[] {
  const out: CardRef[] = [];
  const projectsDir = join(root, "projects");
  if (!existsSync(projectsDir)) return out;

  // `projects/.mem`：空 slug 遗留（不在任何 `<slug>/.mem/` 里，旧实现漏扫）
  const legacyDir = join(projectsDir, ".mem");
  if (existsSync(legacyDir) && statSync(legacyDir).isDirectory()) {
    walkMemDir(legacyDir, "", "projects/.mem/", true, out);
  }

  for (const slug of readdirSync(projectsDir).sort()) {
    if (slug === ".mem") continue;
    const memDir = join(projectsDir, slug, ".mem");
    if (!existsSync(memDir) || !statSync(memDir).isDirectory()) continue;
    walkMemDir(memDir, slug, `projects/${slug}/.mem/`, false, out);
  }
  return out;
}

/** 仓库的引导提交（root commit，`--max-parents=0`）SHA 集合；不是 git 仓库 / 空仓返回空集。 */
export function bootstrapCommits(syncRepo: string): Set<string> {
  if (!existsSync(join(syncRepo, ".git"))) return new Set();
  const res = spawnSync("git", ["-C", syncRepo, "rev-list", "--max-parents=0", "HEAD"], {
    encoding: "utf-8",
  });
  if (res.status !== 0) return new Set();
  return new Set(
    (res.stdout ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}

/** sync-repo 里该路径**首次新增**的提交（SHA + `YYYY-MM-DD`）；查不到返回 null。 */
export function firstCommit(syncRepo: string, repoPath: string): { sha: string; date: string } | null {
  if (!existsSync(join(syncRepo, ".git"))) return null;
  const res = spawnSync(
    "git",
    ["-C", syncRepo, "log", "--diff-filter=A", "--format=%H %aI", "--", repoPath],
    { encoding: "utf-8" },
  );
  if (res.status !== 0) return null;
  const lines = (res.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  // git log 默认新→旧，首次新增 = 最后一条
  const oldest = lines[lines.length - 1];
  if (oldest === undefined) return null;
  const [sha, iso] = oldest.split(" ");
  if (sha === undefined || iso === undefined) return null;
  const date = iso.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? { sha, date } : null;
}

/** 首次新增提交的日期；查不到返回 null。（保留给只关心日期的调用方） */
export function firstCommitDate(syncRepo: string, repoPath: string): string | null {
  return firstCommit(syncRepo, repoPath)?.date ?? null;
}

export async function backfillCreated(options: BackfillOptions = {}): Promise<BackfillResult> {
  const root = options.root ?? join(homedir(), ".opencode");
  const syncRepo = options.syncRepo ?? join(root, "memx-sync-repo");
  const log = options.log ?? (() => {});
  const cards = listCards(root);

  const pending: Array<{ card: CardRef; created: string }> = [];
  const skippedCards: CardRef[] = [];
  let already = 0;
  let unknown = 0;
  let unknownBootstrap = 0;

  // 引导提交只算一次（root commit 可能有多个：orphan 重导会造出新的根提交）
  const bootstrap = bootstrapCommits(syncRepo);
  // 没有引导提交集（不是 git 仓库 / 空仓）时，无卡可比对，全部照旧走 unknown 分支

  for (const card of cards) {
    // 空 slug 是哨兵（宿主取不到 cwd），不是合法项目：只列出，不写盘，交人工处理
    if (card.legacy) {
      skippedCards.push(card);
      continue;
    }
    const content = readFileSync(card.abs, "utf-8");
    if (readCreatedDate(content) != null) {
      already += 1;
      continue;
    }
    const first = firstCommit(syncRepo, card.repoPath);
    if (first == null) {
      unknown += 1;
      continue;
    }
    // 随镜像首导进仓：首次新增就是引导提交 → 那是导入日，不是创建日
    if (bootstrap.has(first.sha)) {
      unknown += 1;
      unknownBootstrap += 1;
      continue;
    }
    pending.push({ card, created: first.date });
  }

  const files = pending.map((i) => i.card.file);
  const result: BackfillResult = {
    filled: pending.length,
    already,
    unknown,
    unknownBootstrap,
    skipped: skippedCards.length,
    files,
  };

  if (options.dryRun) {
    const skippedNote = skippedCards.length > 0 ? ` / 跳过 ${skippedCards.length}（空 slug 遗留）` : "";
    log(`[dry-run] 将回填 ${pending.length} / 已有 ${already} / 保留未知 ${unknown}${skippedNote}`);
    if (unknownBootstrap > 0) {
      log(`  保留未知 ${unknown} 中 ${unknownBootstrap} 张随镜像首导（引导提交 ${bootstrap.size} 个）进仓，创建时间不可知`);
    }
    for (const item of pending.slice(0, 10)) log(`  将回填 ${item.card.slug}/${item.card.file} → ${item.created}`);
    for (const card of skippedCards.slice(0, 10)) {
      log(`  跳过 ${card.repoPath}（空 slug 遗留，需人工处理：应归入某个项目或 projects/root/.mem/）`);
    }
    return result;
  }

  // 与写盘共用一把锁：回填是 read-modify-write，不能和 memory_write / 提炼并发
  await withFileLock(memoryIndexLockPath(), () => {
    for (const item of pending) {
      patchCreatedDate(item.card.slug, item.card.file, item.created);
    }
  });

  return result;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const result = await backfillCreated({ dryRun, log: (line) => console.log(line) });
  if (!dryRun) {
    const skippedNote = result.skipped > 0 ? ` / 跳过 ${result.skipped}（空 slug 遗留）` : "";
    console.log(`已回填 ${result.filled} / 已有 ${result.already} / 保留未知 ${result.unknown}${skippedNote}`);
    for (const file of result.files.slice(0, 10)) console.log(`  ✓ ${file}`);
  }
}

// 只在直接执行时跑 main（被测试 import 时不要触发）
if (process.argv[1]?.endsWith("backfill-created.ts")) {
  void main();
}
