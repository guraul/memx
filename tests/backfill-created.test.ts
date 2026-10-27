import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { backfillCreated, runBackfillCli } from "../scripts/backfill-created.ts";
import type { BackfillPusher, BackfillPushSummary } from "../scripts/backfill-created.ts";
import { readCreatedDate } from "../src/core/store/memory-md.ts";

// 独立 HOME：patchCreatedDate / 锁路径都经 homedir() 派生，测试绝不能碰真实 ~/.opencode。
// 每个用例一套全新 HOME + 全新 sync-repo：引导提交必须是「该仓库的第一个提交」，
// 共享仓库会让第二个用例的首个提交变成子提交，测不到 unknown 分支。
let home = "";
let root = "";
let syncRepo = "";
let oldHome: string | undefined;

function card(body: string, created?: string): string {
  const lines = ["---", "name: 示例", "description: 说明", "type: project"];
  if (created) lines.push(`created: ${created}`);
  lines.push("updated: 2026-10-01", "---", "", body);
  return lines.join("\n") + "\n";
}

function writeCard(slug: string, file: string, content: string): string {
  const dir = join(root, "projects", slug, ".mem");
  mkdirSync(dir, { recursive: true });
  const abs = join(dir, file);
  writeFileSync(abs, content, "utf-8");
  return abs;
}

/** 空 slug 遗留：直接躺在 `projects/.mem/` 下，不在任何 `<slug>/.mem/` 里 */
function writeLegacyCard(file: string, content: string): string {
  const dir = join(root, "projects", ".mem");
  mkdirSync(dir, { recursive: true });
  const abs = join(dir, file);
  writeFileSync(abs, content, "utf-8");
  return abs;
}

function commitPaths(paths: string[], when: string, message = "commit"): void {
  const env = { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when };
  spawnSync("git", ["-C", syncRepo, "add", ...paths], { env });
  spawnSync("git", ["-C", syncRepo, "commit", "-q", "-m", message], { env });
}

/** 把 root 下的卡复制进 sync-repo 并提交 */
function commitInto(repoPath: string, when: string): void {
  const abs = join(syncRepo, repoPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  cpSync(join(root, repoPath), abs);
  commitPaths([repoPath], when, `add ${repoPath}`);
}

/** 直接往 sync-repo 写一个非卡片文件并提交（造引导提交用） */
function commitRaw(repoPath: string, content: string, when: string): void {
  const abs = join(syncRepo, repoPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf-8");
  commitPaths([repoPath], when, `add ${repoPath}`);
}

beforeEach(() => {
  oldHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "memx-backfill-"));
  root = join(home, ".opencode");
  syncRepo = join(root, "memx-sync-repo");
  process.env.HOME = home;
  mkdirSync(join(root, "projects"), { recursive: true });
  spawnSync("git", ["init", "-q", syncRepo]);
  spawnSync("git", ["-C", syncRepo, "config", "user.email", "test@example.com"]);
  spawnSync("git", ["-C", syncRepo, "config", "user.name", "test"]);
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  rmSync(home, { recursive: true, force: true });
});

