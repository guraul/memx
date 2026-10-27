// memx backfill:created —— 存量卡片 `created` 一次性回填（issue #34，修正见 #34 follow-up）
//
// 用法：
//   node --experimental-strip-types scripts/backfill-created.ts --dry-run
//   node --experimental-strip-types scripts/backfill-created.ts --push
//
// ⚠️ **回填后必须 push**（生产事故，2026-10-27）：本脚本直接写盘，不经过 `memory_write` 的
// 自动推送路径。只写不推 = 本地有 created、镜像 `memx-sync-repo` 里没有 → **下一次 sync pull
// 按镜像覆写本地，62 张卡刚回填的 created 全部被抹掉**。所以：
//   · 传 `--push`：写完（且真有写入）后复用 `pnpm sync:op -- push` 那条路径
//     （`loadMemxConfig()` 读 machineName/repo → `createSync().push()`），成功打摘要；
//   · 不传 `--push`：打多行醒目警告（不推送会被 pull 覆盖）；
//   · 推送失败**不掩盖已写入的事实**：明确报"写入已完成但推送失败" + 手动指引，退出码非 0；
//   · sync 未启用（enabled=false / machineName 空）不算故障：给出配置指引，退出码 0
//     （没有 pull 就不会被覆盖）。
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
//
// ③ **写失败的卡不能算 filled**（生产实测 2026-10-27）：`patchCreatedDate()` 返回 false 的
//   一次也没写进去，旧实现仍按 pending 长度报「已回填 61」，实际只落 60 张。现在按原因分账：
//   `skippedNoFrontmatter`（卡片没有 frontmatter 块 —— 补 `created` 无处可插，硬补等于重写
//   整篇格式，必须原样不动）/ `skippedWriteFailed`（文件消失、期间已有 created、写入异常）/
//   `skippedLegacy`（空 slug 遗留）。已有 `created` 的仍归 `already`。
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

import { readCreatedDate, patchCreatedDate, hasFrontmatter } from "../src/core/store/memory-md.ts";
import { withFileLock, memoryIndexLockPath } from "../src/core/store/lock.ts";
import { loadMemxConfig } from "../src/core/config.ts";
import { createFileAlertStore } from "../src/core/alerts.ts";
import { createSync } from "../src/core/sync.ts";

/** 推送结果摘要（真实实现由 `createSync().push()` 产出，测试可注入假实现）。 */
export interface BackfillPushSummary {
  ok: boolean;
  /** `pushed` / `no-change` / `pii-blocked` / `conflict` / `error` / `disabled` */
  kind: string;
  message: string;
  /** 未推提交数（push 成功后应为 0） */
  unsyncedCommits?: number;
  /** sync 未启用（enabled=false 或 machineName 为空）——不是故障，给指引即可 */
  disabled?: boolean;
}

/** 可注入的推送依赖：默认实现走真实 sync，测试注入假实现（绝不真 push）。 */
export type BackfillPusher = () => Promise<BackfillPushSummary>;

/** 本次推送的最终结论（`null` = 没尝试推送）。 */
export interface BackfillPushOutcome {
  ok: boolean;
  kind: string;
  message: string;
  disabled: boolean;
}

export interface BackfillOptions {
  /** memx 根目录，默认 `~/.opencode` */
  root?: string;
  /** 同步镜像仓库，默认 `<root>/memx-sync-repo` */
  syncRepo?: string;
  dryRun?: boolean;
  /** 真有写入时推送（与 `pnpm sync:op -- push` 同一条代码路径）；不传则只警告。 */
  push?: boolean;
  /** 推送实现覆盖（测试用）。默认读 memx 配置 → `createSync().push()`。 */
  pusher?: BackfillPusher;
  log?: (line: string) => void;
}

