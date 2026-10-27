import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { backfillCreated } from "../scripts/backfill-created.ts";
import { readCreatedDate } from "../src/core/store/memory-md.ts";

// 独立 HOME：patchCreatedDate / 锁路径都经 homedir() 派生，测试绝不能碰真实 ~/.opencode
const home = mkdtempSync(join(tmpdir(), "memx-backfill-"));
const root = join(home, ".opencode");
const syncRepo = join(root, "memx-sync-repo");

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

function commitInto(repoPath: string, when: string): void {
  const abs = join(syncRepo, repoPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  cpSync(join(root, repoPath), abs);
  const env = { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when };
  spawnSync("git", ["-C", syncRepo, "add", repoPath], { env });
  spawnSync("git", ["-C", syncRepo, "commit", "-m", `add ${repoPath}`], { env });
}

let oldHome: string | undefined;

beforeAll(() => {
  oldHome = process.env.HOME;
  process.env.HOME = home;
  mkdirSync(join(root, "projects"), { recursive: true });
  spawnSync("git", ["init", "-q", syncRepo]);
  spawnSync("git", ["-C", syncRepo, "config", "user.email", "test@example.com"]);
  spawnSync("git", ["-C", syncRepo, "config", "user.name", "test"]);
});

afterAll(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  rmSync(home, { recursive: true, force: true });
});

describe("backfill-created（issue #34）", () => {
  it("有 git 历史 → dry-run 只报数不写盘；真跑写入首次提交日期；幂等", async () => {
    const withHistory = writeCard("demo", "a.md", card("正文 A"));
    const alreadyHas = writeCard("demo", "b.md", card("正文 B", "2026-10-01"));
    const noHistory = writeCard("demo", "c.md", card("正文 C"));
    commitInto("projects/demo/.mem/a.md", "2026-09-01T10:00:00+08:00");

    const dry = await backfillCreated({ root, syncRepo, dryRun: true, log: () => {} });
    expect(dry.filled).toBe(1);
    expect(dry.already).toBe(1);
    expect(dry.unknown).toBe(1);
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
});