describe("backfill-created（issue #34）", () => {
  it("有 git 历史 → dry-run 只报数不写盘；真跑写入首次提交日期；幂等", async () => {
    // 引导提交：镜像首导（不含任何卡）
    commitRaw(".memx-mirror", '{"imported":"2026-10-13"}\n', "2026-10-13T09:00:00+08:00");

    const withHistory = writeCard("demo", "a.md", card("正文 A"));
    const alreadyHas = writeCard("demo", "b.md", card("正文 B", "2026-10-01"));
    const noHistory = writeCard("demo", "c.md", card("正文 C"));
    commitInto("projects/demo/.mem/a.md", "2026-09-01T10:00:00+08:00");

    const dry = await backfillCreated({ root, syncRepo, dryRun: true, log: () => {} });
    expect(dry.filled).toBe(1);
    expect(dry.already).toBe(1);
    expect(dry.unknown).toBe(1);
    expect(dry.unknownBootstrap).toBe(0);
    expect(dry.skipped).toBe(0);
    // dry-run 不写盘
    expect(readCreatedDate(readFileSync(withHistory, "utf-8"))).toBeNull();
    expect(readCreatedDate(readFileSync(noHistory, "utf-8"))).toBeNull();

    const run = await backfillCreated({ root, syncRepo, log: () => {} });
    expect(run.filled).toBe(1);
    expect(readCreatedDate(readFileSync(withHistory, "utf-8"))).toBe("2026-09-01");
    // 已有 created 不动
    expect(readCreatedDate(readFileSync(alreadyHas, "utf-8"))).toBe("2026-10-01");
    // 无历史保持未知（不猜）
    expect(readCreatedDate(readFileSync(noHistory, "utf-8"))).toBeNull();
    // 正文与其余 frontmatter 原样保留
    expect(readFileSync(withHistory, "utf-8")).toContain("正文 A");
    expect(readFileSync(withHistory, "utf-8")).toContain("updated: 2026-10-01");

    // 幂等：再跑一次不再回填
    const again = await backfillCreated({ root, syncRepo, log: () => {} });
    expect(again.filled).toBe(0);
    expect(readCreatedDate(readFileSync(withHistory, "utf-8"))).toBe("2026-09-01");
  });

  it("卡片随引导提交（镜像首导）进仓 → unknown，不写导入日", async () => {
    const imported = writeCard("legacy-proj", "old.md", card("老卡"));
    const later = writeCard("legacy-proj", "new.md", card("后来加的卡"));

    // 首导：老卡随镜像一起进根提交（与 2026-10-13 一次性导入同形）
    const abs = join(syncRepo, "projects/legacy-proj/.mem/old.md");
    mkdirSync(join(abs, ".."), { recursive: true });
    cpSync(imported, abs);
    const when = "2026-10-13T09:00:00+08:00";
    const env = { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when };
    spawnSync("git", ["-C", syncRepo, "add", "projects/legacy-proj/.mem/old.md"], { env });
    spawnSync("git", ["-C", syncRepo, "commit", "-q", "-m", "import mirror"], { env });

    // 引导提交之后才单独加入的卡 → 正常回填
    commitInto("projects/legacy-proj/.mem/new.md", "2026-09-20T10:00:00+08:00");

    const dry = await backfillCreated({ root, syncRepo, dryRun: true, log: () => {} });
    expect(dry.filled).toBe(1);
    expect(dry.unknown).toBe(1);
    expect(dry.unknownBootstrap).toBe(1);

    const run = await backfillCreated({ root, syncRepo, log: () => {} });
    expect(run.filled).toBe(1);
    // 随导入进仓的卡不写（10-13 是导入日，不是创建日）
    expect(readCreatedDate(readFileSync(imported, "utf-8"))).toBeNull();
    expect(readCreatedDate(readFileSync(later, "utf-8"))).toBe("2026-09-20");
  });

  it("projects/.mem 下的空 slug 遗留卡 → 被列出（计数可见）且不写盘", async () => {
    commitRaw(".memx-mirror", "{}\n", "2026-10-13T09:00:00+08:00");
    const normal = writeCard("demo", "ok.md", card("正常卡"));
    commitInto("projects/demo/.mem/ok.md", "2026-09-05T10:00:00+08:00");
    const legacy = writeLegacyCard("project_e2e_e4_memory.md", card("空 slug 遗留"));
    // 即便 git 里有它的记录也不写（slug "" 是哨兵，不是合法项目）
    commitInto("projects/.mem/project_e2e_e4_memory.md", "2026-09-05T10:00:00+08:00");

    const lines: string[] = [];
    const dry = await backfillCreated({ root, syncRepo, dryRun: true, log: (line) => lines.push(line) });
    expect(dry.skipped).toBe(1);
    expect(dry.filled).toBe(1);
    expect(dry.unknown).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("跳过 1");
    expect(out).toContain("空 slug 遗留");
    expect(out).toContain("projects/.mem/project_e2e_e4_memory.md");

    const run = await backfillCreated({ root, syncRepo, log: () => {} });
    expect(run.skipped).toBe(1);
    expect(readCreatedDate(readFileSync(legacy, "utf-8"))).toBeNull();
    expect(readCreatedDate(readFileSync(normal, "utf-8"))).toBe("2026-09-05");
    // 遗留卡没被挪走/改名
    expect(existsSync(legacy)).toBe(true);
  });

  it("引导提交与「从未提交」都归 unknown，但两者可区分", async () => {
    const imported = writeCard("p", "boot.md", card("导入卡"));
    const untracked = writeCard("p", "never.md", card("从未提交"));
    // boot.md 就是根提交 → 引导提交
    commitInto("projects/p/.mem/boot.md", "2026-10-13T09:00:00+08:00");

    const res = await backfillCreated({ root, syncRepo, dryRun: true, log: () => {} });
    expect(res.filled).toBe(0);
    expect(res.unknown).toBe(2);
    expect(res.unknownBootstrap).toBe(1);
    expect(readCreatedDate(readFileSync(imported, "utf-8"))).toBeNull();
    expect(readCreatedDate(readFileSync(untracked, "utf-8"))).toBeNull();
  });

  it("无 frontmatter 的卡 → 计 skippedNoFrontmatter、不计 filled，且文件逐字节不变", async () => {
    commitRaw(".memx-mirror", "{}\n", "2026-10-13T09:00:00+08:00");
    const normal = writeCard("demo", "ok.md", card("正常卡"));
    commitInto("projects/demo/.mem/ok.md", "2026-09-05T10:00:00+08:00");

    // 生产实测那张（2026-10-27）：首字符 `#`、全文无 `---`、CRLF 行尾。
    // patchCreatedDate() 对它必然返回 false —— 旧实现仍把它算进 filled（报 61 实际 60）。
    const raw = "# 项目恢复指派\r\n\r\n正文第一行\r\n第二行\r\n";
    const noFrontmatter = writeCard("homebase", "project_homebase_revoke_assignment.md", raw);
    commitInto("projects/homebase/.mem/project_homebase_revoke_assignment.md", "2026-09-06T10:00:00+08:00");

    const dryLines: string[] = [];
    const dry = await backfillCreated({
      root,
      syncRepo,
      dryRun: true,
      log: (line) => dryLines.push(line),
    });
    expect(dry.filled).toBe(1); // 只算真正能写的
    expect(dry.skipped).toBe(1);
    expect(dry.skippedNoFrontmatter).toBe(1);
    expect(dry.skippedWriteFailed).toBe(0);
    expect(dry.skippedLegacy).toBe(0);
    expect(dry.already).toBe(0);
    expect(dry.unknown).toBe(0);

    const dryOut = dryLines.join("\n");
    expect(dryOut).toContain("无 frontmatter 1");
    expect(dryOut).toContain("写失败 0");
    expect(dryOut).toContain("空 slug 遗留 0");
    // 明细带原因
    expect(dryOut).toContain("跳过 projects/homebase/.mem/project_homebase_revoke_assignment.md");
    expect(dryOut).toContain("无 frontmatter：首字符非 ---");
    // dry-run 不写盘
    expect(readFileSync(noFrontmatter)).toEqual(Buffer.from(raw, "utf-8"));

    const runLines: string[] = [];
    const run = await backfillCreated({ root, syncRepo, log: (line) => runLines.push(line) });
    expect(run.filled).toBe(1);
    expect(run.skipped).toBe(1);
    expect(run.skippedNoFrontmatter).toBe(1);
    expect(run.files).toEqual(["ok.md"]);
    // 真跑汇总行也要能看出跳过分类
    expect(runLines.join("\n")).toContain("已回填 1 / 已有 0 / 保留未知 0 / 跳过 1（无 frontmatter 1");

    // 逐字节不变：不加换行、不改 CRLF、不补 frontmatter
    expect(readFileSync(noFrontmatter)).toEqual(Buffer.from(raw, "utf-8"));
    expect(readCreatedDate(readFileSync(noFrontmatter, "utf-8"))).toBeNull();
    // 正常卡照旧回填
    expect(readCreatedDate(readFileSync(normal, "utf-8"))).toBe("2026-09-05");
  });
});