export interface BackfillResult {
  /** 本次**实际写成功**（dry-run 下为将写入）的卡数 */
  filled: number;
  /** 已有 created、跳过 */
  already: number;
  /** 保持未知（git 里查不到首次提交，或首次提交就是引导提交） */
  unknown: number;
  /** `unknown` 中因"随镜像首导（引导提交）进仓"而不可知的数量 */
  unknownBootstrap: number;
  /** 未写入的卡总数（= 下面三类之和） */
  skipped: number;
  /** 无 frontmatter 块：无可插入位置，原样不动 */
  skippedNoFrontmatter: number;
  /** 其它写失败：文件消失 / 期间已有 created / 写入异常 */
  skippedWriteFailed: number;
  /** 空 slug 遗留卡（`projects/.mem/` 下），需人工处理，不写盘 */
  skippedLegacy: number;
  /** 实际写入（或 dry-run 下将写入）的文件名，供日志展示 */
  files: string[];
  /** 跳过的卡与可读原因，供逐条明细展示 */
  skippedCards: SkippedCard[];
  /** 本次推送结论；`null` = 未尝试（没写入 / 没传 `--push` / dry-run） */
  push: BackfillPushOutcome | null;
}

/** 跳过原因分类（计数与明细共用一套码）。 */
export type SkipCode = "no-frontmatter" | "write-failed" | "legacy-empty-slug";

export interface SkippedCard {
  /** 相对 memx 根的路径（空 slug 卡为 `projects/.mem/<file>`） */
  repoPath: string;
  code: SkipCode;
  reason: string;
}

const SKIP_REASONS: Record<SkipCode, string> = {
  "no-frontmatter": "无 frontmatter：首字符非 --- 或 CRLF 行尾，补行等于重写整篇，保持原样",
  "write-failed": "写失败（文件消失 / 期间已有 created / 写入异常）",
  "legacy-empty-slug": "空 slug 遗留，需人工处理：应归入某个项目或 projects/root/.mem/",
};

function skip(code: SkipCode, repoPath: string): SkippedCard {
  return { repoPath, code, reason: SKIP_REASONS[code] };
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

/** 汇总行：`<head> N / 已有 M / 保留未知 K / 跳过 S（无 frontmatter X，写失败 Y，空 slug 遗留 Z）` */
function summaryLine(head: string, result: BackfillResult): string {
  const skipped =
    result.skipped > 0
      ? ` / 跳过 ${result.skipped}（无 frontmatter ${result.skippedNoFrontmatter}，写失败 ${result.skippedWriteFailed}，空 slug 遗留 ${result.skippedLegacy}）`
      : "";
  return `${head} ${result.filled} / 已有 ${result.already} / 保留未知 ${result.unknown}${skipped}`;
}

/** 手动补推指引（失败与"没传 --push"两处共用，避免两套措辞）。 */
const MANUAL_PUSH_HINT =
  "    → 请手动 pnpm sync:op -- push --machine=<name>（<name> = memx.config.json 的 sync.machineName）";

/** 真实推送：与 `pnpm sync:op -- push` 完全同一条路径（同一份配置、同一个 `createSync().push()`）。 */
async function defaultPusher(): Promise<BackfillPushSummary> {
  const config = (await loadMemxConfig()).sync;
  // 与 createSync 的 `active` 判据一致：未启用时它只返回 error，这里提前分出来给"配置指引"而不是"故障"
  if (!config.enabled || config.machineName === "") {
    return {
      ok: false,
      kind: "disabled",
      disabled: true,
      message: `enabled=${config.enabled} machineName=${config.machineName || "(未设置)"}`,
    };
  }
  const sync = createSync({ config, alerts: createFileAlertStore() });
  try {
    const r = await sync.push();
    return { ok: r.ok, kind: r.kind, message: r.message, unsyncedCommits: sync.status().unsyncedCommits };
  } finally {
    sync.dispose();
  }
}

/** 执行推送并打印结论；任何异常都收敛成 `ok=false`（推送失败绝不能把"已写入"这个事实吞掉）。 */
async function runPush(
  pusher: BackfillPusher,
  log: (line: string) => void,
): Promise<BackfillPushOutcome> {
  log(`推送中（与 pnpm sync:op -- push 同一路径）…`);
  let summary: BackfillPushSummary;
  try {
    summary = await pusher();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`⚠️  写入已完成但推送失败：${message}`);
    log("    本地 created 已落盘、镜像里没有 → 下一次 sync pull 会按镜像覆写，created 会被抹掉。");
    log(MANUAL_PUSH_HINT);
    return { ok: false, kind: "threw", message, disabled: false };
  }

  if (summary.ok) {
    const unsynced = summary.unsyncedCommits != null ? `（未推提交 ${summary.unsyncedCommits}）` : "";
    log(`✓ 推送成功：kind=${summary.kind} ${summary.message}${unsynced}`);
    return { ok: true, kind: summary.kind, message: summary.message, disabled: false };
  }

  if (summary.disabled) {
    log(`未推送：sync 未启用（${summary.message}）`);
    log("    本机没有定时 pull，created 不会被远端覆盖；要上云请先在 memx.config.json 开 sync.enabled + machineName。");
    return { ok: false, kind: summary.kind, message: summary.message, disabled: true };
  }

  log(`⚠️  写入已完成但推送失败：${summary.message}`);
  log("    本地 created 已落盘、镜像里没有 → 下一次 sync pull 会按镜像覆写，created 会被抹掉。");
  log(MANUAL_PUSH_HINT);
  return { ok: false, kind: summary.kind, message: summary.message, disabled: false };
}