// ---- 推送（#34 收尾）：不 push 会被下一次 sync pull 覆盖 ----
// 生产事故：脚本直写盘（不经 memory_write）写完 62 张卡的 created，下一次 pull 按镜像全抹掉。
describe("backfill-created 的推送（--push）", () => {
  /** 造一张"可回填"的卡（git 里有引导提交之后的首次新增） */
  function seedWritable(created = false): string {
    commitRaw(".memx-mirror", "{}\n", "2026-10-13T09:00:00+08:00");
    const abs = writeCard("demo", "a.md", card("正文 A", created ? "2026-10-01" : undefined));
    commitInto("projects/demo/.mem/a.md", "2026-09-01T10:00:00+08:00");
    return abs;
  }

  function recorder(): { lines: string[]; log: (line: string) => void } {
    const lines: string[] = [];
    return { lines, log: (line) => lines.push(line) };
  }

  function fakePusher(summary?: BackfillPushSummary): { counter: { calls: number }; pusher: BackfillPusher } {
    const counter = { calls: 0 };
    const pusher: BackfillPusher = async () => {
      counter.calls += 1;
      return summary ?? { ok: true, kind: "pushed", message: "memx@test: 1 file +1 行", unsyncedCommits: 0 };
    };
    return { counter, pusher };
  }

  it("--push + 注入假 pusher → 调用一次，输出含推送结果；写入真实落盘", async () => {
    const abs = seedWritable();
    const { lines, log } = recorder();
    const fake = fakePusher();

    const res = await backfillCreated({ root, syncRepo, push: true, pusher: fake.pusher, log });

    expect(fake.counter.calls).toBe(1);
    expect(res.filled).toBe(1);
    expect(res.push?.ok).toBe(true);
    expect(res.push?.kind).toBe("pushed");
    // 写入与推送都发生了
    expect(readCreatedDate(readFileSync(abs, "utf-8"))).toBe("2026-09-01");
    const out = lines.join("\n");
    expect(out).toContain("推送成功");
    expect(out).toContain("memx@test: 1 file +1 行");
    expect(out).toContain("未推提交 0");
    // 推送了就不该再喊"会被覆盖"
    expect(out).not.toContain("⚠️");
  });

  it("不传 --push 且有写入 → 输出醒目警告（sync pull / 覆盖）", async () => {
    seedWritable();
    const { lines, log } = recorder();

    const res = await backfillCreated({ root, syncRepo, log });

    expect(res.filled).toBe(1);
    expect(res.push).toBeNull();
    const out = lines.join("\n");
    expect(out).toContain("⚠️");
    expect(out).toContain("没有推送");
    expect(out).toContain("sync pull");
    expect(out).toContain("覆盖");
    expect(out).toContain("--push");
  });

  it("--push 且 pusher 抛错 → exit 非 0、输出含手动指引，且不掩盖已写入", async () => {
    const abs = seedWritable();
    const { lines, log } = recorder();

    const { exitCode, result } = await runBackfillCli(["--push"], {
      root,
      syncRepo,
      pusher: async () => {
        throw new Error("network unreachable");
      },
      log,
    });

    expect(exitCode).toBe(1);
    // 写入事实不掩盖
    expect(result.filled).toBe(1);
    expect(readCreatedDate(readFileSync(abs, "utf-8"))).toBe("2026-09-01");
    const out = lines.join("\n");
    expect(out).toContain("写入已完成但推送失败");
    expect(out).toContain("network unreachable");
    expect(out).toContain("pnpm sync:op -- push --machine=<name>");
  });

  it("--push 且 pusher 返回失败（不抛） → 同样 exit 非 0 + 手动指引", async () => {
    seedWritable();
    const { lines, log } = recorder();

    const { exitCode, result } = await runBackfillCli(["--push"], {
      root,
      syncRepo,
      pusher: async () => ({ ok: false, kind: "pii-blocked", message: "PII 闸门拦截：2 处敏感信息命中" }),
      log,
    });

    expect(exitCode).toBe(1);
    expect(result.push?.ok).toBe(false);
    expect(result.push?.kind).toBe("pii-blocked");
    const out = lines.join("\n");
    expect(out).toContain("写入已完成但推送失败");
    expect(out).toContain("PII 闸门拦截");
    expect(out).toContain("pnpm sync:op -- push --machine=<name>");
  });

  it("sync 未启用（disabled）→ 不崩溃、exit 0，给配置指引而非故障", async () => {
    seedWritable();
    const { lines, log } = recorder();

    const { exitCode, result } = await runBackfillCli(["--push"], {
      root,
      syncRepo,
      pusher: async () => ({
        ok: false,
        kind: "disabled",
        disabled: true,
        message: "enabled=false machineName=(未设置)",
      }),
      log,
    });

    expect(exitCode).toBe(0);
    expect(result.push?.disabled).toBe(true);
    const out = lines.join("\n");
    expect(out).toContain("sync 未启用");
    expect(out).toContain("sync.enabled");
    expect(out).not.toContain("写入已完成但推送失败");
  });

  it("没有写入（filled=0）→ 不调用 pusher、不打印警告", async () => {
    seedWritable(true); // 已有 created → 无可回填
    const { lines, log } = recorder();
    const fake = fakePusher();

    const res = await backfillCreated({ root, syncRepo, push: true, pusher: fake.pusher, log });

    expect(res.filled).toBe(0);
    expect(fake.counter.calls).toBe(0);
    expect(res.push).toBeNull();
    const out = lines.join("\n");
    expect(out).not.toContain("⚠️");
    expect(out).not.toContain("推送");
  });

  it("--dry-run 不推送（即便传了 --push）", async () => {
    const abs = seedWritable();
    const { lines, log } = recorder();
    const fake = fakePusher();

    const res = await backfillCreated({
      root,
      syncRepo,
      dryRun: true,
      push: true,
      pusher: fake.pusher,
      log,
    });

    expect(res.filled).toBe(1); // 计划数
    expect(fake.counter.calls).toBe(0);
    expect(res.push).toBeNull();
    expect(readCreatedDate(readFileSync(abs, "utf-8"))).toBeNull();
    expect(lines.join("\n")).toContain("[dry-run] 未推送");
  });
});