/** 没传 `--push` 又确实写了盘：多行醒目警告（生产上就是这样丢的 62 张卡）。 */
function warnNotPushed(log: (line: string) => void): void {
  log("");
  log("⚠️  ⚠️  ⚠️  本次写入没有推送 —— 不推送，下一次 sync pull 会把 created 全部覆盖掉");
  log("    原因：本脚本直接写盘，不经过 memory_write，不会触发自动推送；");
  log("    而 sync pull 是「远端优先」：镜像 memx-sync-repo 里这些卡还没有 created，pull 会按镜像覆写本地。");
  log("    补推：pnpm run backfill:created --push（幂等，已写过的不再写），或 pnpm sync:op -- push");
}

export async function backfillCreated(options: BackfillOptions = {}): Promise<BackfillResult> {
  const root = options.root ?? join(homedir(), ".opencode");
  const syncRepo = options.syncRepo ?? join(root, "memx-sync-repo");
  const log = options.log ?? (() => {});
  const cards = listCards(root);

  const pending: Array<{ card: CardRef; created: string }> = [];
  const skippedCards: SkippedCard[] = [];
  let already = 0;
  let unknown = 0;
  let unknownBootstrap = 0;

  // 引导提交只算一次（root commit 可能有多个：orphan 重导会造出新的根提交）
  const bootstrap = bootstrapCommits(syncRepo);
  // 没有引导提交集（不是 git 仓库 / 空仓）时，无卡可比对，全部照旧走 unknown 分支

  for (const card of cards) {
    // 空 slug 是哨兵（宿主取不到 cwd），不是合法项目：只列出，不写盘，交人工处理
    if (card.legacy) {
      skippedCards.push(skip("legacy-empty-slug", card.repoPath));
      continue;
    }
    const content = readFileSync(card.abs, "utf-8");
    if (readCreatedDate(content) != null) {
      already += 1;
      continue;
    }
    // 无 frontmatter 块：`patchCreatedDate()` 必然返回 false。归 skipped 而不是 unknown ——
    // 不是"时间查不到"，而是"这张卡根本写不进去"，且任何补写都会重排整篇 → 一个字节都不动。
    if (!hasFrontmatter(content)) {
      skippedCards.push(skip("no-frontmatter", card.repoPath));
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

  // dry-run 不写盘，按计划记账；真跑只记 patchCreatedDate() 真的返回 true 的
  let written: Array<{ card: CardRef; created: string }> = pending;
  if (!options.dryRun) {
    const done: Array<{ card: CardRef; created: string }> = [];
    // 与写盘共用一把锁：回填是 read-modify-write，不能和 memory_write / 提炼并发
    await withFileLock(memoryIndexLockPath(), () => {
      for (const item of pending) {
        let ok = false;
        try {
          ok = patchCreatedDate(item.card.slug, item.card.file, item.created);
        } catch {
          // 写失败（权限 / 磁盘 / 竞态）不该中断整批，也不该被算成 filled
          ok = false;
        }
        if (ok) done.push(item);
        else skippedCards.push(skip("write-failed", item.card.repoPath));
      }
    });
    written = done;
  }

  const result: BackfillResult = {
    filled: written.length,
    already,
    unknown,
    unknownBootstrap,
    skipped: skippedCards.length,
    skippedNoFrontmatter: skippedCards.filter((card) => card.code === "no-frontmatter").length,
    skippedWriteFailed: skippedCards.filter((card) => card.code === "write-failed").length,
    skippedLegacy: skippedCards.filter((card) => card.code === "legacy-empty-slug").length,
    files: written.map((item) => item.card.file),
    skippedCards,
    push: null,
  };

  log(summaryLine(options.dryRun ? "[dry-run] 将回填" : "已回填", result));
  if (unknownBootstrap > 0) {
    log(`  保留未知 ${unknown} 中 ${unknownBootstrap} 张随镜像首导（引导提交 ${bootstrap.size} 个）进仓，创建时间不可知`);
  }
  for (const item of written.slice(0, 10)) {
    log(
      options.dryRun
        ? `  将回填 ${item.card.slug}/${item.card.file} → ${item.created}`
        : `  ✓ ${item.card.file}`,
    );
  }
  // 跳过明细带原因（两类模式都打；上限 10 条，避免刷屏）
  for (const card of skippedCards.slice(0, 10)) log(`  跳过 ${card.repoPath}（${card.reason}）`);

  // ---- 推送：只有"真写了盘"才需要（dry-run 没写入、filled=0 没东西可推） ----
  const wroteSomething = !options.dryRun && result.filled > 0;
  if (wroteSomething) {
    if (options.push) result.push = await runPush(options.pusher ?? defaultPusher, log);
    else warnNotPushed(log);
  } else if (options.dryRun && options.push) {
    log("[dry-run] 未推送（没有写盘，无内容可推）");
  }

  return result;
}

export interface BackfillCliOptions {
  root?: string;
  syncRepo?: string;
  /** 注入假 pusher（测试用）；不传走真实 sync。 */
  pusher?: BackfillPusher;
  log?: (line: string) => void;
}

/**
 * CLI 入口的纯函数版：解析 `--dry-run` / `--push` 并返回**退出码**（不写 `process.exitCode`，
 * 便于测试直接断言；`main()` 负责把它落到进程上）。
 * 退出码 1 只用于"写入成功但推送真失败"——sync 未启用不算失败。
 */
export async function runBackfillCli(
  argv: readonly string[],
  opts: BackfillCliOptions = {},
): Promise<{ exitCode: number; result: BackfillResult }> {
  const options: BackfillOptions = {
    dryRun: argv.includes("--dry-run"),
    push: argv.includes("--push"),
  };
  if (opts.root !== undefined) options.root = opts.root;
  if (opts.syncRepo !== undefined) options.syncRepo = opts.syncRepo;
  if (opts.pusher !== undefined) options.pusher = opts.pusher;
  options.log = opts.log ?? ((line: string) => console.log(line));

  const result = await backfillCreated(options);
  const pushFailed = result.push !== null && !result.push.ok && !result.push.disabled;
  return { exitCode: pushFailed ? 1 : 0, result };
}

async function main(): Promise<void> {
  const { exitCode } = await runBackfillCli(process.argv.slice(2));
  if (exitCode !== 0) process.exitCode = exitCode;
}

// 只在直接执行时跑 main（被测试 import 时不要触发）
if (process.argv[1]?.endsWith("backfill-created.ts")) {
  void main();
}
