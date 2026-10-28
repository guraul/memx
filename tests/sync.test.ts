import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import {
  createSync,
  createNodeGitRunner,
  readSyncState,
  remoteUrl,
  scanSensitive,
  PII_BLOCK_RULES,
  listToSync,
  listPendingDeletions,
  isSyncRepoPath,
  buildDryRunReport,
  syncLockPath,
  type GitRunner,
} from "../src/core/sync.ts";
import { withFileLock } from "../src/core/store/lock.ts";
import { createFileAlertStore, type AlertStore } from "../src/core/alerts.ts";
import { MemxConfigSchema } from "../src/core/config.ts";

const TEST_HOME = vi.hoisted(() => `/tmp/opencode-memx-sync-test-home-${process.pid}`);

// #35：真实 git 端到端用例要连开十几个 `git` 子进程，单跑约 2–4s；4 进程并发（CI 低配机同理）
// CPU 抢满后会顶穿 vitest 默认 5s 的 testTimeout——那是负载导致的假红，不是逻辑失败。
// 与 tests/scripts-smoke.test.ts 同样处理：只放大本文件，其它文件保持 5s，真卡死仍会暴露。
vi.setConfig({ testTimeout: 30_000 });

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => TEST_HOME };
});

const HOME = TEST_HOME;
const OPENCODE = join(HOME, ".opencode");

beforeAll(() => {
  mkdirSync(OPENCODE, { recursive: true });
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

function writeMemoryFile(relPath: string, content: string): void {
  const full = join(OPENCODE, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf-8");
}

function makeAlerts(name: string): AlertStore {
  return createFileAlertStore({ path: join(HOME, `alerts-${name}.json`) });
}

const SYNC_CONFIG = { enabled: true, repo: "guraul/memx-sync", branch: "main", machineName: "mbp", intervalMinutes: 30 };

/** 脚本化假 runner：记录全部命令，按 responder 返回响应 */
class FakeRunner implements GitRunner {
  calls: string[][] = [];
  constructor(private responder: (cmd: string[]) => { ok: boolean; stdout: string; stderr: string; reason?: string }) {}
  exec(cmd: string[], _cwd: string): { ok: boolean; stdout: string; stderr: string; reason?: string } {
    this.calls.push([...cmd]);
    return this.responder(cmd);
  }
  called(substr: string): boolean {
    return this.calls.some((c) => c.join(" ").includes(substr));
  }
  count(substr: string): number {
    return this.calls.filter((c) => c.join(" ").includes(substr)).length;
  }
}

/** push 成功路径的标准响应：workdir 有改动 → add → numstat → commit → push 全过 */
const pushOkResponder = (cmd: string[]) => {
  const j = cmd.join(" ");
  if (j.includes("status --porcelain")) return { ok: true, stdout: " M USER.md\n", stderr: "" };
  if (j.includes("diff --cached --numstat")) return { ok: true, stdout: "1\t0\tUSER.md\n", stderr: "" };
  return { ok: true, stdout: "", stderr: "" };
};

/** 默认「无未推提交」：issue #12 起 push 会先数 `git rev-list --count @{u}..HEAD`，
 *  假 runner 的裸兜底返回 "" 会让它判成"未知"→ fail-open 走完整流程。想让"真无变化"短路成立
 *  的测试用这个 responder 打底，再叠自己的分支。 */
const noUnsyncedResponder = (cmd: string[]) => {
  const j = cmd.join(" ");
  if (j.includes("rev-list --count")) return { ok: true, stdout: "0\n", stderr: "" };
  if (j.includes("status --porcelain")) return { ok: true, stdout: "", stderr: "" };
  return { ok: true, stdout: "", stderr: "" };
};

function makeSync(runner: FakeRunner, name: string, workdir?: string, config = SYNC_CONFIG) {
  return createSync({
    config,
    alerts: makeAlerts(name),
    runner,
    workdir: workdir ?? join(HOME, `workdir-${name}`),
    statePath: join(HOME, `state-${name}.json`),
  });
}

/** 直接落一份状态文件（模拟"上次 pull 留下的状态"）；statePath 与 makeSync 的约定一致 */
function writeStateFile(name: string, state: Record<string, unknown>): string {
  const path = join(HOME, `state-${name}.json`);
  writeFileSync(path, JSON.stringify(state, null, 2), "utf-8");
  return path;
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
/** 上次 pull 成功的状态底稿：想看短路就必须先满足"有 sha + 无失败" */
const okState = (sha: string | null) => ({
  lastPushAt: null,
  lastPullAt: "2026-01-01T00:00:00.000Z",
  lastError: "",
  consecutiveFailures: 0,
  lastPiiScan: null,
  lastRemoteSha: sha,
});

describe("scanSensitive", () => {
  it("正例：8 类规则各命中一次，只报行号+规则名", () => {
    const text = [
      "openai: sk-abc123XYZ7890abcdefg",
      "aws: AKIAIOSFODNN7EXAMPLE",
      "gh: ghp_12345678901234567890",
      "pat: github_pat_ABCDEFGHIJ1234567890",
      "slack: xoxb-abcdefghij1234",
      "jwt: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c",
      "-----BEGIN RSA PRIVATE KEY-----",
      "GITHUB_TOKEN=ghp_12345678901234567890",
    ].join("\n");
    const hits = scanSensitive(text);
    const byLine = new Map(hits.map((h) => [h.line, h.pattern]));
    expect(byLine.get(1)).toBe("openai-key");
    expect(byLine.get(2)).toBe("aws-access-key");
    expect(byLine.get(3)).toBe("github-token");
    expect(byLine.get(4)).toBe("github-pat");
    expect(byLine.get(5)).toBe("slack-token");
    expect(byLine.get(6)).toBe("jwt");
    expect(byLine.get(7)).toBe("private-key");
    expect(byLine.get(8)).toBe("env-assignment");
  });

  it("反例：中文记忆/普通 URL/日期/文件路径/孤立关键字不得误报", () => {
    const text = [
      "用户偏好：包管理器只用 pnpm，禁止 npm / yarn / bun",
      "参考文档 https://docs.expo.dev/versions/v57.0.0/",
      "2026-10-13 的会话记录显示捕获正常",
      "路径 /Users/gubin/workspace/agent-mobile 是工作目录",
      "TOKEN 不要写进文件，API_KEY 同理",
      "sk-tooshort 不是合法 key",
    ].join("\n");
    expect(scanSensitive(text)).toEqual([]);
  });

  // issue #10 回归：旧规则 /sk-[A-Za-z0-9_-]{10,}/ 无词边界，把中段的 `sk-` 当 key，
  // 现场就是这两类记忆名（`task-spec-*` / `risk-*`）把整机同步 fail-closed 锁死一天。
  it("issue #10 反例：词中段 sk-（task-spec-* / risk-*）不得命中 openai-key", () => {
    const lines = [
      "name: task-spec-branch-name-verify",
      "- [task-spec-branch-name-verify](~/.opencode/projects/x/.mem/y.md) - 说明",
      "risk-management-foo 是风险描述，不是密钥",
      "disk-usage-report-for-machine-a 同理",
      "flask-workshop-notes-index-entry",
      "sk-spec-branch-name-verify", // 词首但 `sk-` 后仍是连字符词组、长度也不足 → 不再当 key
      "sk-short",
      "sk-abc123XYZ7890abcd", // 18 位 < 20：旧规则拦、新规则不拦（既有反例语义）
    ];
    expect(scanSensitive(lines.join("\n"))).toEqual([]);
  });

  it("issue #10 正例：真 key 形态（sk-proj- / sk-ant- / 经典 sk- + ≥20 位）仍必须命中", () => {
    const lines = [
      "openai key: sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
      "anthropic: sk-ant-api03-abcdefghijklmnopqrstuvwxyz-AAA",
      "sk-abc123XYZ7890abcdefg",
      "- sk-ant-abcdefghijklmnopqrstuvwxyz",
    ];
    const hits = scanSensitive(lines.join("\n"));
    expect(hits.map((h) => [h.line, h.pattern])).toEqual([
      [1, "openai-key"],
      [2, "openai-key"],
      [3, "openai-key"],
      [4, "openai-key"],
    ]);
  });

  it("命中只含 pattern+line+tier 三个字段，绝不回显内容", () => {
    const hits = scanSensitive("aws: AKIAIOSFODNN7EXAMPLE\n");
    expect(hits).toHaveLength(1);
    expect(Object.keys(hits[0]!).sort()).toEqual(["line", "pattern", "tier"]);
    expect(JSON.stringify(hits)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});

describe("PII 规则分层（issue #33）", () => {
  it("block 层冻结为现有 8 条，且全部 tier=block", () => {
    expect(PII_BLOCK_RULES.map((r) => r.pattern)).toEqual([
      "openai-key",
      "aws-access-key",
      "github-token",
      "github-pat",
      "slack-token",
      "jwt",
      "private-key",
      "env-assignment",
    ]);
    expect(PII_BLOCK_RULES.every((r) => r.tier === "block")).toBe(true);
  });

  it("alert 层：语义型密码陈述命中，tier=alert（不阻断）", () => {
    const text = ["我的密码是 abc123", "password is hunter2", "密码：hunter2"].join("\n");
    expect(scanSensitive(text)).toEqual([
      { pattern: "password-statement", line: 1, tier: "alert" },
      { pattern: "password-statement", line: 2, tier: "alert" },
      { pattern: "password-statement", line: 3, tier: "alert" },
    ]);
  });

  it("alert 层不把普通讨论当命中（密码管理器 / password is required）", () => {
    const text = ["密码管理器很好用", "password is required", "口令长度至少 12 位"].join("\n");
    expect(scanSensitive(text)).toEqual([]);
  });
});

describe("同步状态向后兼容（issue #33 新字段）", () => {
  it("旧 lastPiiScan 无分层字段 → blocked=hits / alerted=0 / alertHits=[]；piiAlertLog 缺省为空", () => {
    const path = writeStateFile("pii-legacy", {
      lastPushAt: null,
      lastPullAt: null,
      lastError: "",
      consecutiveFailures: 0,
      lastPiiScan: { at: "2026-01-01T00:00:00.000Z", files: 2, hits: 3 },
      lastRemoteSha: null,
    });
    const state = readSyncState(path);
    expect(state?.lastPiiScan).toEqual({
      at: "2026-01-01T00:00:00.000Z",
      files: 2,
      hits: 3,
      blocked: 3,
      alerted: 0,
      alertHits: [],
    });
    expect(state?.piiAlertLog).toEqual([]);
  });
});

describe("config 默认值", () => {
  it("sync 默认关，字段齐全", () => {
    const config = MemxConfigSchema.parse({});
    expect(config.sync).toEqual({
      enabled: false,
      repo: "guraul/memx-sync",
      branch: "main",
      machineName: "",
      intervalMinutes: 30,
    });
  });

  it("空 sync 对象 → 同样落到全默认（部分字段缺失不炸）", () => {
    const config = MemxConfigSchema.parse({ sync: {} });
    expect(config.sync.enabled).toBe(false);
    expect(config.sync.intervalMinutes).toBe(30);
  });
});

describe("listToSync", () => {
  it("排除 .trash/ 与 .bak.*，跳过不存在的文件", () => {
    writeMemoryFile("USER.md", "u");
    writeMemoryFile("MEMORY.md", "m");
    writeMemoryFile("projects/foo/.mem/a.md", "a");
    writeMemoryFile("projects/foo/.mem/.trash/b.md", "trash");
    writeMemoryFile("projects/foo/.mem/c.md.bak.20260101", "bak");
    writeMemoryFile("projects/foo/.mem/sub/d.md", "sub");
    const files = listToSync().map((f) => f.repoPath);
    expect(files).toContain("USER.md");
    expect(files).toContain("MEMORY.md");
    expect(files).toContain("projects/foo/.mem/a.md");
    expect(files).toContain("projects/foo/.mem/sub/d.md");
    expect(files.some((f) => f.includes(".trash"))).toBe(false);
    expect(files.some((f) => f.includes(".bak."))).toBe(false);
  });
});

describe("createSync 启停", () => {
  it("enabled=false / machineName 空 → 不启动（push/pull 零 git 命令）", async () => {
    for (const config of [
      { ...SYNC_CONFIG, enabled: false },
      { ...SYNC_CONFIG, machineName: "" },
    ]) {
      const runner = new FakeRunner(() => ({ ok: true, stdout: "", stderr: "" }));
      const sync = makeSync(runner, `disabled-${config.enabled}-${config.machineName}`, undefined, config);
      const pushResult = await sync.push();
      const pullResult = await sync.pull();
      expect(pushResult.ok).toBe(false);
      expect(pullResult.ok).toBe(false);
      expect(runner.calls).toHaveLength(0);
    }
  });
});

describe("push", () => {
  it("命中 PII → 拒推（fake runner 零命令）+ critical alert，不回显内容", async () => {
    writeMemoryFile("USER.md", "my key is sk-abc123XYZ7890abcdefg\n");
    const runner = new FakeRunner(() => ({ ok: true, stdout: "", stderr: "" }));
    const alerts = makeAlerts("pii");
    const sync = createSync({
      config: SYNC_CONFIG,
      alerts,
      runner,
      workdir: join(HOME, "workdir-pii"),
      statePath: join(HOME, "state-pii.json"),
    });
    const result = await sync.push();
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("pii-blocked");
    expect(runner.calls).toHaveLength(0);
    const list = alerts.list();
    expect(list.some((a) => a.code === "SYNC_PII_BLOCKED" && a.level === "critical")).toBe(true);
    expect(JSON.stringify(list)).not.toContain("sk-abc123XYZ7890abcdefg");
  });

  it("alert 层命中 → 照推 + 持久留痕，不回显内容（issue #33）", async () => {
    writeMemoryFile("USER.md", "我的密码是 abc123\n");
    const runner = new FakeRunner(pushOkResponder);
    const alerts = makeAlerts("piialert");
    const statePath = join(HOME, "state-pii-alert.json");
    const sync = createSync({
      config: SYNC_CONFIG,
      alerts,
      runner,
      workdir: join(HOME, "workdir-pii-alert"),
      statePath,
    });
    const result = await sync.push();
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("pushed");
    // alert 层不阻断：git push 照常发生
    expect(runner.called("push origin main")).toBe(true);
    // 即时提醒（会随 AlertStore 7 天剪龄消失，所以不能只靠它）
    expect(alerts.list().some((a) => a.code === "SYNC_PII_ALERTED" && a.level === "warn")).toBe(true);
    // 持久管道：状态文件里的 lastPiiScan + piiAlertLog（append-only，不剪龄）
    const state = readSyncState(statePath);
    expect(state?.lastPiiScan).toMatchObject({ hits: 1, blocked: 0, alerted: 1 });
    expect(state?.lastPiiScan?.alertHits).toEqual([{ file: "USER.md", pattern: "password-statement", line: 1 }]);
    expect(state?.piiAlertLog).toHaveLength(1);
    expect(state?.piiAlertLog[0]).toMatchObject({ file: "USER.md", pattern: "password-statement", line: 1 });
    expect(JSON.stringify(state)).not.toContain("abc123");
  });

  it("block + alert 同时命中 → block 优先拒推，alert 命中仍留痕（issue #33）", async () => {
    writeMemoryFile("USER.md", "my key sk-abc123XYZ7890abcdefg\n我的密码是 abc123\n");
    const runner = new FakeRunner(() => ({ ok: true, stdout: "", stderr: "" }));
    const alerts = makeAlerts("piialertblock");
    const statePath = join(HOME, "state-pii-alert-block.json");
    const sync = createSync({
      config: SYNC_CONFIG,
      alerts,
      runner,
      workdir: join(HOME, "workdir-pii-alert-block"),
      statePath,
    });
    const result = await sync.push();
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("pii-blocked");
    // block 层仍是一票否决：一个 git 命令都不发
    expect(runner.calls).toHaveLength(0);
    const state = readSyncState(statePath);
    expect(state?.lastPiiScan).toMatchObject({ hits: 2, blocked: 1, alerted: 1 });
    // 即使本次被 block 拒推，alert 命中也已经落持久留痕
    expect(state?.piiAlertLog).toHaveLength(1);
    expect(JSON.stringify(state)).not.toContain("sk-abc123XYZ7890abcdefg");
  });

  it("非快进 → fetch + rebase + 重试一次（命令序列与顺序）", async () => {
    writeMemoryFile("USER.md", "line1\nline2\n");
    const workdir = join(HOME, "workdir-retry");
    mkdirSync(join(workdir, ".git"), { recursive: true });
    let pushCount = 0;
    const runner = new FakeRunner((cmd) => {
      const j = cmd.join(" ");
      if (j.includes("status --porcelain")) return { ok: true, stdout: " M USER.md\n", stderr: "" };
      if (j.includes("diff --cached --numstat")) return { ok: true, stdout: "1\t0\tUSER.md\n", stderr: "" };
      if (j.includes("push")) {
        pushCount++;
        return pushCount === 1 ? { ok: false, stdout: "", stderr: "non-fast-forward" } : { ok: true, stdout: "", stderr: "" };
      }
      return { ok: true, stdout: "", stderr: "" };
    });
    const sync = makeSync(runner, "retry", workdir);
    const result = await sync.push();
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("pushed");
    expect(runner.count("push")).toBe(2);
    const seq = runner.calls.map((c) => c.join(" "));
    const firstPush = seq.findIndex((s) => s.includes("push"));
    const fetch = seq.findIndex((s) => s.includes("fetch"));
    const rebase = seq.findIndex((s) => s.includes("rebase"));
    const secondPush = seq.findIndex((s, i) => i > firstPush && s.includes("push"));
    expect(firstPush).toBeGreaterThanOrEqual(0);
    expect(fetch).toBeGreaterThan(firstPush);
    expect(rebase).toBeGreaterThan(fetch);
    expect(secondPush).toBeGreaterThan(rebase);
    // rebase 必须带兜底身份：无身份环境下 rebase 重放提交缺 committer 会直接失败（被误报成冲突）
    expect(seq[rebase]).toContain("-c user.name=memx-sync -c user.email=memx@localhost rebase");
  });

  it("重试仍失败 → SYNC_PUSH_FAILED warn alert + consecutiveFailures 累加", async () => {
    writeMemoryFile("USER.md", "x\n");
    const workdir = join(HOME, "workdir-pushfail");
    mkdirSync(join(workdir, ".git"), { recursive: true });
    const runner = new FakeRunner((cmd) => {
      const j = cmd.join(" ");
      if (j.includes("status --porcelain")) return { ok: true, stdout: " M USER.md\n", stderr: "" };
      if (j.includes("diff --cached --numstat")) return { ok: true, stdout: "1\t0\tUSER.md\n", stderr: "" };
      if (j.includes("push")) return { ok: false, stdout: "", stderr: "rejected" };
      return { ok: true, stdout: "", stderr: "" };
    });
    const alerts = makeAlerts("pushfail");
    const sync = createSync({
      config: SYNC_CONFIG,
      alerts,
      runner,
      workdir,
      statePath: join(HOME, "state-pushfail.json"),
    });
    const result = await sync.push();
    expect(result.ok).toBe(false);
    expect(alerts.list().some((a) => a.code === "SYNC_PUSH_FAILED" && a.level === "warn")).toBe(true);
    expect(sync.status().consecutiveFailures).toBe(1);
  });

  it("无改动（无文件差异 + 无未推提交）→ 不 commit 不 push", async () => {
    writeMemoryFile("USER.md", "same\n");
    const workdir = join(HOME, "workdir-nochange");
    mkdirSync(join(workdir, ".git"), { recursive: true });
    writeFileSync(join(workdir, "USER.md"), "same\n", "utf-8");
    const runner = new FakeRunner(noUnsyncedResponder);
    const sync = makeSync(runner, "nochange", workdir);
    const result = await sync.push();
    expect(result.kind).toBe("no-change");
    expect(runner.called("rev-list --count")).toBe(true); // issue #12：无条件先数未推提交
    expect(runner.called("commit")).toBe(false);
    expect(runner.called("push")).toBe(false);
  });

  it("issue #12：无文件差异但有未推提交 → 不 commit 空提交，仍执行 git push 把积压送出去", async () => {
    writeMemoryFile("USER.md", "same\n");
    const workdir = join(HOME, "workdir-unsynced");
    mkdirSync(join(workdir, ".git"), { recursive: true });
    writeFileSync(join(workdir, "USER.md"), "same\n", "utf-8"); // 与本地一致 = 无文件差异
    const runner = new FakeRunner((cmd) => {
      const j = cmd.join(" ");
      if (j.includes("rev-list --count")) return { ok: true, stdout: "2\n", stderr: "" }; // 断网期攒的 2 个
      if (j.includes("status --porcelain")) return { ok: true, stdout: "", stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    });
    const sync = makeSync(runner, "unsynced", workdir);
    const result = await sync.push();
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("pushed"); // 旧行为此处是 no-change，提交永远滞留
    expect(result.message).toContain("补推 2 个未推提交");
    expect(runner.called("push")).toBe(true);
    expect(runner.called("commit")).toBe(false); // 无新差异，不造空提交
    expect(runner.called("add -A")).toBe(false);
  });

  it("issue #12：有文件差异时照旧 add/commit/push，不因未推提交数而改变", async () => {
    writeMemoryFile("USER.md", "line1\n");
    const workdir = join(HOME, "workdir-unsynced-plus");
    mkdirSync(join(workdir, ".git"), { recursive: true });
    const runner = new FakeRunner((cmd) => {
      const j = cmd.join(" ");
      if (j.includes("rev-list --count")) return { ok: true, stdout: "1\n", stderr: "" };
      return pushOkResponder(cmd);
    });
    const sync = makeSync(runner, "unsynced-plus", workdir);
    const result = await sync.push();
    expect(result.ok).toBe(true);
    expect(result.message).toBe("memx@mbp: USER.md +1 行");
    expect(runner.called("commit -m memx@mbp: USER.md +1 行")).toBe(true);
    expect(runner.called("push origin main")).toBe(true);
  });

  it("issue #12：未推提交数不可知（无上游 / 输出不可解析）→ fail-open，不据此短路成无积压", async () => {
    writeMemoryFile("USER.md", "same\n");
    const workdir = join(HOME, "workdir-unsynced-unknown");
    mkdirSync(join(workdir, ".git"), { recursive: true });
    writeFileSync(join(workdir, "USER.md"), "same\n", "utf-8");
    const runner = new FakeRunner((cmd) => {
      const j = cmd.join(" ");
      if (j.includes("rev-list --count")) return { ok: false, stdout: "", stderr: "fatal: no upstream" };
      if (j.includes("status --porcelain")) return { ok: true, stdout: "", stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    });
    const sync = makeSync(runner, "unsynced-unknown", workdir);
    const result = await sync.push();
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("pushed");
    expect(runner.called("push origin main")).toBe(true);
  });

  it("成功 → commit message 形如 memx@mbp: USER.md +1 行，status 更新", async () => {
    writeMemoryFile("USER.md", "line1\nline2\n");
    const workdir = join(HOME, "workdir-ok");
    mkdirSync(join(workdir, ".git"), { recursive: true });
    const runner = new FakeRunner(pushOkResponder);
    const sync = makeSync(runner, "ok", workdir);
    const result = await sync.push();
    expect(result.ok).toBe(true);
    expect(result.message).toBe("memx@mbp: USER.md +1 行");
    expect(runner.called("commit -m memx@mbp: USER.md +1 行")).toBe(true);
    const st = sync.status();
    expect(st.lastPushAt).not.toBeNull();
    expect(st.consecutiveFailures).toBe(0);
    expect(st.unsyncedCommits).toBe(0); // 推成功后归零（#12 可观测字段）
  });
});

describe("pull", () => {
  it("冲突 → rebase --abort + critical alert，不强行解冲突", async () => {
    const workdir = join(HOME, "workdir-conflict");
    mkdirSync(join(workdir, ".git"), { recursive: true });
    const runner = new FakeRunner((cmd) => {
      const j = cmd.join(" ");
      if (j.includes("rebase origin/main") && !j.includes("--abort")) {
        return { ok: false, stdout: "", stderr: "CONFLICT (content)" };
      }
      return { ok: true, stdout: "", stderr: "" };
    });
    const alerts = makeAlerts("conflict");
    const sync = createSync({
      config: SYNC_CONFIG,
      alerts,
      runner,
      workdir,
      statePath: join(HOME, "state-conflict.json"),
    });
    const result = await sync.pull();
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("conflict");
    expect(runner.called("rebase --abort")).toBe(true);
    expect(alerts.list().some((a) => a.code === "SYNC_CONFLICT" && a.level === "critical")).toBe(true);
  });

  it("成功 → 从 workdir 镜像回本地", async () => {
    const workdir = join(HOME, "workdir-pull");
    mkdirSync(join(workdir, ".git"), { recursive: true });
    writeMemoryFile("USER.md", "local\n");
    mkdirSync(join(workdir, "projects", "bar", ".mem"), { recursive: true });
    writeFileSync(join(workdir, "MEMORY.md"), "remote index\n", "utf-8");
    writeFileSync(join(workdir, "projects", "bar", ".mem", "x.md"), "remote mem\n", "utf-8");
    const runner = new FakeRunner(() => ({ ok: true, stdout: "", stderr: "" }));
    const sync = makeSync(runner, "pull", workdir);
    const result = await sync.pull();
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("pulled");
    expect(readFileSync(join(OPENCODE, "MEMORY.md"), "utf-8")).toBe("remote index\n");
    expect(readFileSync(join(OPENCODE, "projects", "bar", ".mem", "x.md"), "utf-8")).toBe("remote mem\n");
    expect(sync.status().lastPullAt).not.toBeNull();
  });
});

describe("远端无变化前置短路（省夜里空转）", () => {
  it("a) 远端 sha 未变 + 上次成功 → 跳过：零 fetch/rebase/rev-parse，只刷 lastPullAt 不销账", async () => {
    const workdir = join(HOME, "workdir-skip");
    mkdirSync(join(workdir, ".git"), { recursive: true });
    const before = "2026-01-01T00:00:00.000Z";
    const statePath = writeStateFile("skip", okState(SHA_A));
    const runner = new FakeRunner((cmd) =>
      cmd.join(" ").includes("ls-remote")
        ? { ok: true, stdout: `${SHA_A}\trefs/heads/main\n`, stderr: "" }
        : { ok: true, stdout: "", stderr: "" },
    );
    const alerts = makeAlerts("skip");
    alerts.append({ level: "warn", code: "SYNC_ERROR", message: "旧账", ts: before });
    const sync = createSync({ config: SYNC_CONFIG, alerts, runner, workdir, statePath });

    const result = await sync.pull();

    expect(result.ok).toBe(true);
    expect(result.kind).toBe("no-change");
    expect(result.message).toContain("远端无新提交，跳过拉取");
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.join(" ")).toContain("ls-remote");
    expect(runner.count("fetch")).toBe(0);
    expect(runner.count("rebase")).toBe(0);
    expect(runner.count("rev-parse")).toBe(0);
    expect(sync.status().lastPullAt).not.toBe(before);
    // 跳过不是一次真拉取 → 旧账不销、sha 记忆保留（下次还能短路）
    expect(alerts.list().some((a) => a.code === "SYNC_ERROR")).toBe(true);
    const state = readSyncState(statePath);
    expect(state?.lastRemoteSha).toBe(SHA_A);
    expect(state?.lastPullAt).not.toBe(before);
  });

  it("b) 远端 sha 变了 → 完整流程（fetch/rebase/镜像）并把新 sha 写回状态", async () => {
    const workdir = join(HOME, "workdir-skip-changed");
    mkdirSync(join(workdir, ".git"), { recursive: true });
    writeFileSync(join(workdir, "MEMORY.md"), "remote v2\n", "utf-8");
    writeMemoryFile("MEMORY.md", "local v1\n");
    const statePath = writeStateFile("skip-changed", okState(SHA_A));
    const runner = new FakeRunner((cmd) => {
      const j = cmd.join(" ");
      if (j.includes("ls-remote")) return { ok: true, stdout: `${SHA_B}\trefs/heads/main\n`, stderr: "" };
      if (j.includes("rev-parse")) return { ok: true, stdout: `${SHA_B}\n`, stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    });
    const sync = makeSync(runner, "skip-changed", workdir);

    const result = await sync.pull();

    expect(result.ok).toBe(true);
    expect(result.kind).toBe("pulled");
    expect(runner.called("fetch origin main")).toBe(true);
    expect(runner.called("rebase origin/main")).toBe(true);
    // pull 路径的 rebase 同样必须带身份（prod 上 workdir 是新 clone，没有 git 身份）
    expect(runner.calls.find((c) => c.join(" ").includes("rebase origin/main"))!.join(" ")).toContain(
      "-c user.name=memx-sync -c user.email=memx@localhost rebase origin/main",
    );
    expect(readFileSync(join(OPENCODE, "MEMORY.md"), "utf-8")).toBe("remote v2\n");
    expect(readSyncState(statePath)?.lastRemoteSha).toBe(SHA_B);
  });

  it("c) 无 lastRemoteSha（旧状态文件）→ 不探 ls-remote，直接完整流程", async () => {
    const workdir = join(HOME, "workdir-skip-nosha");
    mkdirSync(join(workdir, ".git"), { recursive: true });
    // 旧版写出来的状态文件：没有 lastRemoteSha 字段
    const statePath = writeStateFile("skip-nosha", {
      lastPushAt: null,
      lastPullAt: "2026-01-01T00:00:00.000Z",
      lastError: "",
      consecutiveFailures: 0,
      lastPiiScan: null,
    });
    expect(readSyncState(statePath)?.lastRemoteSha).toBeNull();
    const runner = new FakeRunner((cmd) =>
      cmd.join(" ").includes("rev-parse") ? { ok: true, stdout: `${SHA_A}\n`, stderr: "" } : { ok: true, stdout: "", stderr: "" },
    );
    const sync = makeSync(runner, "skip-nosha", workdir);

    const result = await sync.pull();

    expect(result.ok).toBe(true);
    expect(result.kind).toBe("pulled");
    expect(runner.called("ls-remote")).toBe(false);
    expect(runner.called("fetch origin main")).toBe(true);
    expect(readSyncState(statePath)?.lastRemoteSha).toBe(SHA_A);
  });

  it("d) force:true → 即使 sha 未变也走完整流程（连 ls-remote 都不探）", async () => {
    const workdir = join(HOME, "workdir-skip-force");
    mkdirSync(join(workdir, ".git"), { recursive: true });
    writeStateFile("skip-force", okState(SHA_A));
    const runner = new FakeRunner((cmd) => {
      const j = cmd.join(" ");
      if (j.includes("ls-remote")) return { ok: true, stdout: `${SHA_A}\trefs/heads/main\n`, stderr: "" };
      if (j.includes("rev-parse")) return { ok: true, stdout: `${SHA_A}\n`, stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    });
    const sync = makeSync(runner, "skip-force", workdir);

    const result = await sync.pull({ force: true });

    expect(result.ok).toBe(true);
    expect(result.kind).toBe("pulled");
    expect(runner.called("ls-remote")).toBe(false);
    expect(runner.called("fetch origin main")).toBe(true);
    expect(runner.called("rebase origin/main")).toBe(true);
  });

  it("e) 上次 pull 失败（lastError 非空 / consecutiveFailures>0）→ 不短路，走完整流程", async () => {
    const variants = [
      { name: "skip-failerr", state: { ...okState(SHA_A), lastError: "fetch 失败：Could not resolve host" } },
      { name: "skip-failcount", state: { ...okState(SHA_A), consecutiveFailures: 2 } },
    ];
    for (const v of variants) {
      const workdir = join(HOME, `workdir-${v.name}`);
      mkdirSync(join(workdir, ".git"), { recursive: true });
      writeStateFile(v.name, v.state);
      const runner = new FakeRunner((cmd) =>
        cmd.join(" ").includes("ls-remote")
          ? { ok: true, stdout: `${SHA_A}\trefs/heads/main\n`, stderr: "" }
          : { ok: true, stdout: "", stderr: "" },
      );
      const sync = makeSync(runner, v.name, workdir);

      const result = await sync.pull();

      expect(result.ok).toBe(true);
      expect(result.kind).toBe("pulled");
      expect(runner.called("fetch origin main")).toBe(true);
      expect(runner.called("ls-remote")).toBe(false);
    }
  });

  it("f) ls-remote 失败 → fail-open：回落完整流程并成功", async () => {
    const workdir = join(HOME, "workdir-skip-failopen");
    mkdirSync(join(workdir, ".git"), { recursive: true });
    const statePath = writeStateFile("skip-failopen", okState(SHA_A));
    const runner = new FakeRunner((cmd) => {
      const j = cmd.join(" ");
      if (j.includes("ls-remote")) return { ok: false, stdout: "", stderr: "Could not resolve host: github.com", reason: "exit 128" };
      if (j.includes("rev-parse")) return { ok: true, stdout: `${SHA_A}\n`, stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    });
    const sync = makeSync(runner, "skip-failopen", workdir);

    const result = await sync.pull();

    expect(result.ok).toBe(true);
    expect(result.kind).toBe("pulled");
    expect(runner.called("fetch origin main")).toBe(true);
    expect(readSyncState(statePath)?.lastRemoteSha).toBe(SHA_A);
    expect(sync.status().lastError).toBe("");
  });
});

describe("dryRun", () => {
  it("workdir 不存在 → 只读报告，零 git 命令", () => {
    writeMemoryFile("USER.md", "clean content\n");
    const runner = new FakeRunner(() => ({ ok: true, stdout: "", stderr: "" }));
    const report = buildDryRunReport({
      config: SYNC_CONFIG,
      runner,
      workdir: join(HOME, "workdir-dryrun-missing"),
    });
    expect(report.workdirExists).toBe(false);
    expect(report.files.map((f) => f.repoPath)).toContain("USER.md");
    expect(report.files.every((f) => f.added === null)).toBe(true);
    expect(report.piiHits).toEqual([]);
    expect(report.remoteLog).toEqual([]);
    expect(runner.calls).toHaveLength(0);
  });

  it("命中 PII → 列文件+行号+规则名，不回显内容", () => {
    writeMemoryFile("USER.md", "key: AKIAIOSFODNN7EXAMPLE\n");
    const workdir = join(HOME, "workdir-dryrun-pii");
    mkdirSync(workdir, { recursive: true });
    const report = buildDryRunReport({ config: SYNC_CONFIG, workdir });
    expect(report.piiHits).toHaveLength(1);
    expect(report.piiHits[0]).toEqual({ file: "USER.md", pattern: "aws-access-key", line: 1, tier: "block" });
    expect(JSON.stringify(report.piiHits)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("workdir 存在 → 比对出增删行数 + 只读 git log", () => {
    writeMemoryFile("USER.md", "l1\nl2\nl3\n");
    const workdir = join(HOME, "workdir-dryrun-diff");
    mkdirSync(join(workdir, ".git"), { recursive: true });
    writeFileSync(join(workdir, "USER.md"), "l1\nl2\n", "utf-8");
    const runner = new FakeRunner((cmd) => {
      if (cmd.join(" ").includes("git log")) return { ok: true, stdout: "abc1234 memx@prod: MEMORY.md +5 行\n", stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    });
    const report = buildDryRunReport({ config: SYNC_CONFIG, runner, workdir });
    expect(report.workdirExists).toBe(true);
    const entry = report.files.find((f) => f.repoPath === "USER.md");
    expect(entry?.added).toBe(1);
    expect(entry?.removed).toBe(0);
    expect(report.remoteLog).toEqual(["abc1234 memx@prod: MEMORY.md +5 行"]);
  });

  it("默认不开 prepare → 零 git 命令（绝不 clone/fetch）", () => {
    const runner = new FakeRunner(() => ({ ok: true, stdout: "", stderr: "" }));
    const report = buildDryRunReport({ config: SYNC_CONFIG, runner, workdir: join(HOME, "workdir-noprepare") });
    expect(report.note).toBe("");
    expect(runner.calls).toHaveLength(0);
  });

  it("prepare：无 workdir → clone（只动 workdir），note 说明基准是远端 HEAD", () => {
    const workdir = join(HOME, "workdir-prepare-clone");
    const runner = new FakeRunner(() => ({ ok: true, stdout: "", stderr: "" }));
    const report = buildDryRunReport({ config: SYNC_CONFIG, runner, workdir, prepare: true });
    expect(runner.called("clone git@github.com:guraul/memx-sync.git")).toBe(true);
    expect(runner.called("push")).toBe(false);
    expect(report.note).toContain("已 clone");
  });

  it("prepare：有 workdir → fetch + merge --ff-only（不 push、不 rebase）", () => {
    const workdir = join(HOME, "workdir-prepare-ff");
    mkdirSync(join(workdir, ".git"), { recursive: true });
    const runner = new FakeRunner(() => ({ ok: true, stdout: "", stderr: "" }));
    const report = buildDryRunReport({ config: SYNC_CONFIG, runner, workdir, prepare: true });
    expect(runner.called("fetch origin main")).toBe(true);
    expect(runner.called("merge --ff-only origin/main")).toBe(true);
    expect(runner.called("push")).toBe(false);
    expect(runner.called("rebase")).toBe(false);
    expect(report.note).toContain("快进");
  });

  it("prepare：有未推提交 → 快进失败，note 明说预览基于本地（不掩盖）", () => {
    const workdir = join(HOME, "workdir-prepare-diverge");
    mkdirSync(join(workdir, ".git"), { recursive: true });
    const runner = new FakeRunner((cmd) => {
      if (cmd.join(" ").includes("merge --ff-only")) return { ok: false, stdout: "", stderr: "not possible to fast-forward" };
      return { ok: true, stdout: "", stderr: "" };
    });
    const report = buildDryRunReport({ config: SYNC_CONFIG, runner, workdir, prepare: true });
    expect(report.note).toContain("未推提交");
  });

  it("prepare：clone 失败 → note 带原因，不抛", () => {
    const workdir = join(HOME, "workdir-prepare-clonefail");
    const runner = new FakeRunner((cmd) =>
      cmd.join(" ").includes("clone")
        ? { ok: false, stdout: "", stderr: "Permission denied (publickey)" }
        : { ok: true, stdout: "", stderr: "" },
    );
    const report = buildDryRunReport({ config: SYNC_CONFIG, runner, workdir, prepare: true });
    expect(report.note).toContain("clone 失败");
    expect(report.note).toContain("publickey");
  });
});

describe("pull 备份（远端优先，但不静默吞本地）", () => {
  it("本地与远端不同 → 覆盖前存 .bak.<ts>，内容 = 覆盖前的本地版", async () => {
    const workdir = join(HOME, "workdir-pull-bak");
    mkdirSync(join(workdir, ".git"), { recursive: true });
    writeMemoryFile("USER.md", "clean local\n");
    writeMemoryFile("projects/baz/.mem/y.md", "local v1\n");
    mkdirSync(join(workdir, "projects", "baz", ".mem"), { recursive: true });
    writeFileSync(join(workdir, "projects", "baz", ".mem", "y.md"), "remote v2\n", "utf-8");
    const runner = new FakeRunner(() => ({ ok: true, stdout: "", stderr: "" }));
    const sync = makeSync(runner, "pullbak", workdir);
    const result = await sync.pull();
    expect(result.ok).toBe(true);
    expect(result.message).toContain("备份");
    const target = join(OPENCODE, "projects/baz/.mem/y.md");
    expect(readFileSync(target, "utf-8")).toBe("remote v2\n");
    const baks = readdirSync(join(OPENCODE, "projects/baz/.mem")).filter((f) => f.startsWith("y.md.bak."));
    expect(baks).toHaveLength(1);
    expect(readFileSync(join(OPENCODE, "projects/baz/.mem", baks[0]!), "utf-8")).toBe("local v1\n");
  });

  it("本地与远端相同 → 不产生 .bak，结果不提备份", async () => {
    const workdir = join(HOME, "workdir-pull-nobak");
    mkdirSync(join(workdir, ".git"), { recursive: true });
    writeMemoryFile("projects/qux/.mem/z.md", "same\n");
    mkdirSync(join(workdir, "projects", "qux", ".mem"), { recursive: true });
    writeFileSync(join(workdir, "projects", "qux", ".mem", "z.md"), "same\n", "utf-8");
    const runner = new FakeRunner(() => ({ ok: true, stdout: "", stderr: "" }));
    const sync = makeSync(runner, "pullnobak", workdir);
    const result = await sync.pull();
    expect(result.ok).toBe(true);
    expect(result.message).not.toContain("备份");
    expect(readdirSync(join(OPENCODE, "projects/qux/.mem")).filter((f) => f.includes(".bak."))).toHaveLength(0);
  });

  it("备份每文件只留最新 5 份", async () => {
    const dir = join(OPENCODE, "projects/keep/.mem");
    const workdir = join(HOME, "workdir-pull-keep");
    mkdirSync(join(workdir, "projects", "keep", ".mem"), { recursive: true });
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 7; i++) {
      writeFileSync(join(dir, `k.md.bak.${1000 + i}`), `old ${i}`, "utf-8");
    }
    writeFileSync(join(dir, "k.md"), "local\n", "utf-8");
    writeFileSync(join(workdir, "projects", "keep", ".mem", "k.md"), "remote\n", "utf-8");
    const runner = new FakeRunner(() => ({ ok: true, stdout: "", stderr: "" }));
    await makeSync(runner, "pullkeep", workdir).pull();
    const baks = readdirSync(dir).filter((f) => f.startsWith("k.md.bak."));
    expect(baks).toHaveLength(5);
    expect(baks).toContain("k.md.bak.1006");
    expect(baks).not.toContain("k.md.bak.1000");
  });
});

describe("push 身份兜底", () => {
  const statusAndNumstat = (cmd: string[]) => {
    const j = cmd.join(" ");
    if (j.includes("status --porcelain")) return { ok: true, stdout: " M USER.md\n", stderr: "" };
    if (j.includes("diff --cached --numstat")) return { ok: true, stdout: "1\t0\tUSER.md\n", stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  };

  it("workdir 没有 git 身份（prod 情形）→ commit 现造 -c user.email", async () => {
    writeMemoryFile("USER.md", "clean identity fallback\n");
    const workdir = join(HOME, "workdir-identity-none");
    mkdirSync(join(workdir, ".git"), { recursive: true });
    const runner = new FakeRunner((cmd) => {
      if (cmd.join(" ").includes("config user.email")) return { ok: true, stdout: "\n", stderr: "" };
      return statusAndNumstat(cmd);
    });
    const result = await makeSync(runner, "identity-none", workdir).push();
    expect(result.ok).toBe(true);
    const commit = runner.calls.find((c) => c.join(" ").includes("commit -m"));
    expect(commit?.join(" ")).toContain("-c user.name=memx-sync -c user.email=memx@localhost commit -m");
  });

  it("workdir 已有 git 身份 → 不覆盖，commit 用原身份", async () => {
    writeMemoryFile("USER.md", "clean identity real\n");
    const workdir = join(HOME, "workdir-identity-real");
    mkdirSync(join(workdir, ".git"), { recursive: true });
    const runner = new FakeRunner((cmd) => {
      if (cmd.join(" ").includes("config user.email")) return { ok: true, stdout: "gubin@example.com\n", stderr: "" };
      return statusAndNumstat(cmd);
    });
    const result = await makeSync(runner, "identity-real", workdir).push();
    expect(result.ok).toBe(true);
    const commit = runner.calls.find((c) => c.join(" ").includes("commit -m"));
    expect(commit?.join(" ")).not.toContain("user.email=memx@localhost");
  });
});

describe("报警可见性与去重", () => {
  it("clone 失败 → SYNC_ERROR warn（不再只有 lastError 没人看见）", async () => {
    writeMemoryFile("USER.md", "clean clone fail\n");
    const runner = new FakeRunner((cmd) =>
      cmd.join(" ").includes("clone") ? { ok: false, stdout: "", stderr: "Host key verification failed" } : { ok: true, stdout: "", stderr: "" },
    );
    const alerts = makeAlerts("clonefail");
    const sync = createSync({
      config: SYNC_CONFIG,
      alerts,
      runner,
      workdir: join(HOME, "workdir-clonefail"),
      statePath: join(HOME, "state-clonefail.json"),
    });
    const result = await sync.push();
    expect(result.ok).toBe(false);
    expect(alerts.list().some((a) => a.code === "SYNC_ERROR" && a.level === "warn")).toBe(true);
    expect(sync.status().lastError).toContain("clone 失败");
  });

  it("同一事实重复失败 → 账本只留一条（定时拉不会刷满 200 条）", async () => {
    writeMemoryFile("USER.md", "clean push dedup\n");
    const workdir = join(HOME, "workdir-dedup");
    mkdirSync(join(workdir, ".git"), { recursive: true });
    const runner = new FakeRunner((cmd) => {
      const j = cmd.join(" ");
      if (j.includes("status --porcelain")) return { ok: true, stdout: " M USER.md\n", stderr: "" };
      if (j.includes("diff --cached --numstat")) return { ok: true, stdout: "1\t0\tUSER.md\n", stderr: "" };
      if (j.includes("push")) return { ok: false, stdout: "", stderr: "offline" };
      return { ok: true, stdout: "", stderr: "" };
    });
    const alerts = makeAlerts("dedup");
    const sync = createSync({
      config: SYNC_CONFIG,
      alerts,
      runner,
      workdir,
      statePath: join(HOME, "state-dedup.json"),
    });
    await sync.push();
    await sync.push();
    const pushFailed = alerts.list().filter((a) => a.code === "SYNC_PUSH_FAILED");
    expect(pushFailed).toHaveLength(1);
    expect(sync.status().consecutiveFailures).toBe(2);
  });
});

describe("成功即销账与失败原因可见", () => {
  it("push 成功后 SYNC_ERROR / SYNC_PUSH_FAILED 被销（先造出这两条旧账再成功推）", async () => {
    writeMemoryFile("USER.md", "clean resolve\n");
    const workdir = join(HOME, "workdir-resolve");
    mkdirSync(join(workdir, ".git"), { recursive: true });
    const runner = new FakeRunner(pushOkResponder);
    const alerts = makeAlerts("resolve");
    const now = new Date().toISOString();
    alerts.append({ level: "warn", code: "SYNC_ERROR", message: "旧账", ts: now });
    alerts.append({ level: "warn", code: "SYNC_PUSH_FAILED", message: "旧账2", ts: now });
    const sync = createSync({
      config: SYNC_CONFIG,
      alerts,
      runner,
      workdir,
      statePath: join(HOME, "state-resolve.json"),
    });
    const result = await sync.push();
    expect(result.ok).toBe(true);
    const codes = alerts.list().map((a) => a.code);
    expect(codes).not.toContain("SYNC_ERROR");
    expect(codes).not.toContain("SYNC_PUSH_FAILED");
  });

  it("SYNC_PII_BLOCKED 不被自动销（需人工处置）", async () => {
    writeMemoryFile("USER.md", "clean pii keep\n");
    const workdir = join(HOME, "workdir-piikeep");
    mkdirSync(join(workdir, ".git"), { recursive: true });
    const runner = new FakeRunner(pushOkResponder);
    const alerts = makeAlerts("piikeep");
    alerts.append({ level: "critical", code: "SYNC_PII_BLOCKED", message: "待人工", ts: new Date().toISOString() });
    const sync = createSync({
      config: SYNC_CONFIG,
      alerts,
      runner,
      workdir,
      statePath: join(HOME, "state-piikeep.json"),
    });
    const result = await sync.push();
    expect(result.ok).toBe(true);
    expect(alerts.list().some((a) => a.code === "SYNC_PII_BLOCKED")).toBe(true);
  });

  it("假 runner 带 reason → 错误文案含该 reason、不含「未知」", async () => {
    writeMemoryFile("USER.md", "clean reason\n");
    const runner = new FakeRunner((cmd) =>
      cmd.join(" ").includes("clone")
        ? { ok: false, stdout: "", stderr: "", reason: "spawnSync git ETIMEDOUT" }
        : { ok: true, stdout: "", stderr: "" },
    );
    const sync = createSync({
      config: SYNC_CONFIG,
      alerts: makeAlerts("reason"),
      runner,
      workdir: join(HOME, "workdir-reason"),
      statePath: join(HOME, "state-reason.json"),
    });
    const result = await sync.push();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("spawnSync git ETIMEDOUT");
    expect(result.message).not.toContain("未知");
    expect(sync.status().lastError).toContain("spawnSync git ETIMEDOUT");
    expect(sync.status().lastError).not.toContain("未知");
  });
});

describe("remoteUrl", () => {
  it("owner/name → GitHub SSH（默认）", () => {
    expect(remoteUrl("guraul/memx-sync")).toBe("git@github.com:guraul/memx-sync.git");
  });

  it("带协议 / 绝对路径 / file: → 原样使用（本机自测与自建远端用）", () => {
    for (const raw of [
      "git@github.com:guraul/memx-sync.git",
      "ssh://git@host/x.git",
      "https://github.com/guraul/memx-sync.git",
      "/tmp/origin.git",
      "file:///tmp/origin.git",
    ]) {
      expect(remoteUrl(raw)).toBe(raw);
    }
  });
});

describe("真实 git 端到端（本地 bare 仓当远端，不打桩）", () => {
  const hasGit = spawnSync("git", ["--version"]).status === 0;

  it.skipIf(!hasGit)("push → 远端可读 → 另一机提交 → pull 更新本地并留 .bak → 再 push 为 no-change", async () => {
    const remote = join(HOME, "origin.git");
    rmSync(remote, { recursive: true, force: true });
    const git = (args: string[], cwd?: string): string => {
      const r = spawnSync("git", args, { cwd, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失败：${r.stderr}`);
      return r.stdout ?? "";
    };
    git(["init", "--bare", remote]);
    // 老版本 git 没有 `init -b`：显式把 HEAD 指到 main
    git([`--git-dir=${remote}`, "symbolic-ref", "HEAD", "refs/heads/main"]);

    writeMemoryFile("USER.md", "e2e machine A\n");
    const workdir = join(HOME, "workdir-e2e");
    rmSync(workdir, { recursive: true, force: true });
    const sync = createSync({
      config: { ...SYNC_CONFIG, repo: remote },
      alerts: makeAlerts("e2e"),
      runner: createNodeGitRunner(),
      workdir,
      statePath: join(HOME, "state-e2e.json"),
    });

    const first = await sync.push();
    expect(first.ok).toBe(true);
    expect(first.kind).toBe("pushed");
    // 真的到了远端（读 bare 仓的 main）
    expect(git([`--git-dir=${remote}`, "show", "main:USER.md"])).toBe("e2e machine A\n");

    // 另一台机器：clone → 改 USER.md → 提交推回
    const other = join(HOME, "other-machine");
    rmSync(other, { recursive: true, force: true });
    git(["clone", remote, other]);
    writeFileSync(join(other, "USER.md"), "e2e machine B\n", "utf-8");
    git(["add", "-A"], other);
    git(["-c", "user.name=B", "-c", "user.email=b@localhost", "commit", "-m", "from B"], other);
    git(["push", "origin", "main"], other);

    const pulled = await sync.pull();
    expect(pulled.ok).toBe(true);
    expect(pulled.kind).toBe("pulled");
    expect(pulled.message).toContain("备份");
    expect(readFileSync(join(OPENCODE, "USER.md"), "utf-8")).toBe("e2e machine B\n");
    const baks = readdirSync(OPENCODE).filter((f) => f.startsWith("USER.md.bak."));
    expect(baks.some((b) => readFileSync(join(OPENCODE, b), "utf-8") === "e2e machine A\n")).toBe(true);

    // 拉完本地 == 远端 → 再推就是 no-change（不会无谓造空提交）
    const second = await sync.push();
    expect(second.ok).toBe(true);
    expect(second.kind).toBe("no-change");
    expect(second.message).toContain("无未推提交"); // issue #12：判据写进文案，便于观测
    expect(git([`--git-dir=${remote}`, "rev-list", "--count", "main"]).trim()).toBe("2");
  });
});

// issue #12 回归（真实 git，不打桩）：断网期本地攒下的提交，恢复后一次 push 必须能清空积压。
// 场景与现场一致：镜像工作树**没有**新的文件差异（本地记忆文件与 workdir 副本一致），
// 只有已经存在于 workdir 里的本地提交没推出去。旧行为 → kind=no-change 且 git push 从未执行。
describe("issue #12：未推提交不再被 no-change 短路（真实 git 端到端）", () => {
  const hasGit = spawnSync("git", ["--version"]).status === 0;

  it.skipIf(!hasGit)("无文件差异 + 本地有未推提交 → 仍 push，远端追上且 unsyncedCommits 归零", async () => {
    const remote = join(HOME, "unsynced-origin.git");
    rmSync(remote, { recursive: true, force: true });
    const git = (args: string[], cwd?: string): string => {
      const r = spawnSync("git", args, { cwd, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失败：${r.stderr}`);
      return r.stdout ?? "";
    };
    git(["init", "--bare", remote]);
    git([`--git-dir=${remote}`, "symbolic-ref", "HEAD", "refs/heads/main"]);

    writeMemoryFile("USER.md", "unsynced A\n");
    const workdir = join(HOME, "workdir-unsynced-e2e");
    rmSync(workdir, { recursive: true, force: true });
    const sync = createSync({
      config: { ...SYNC_CONFIG, repo: remote },
      alerts: makeAlerts("unsynced-e2e"),
      runner: createNodeGitRunner(),
      workdir,
      statePath: join(HOME, "state-unsynced-e2e.json"),
    });

    const first = await sync.push();
    expect(first.ok).toBe(true);
    expect(first.kind).toBe("pushed");
    expect(git([`--git-dir=${remote}`, "rev-list", "--count", "main"]).trim()).toBe("1");

    // 断网模拟：直接在 workdir 里落一个本地提交，**不 push**。
    // ⚠️ 提交内容必须同时等于本地记忆文件（`writeMemoryFile`）——否则 push 时 mirror 拷贝会制造
    // 新的文件差异，这条路就不会经过"无文件差异但有待推提交"的目标分支。
    writeMemoryFile("MEMORY.md", "offline memory\n");
    writeFileSync(join(workdir, "MEMORY.md"), "offline memory\n", "utf-8");
    git(["add", "-A"], workdir);
    git(["-c", "user.name=memx-sync", "-c", "user.email=memx@localhost", "commit", "-m", "offline commit"], workdir);
    expect(git(["rev-list", "--count", "@{u}..HEAD"], workdir).trim()).toBe("1");
    expect(git(["status", "--porcelain"], workdir).trim()).toBe(""); // 前置条件：镜像工作树无文件差异
    expect(git([`--git-dir=${remote}`, "rev-list", "--count", "main"]).trim()).toBe("1"); // 远端仍停在旧提交

    const result = await sync.push();
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("pushed"); // 旧行为：no-change，提交永久滞留
    expect(result.message).toContain("补推 1 个未推提交");
    // 积压真的到远端了
    expect(git([`--git-dir=${remote}`, "rev-list", "--count", "main"]).trim()).toBe("2");
    expect(git([`--git-dir=${remote}`, "show", "main:MEMORY.md"]).trim()).toBe("offline memory");
    expect(sync.status().unsyncedCommits).toBe(0);

    // 再推一次：这回才是真·无变化（无文件差异 + 无未推提交）→ no-change 且不发 push
    const again = await sync.push();
    expect(again.kind).toBe("no-change");
    expect(git([`--git-dir=${remote}`, "rev-list", "--count", "main"]).trim()).toBe("2");
  });
});

describe("短路：真实 git 端到端（本地 bare 仓，不打桩）", () => {
  const hasGit = spawnSync("git", ["--version"]).status === 0;

  it.skipIf(!hasGit)("g) 成功 pull 记下远端 sha；无新提交再 pull → 跳过且只剩一次 ls-remote", async () => {
    const remote = join(HOME, "skip-origin.git");
    rmSync(remote, { recursive: true, force: true });
    const git = (args: string[], cwd?: string): string => {
      const r = spawnSync("git", args, { cwd, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失败：${r.stderr}`);
      return r.stdout ?? "";
    };
    git(["init", "--bare", remote]);
    git([`--git-dir=${remote}`, "symbolic-ref", "HEAD", "refs/heads/main"]);

    writeMemoryFile("USER.md", "skip e2e\n");
    const workdir = join(HOME, "workdir-skip-e2e");
    rmSync(workdir, { recursive: true, force: true });
    // 真 git + 记录命令序列：既要真跑，又要断言"确实没 fetch"
    const inner = createNodeGitRunner();
    const calls: string[][] = [];
    const runner: GitRunner = {
      exec: (cmd, cwd) => {
        calls.push([...cmd]);
        return inner.exec(cmd, cwd);
      },
    };
    const statePath = join(HOME, "state-skip-e2e.json");
    const sync = createSync({
      config: { ...SYNC_CONFIG, repo: remote },
      alerts: makeAlerts("skip-e2e"),
      runner,
      workdir,
      statePath,
    });

    // 先把远端造出来（空 bare 仓 fetch 不到 main），push 与 pull 都是完整流程。
    // push 成功后 state 已记下远端 sha，因此这里用 force 模拟插件启动时的"强制真实 pull"，
    // 才能覆盖"成功 pull 写回 sha → 下一次短路"这条路径（issue #21 起 push 也会记 sha）。
    const pushed = await sync.push();
    expect(pushed.ok).toBe(true);
    const pulled = await sync.pull({ force: true });
    expect(pulled.ok).toBe(true);
    expect(pulled.kind).toBe("pulled");
    const remoteSha = git([`--git-dir=${remote}`, "rev-parse", "main"]).trim();
    expect(readSyncState(statePath)?.lastRemoteSha).toBe(remoteSha);

    calls.length = 0;
    const skipped = await sync.pull();

    expect(skipped.ok).toBe(true);
    expect(skipped.kind).toBe("no-change");
    expect(skipped.message).toContain("跳过拉取");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.join(" ")).toContain("ls-remote");
    expect(calls.some((c) => c.includes("fetch"))).toBe(false);
    expect(readSyncState(statePath)?.lastRemoteSha).toBe(remoteSha);
  });
});

describe("并发串行闸门（workdir 只有一份，push/pull 不能同时碰）", () => {
  it("锁被他人持有 → push 在锁外干等，期间零 git 命令", async () => {
    writeMemoryFile("USER.md", "clean lock test\n");
    const workdir = join(HOME, "workdir-lock");
    mkdirSync(join(workdir, ".git"), { recursive: true });
    const runner = new FakeRunner(() => ({ ok: true, stdout: "", stderr: "" }));
    const sync = makeSync(runner, "lock", workdir);

    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    // withFileLock 在 await 之前就同步拿到锁，调用返回时锁已在手
    const holder = withFileLock(syncLockPath(), () => held, { timeoutMs: 10_000 });

    const p = sync.push();
    await new Promise((r) => setTimeout(r, 120));
    expect(runner.calls).toHaveLength(0); // 还在等锁，一个 git 命令都没发

    release();
    await holder;
    const result = await p;
    expect(result.ok).toBe(true);
    expect(runner.calls.length).toBeGreaterThan(0); // 拿到锁后照常跑完
  });

  it.skipIf(spawnSync("git", ["--version"]).status !== 0)(
    "两个 push 并发 → 串行完成，远端只多一个提交（真实 git，否则会踩 index.lock）",
    async () => {
      const remote = join(HOME, "lock-origin.git");
      rmSync(remote, { recursive: true, force: true });
      const git = (args: string[], cwd?: string): string => {
        const r = spawnSync("git", args, { cwd, encoding: "utf8" });
        if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失败：${r.stderr}`);
        return r.stdout ?? "";
      };
      git(["init", "--bare", remote]);
      git([`--git-dir=${remote}`, "symbolic-ref", "HEAD", "refs/heads/main"]);

      writeMemoryFile("USER.md", "clean concurrent\n");
      const workdir = join(HOME, "workdir-lock-concurrent");
      rmSync(workdir, { recursive: true, force: true });
      const mk = () =>
        createSync({
          config: { ...SYNC_CONFIG, repo: remote },
          alerts: makeAlerts("lock-concurrent"),
          runner: createNodeGitRunner(),
          workdir,
          statePath: join(HOME, "state-lock-concurrent.json"),
        });

      const [a, b] = await Promise.all([mk().push(), mk().push()]);
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      expect([a.kind, b.kind].sort()).toEqual(["no-change", "pushed"]);
      expect(git([`--git-dir=${remote}`, "rev-list", "--count", "main"]).trim()).toBe("1");
    },
  );
});

describe("非快进重试必须带 git 身份（回归：rebase 缺 committer 被误报 SYNC_CONFLICT）", () => {
  const hasGit = spawnSync("git", ["--version"]).status === 0;

  /** 显式构造"没有 git 身份"的环境：清掉 author/committer 的 env，global config 换成一个只有
   *  `user.useConfigOnly = true` 的文件（既没有 user.name/email，又关掉 git 从 hostname 自动推断
   *  身份的能力），system config 指到 /dev/null。
   *  ⚠️ 光清 config 不够：开发者机器上 git 会用 `user@hostname` 自动补一个合法 email，测试会假绿。 */
  async function withNoGitIdentity<T>(fn: () => Promise<T>): Promise<T> {
    const keys = [
      "GIT_AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "GIT_COMMITTER_NAME",
      "GIT_COMMITTER_EMAIL",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_SYSTEM",
    ];
    const saved = new Map<string, string | undefined>();
    for (const k of keys) saved.set(k, process.env[k]);
    for (const k of keys.slice(0, 4)) delete process.env[k];
    const noIdentConfig = join(HOME, "no-identity.gitconfig");
    writeFileSync(noIdentConfig, "[user]\n\tuseConfigOnly = true\n", "utf-8");
    process.env.GIT_CONFIG_GLOBAL = noIdentConfig;
    process.env.GIT_CONFIG_SYSTEM = "/dev/null";
    try {
      return await fn();
    } finally {
      for (const k of keys) {
        const v = saved.get(k);
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it.skipIf(!hasGit)("无身份 + 非快进推送 → rebase 重试成功（kind=pushed，无 SYNC_CONFLICT）", async () => {
    await withNoGitIdentity(async () => {
      const remote = join(HOME, "nf-origin.git");
      rmSync(remote, { recursive: true, force: true });
      const run = (args: string[], cwd?: string) => spawnSync("git", args, { cwd, encoding: "utf8" });
      const git = (args: string[], cwd?: string): string => {
        const r = run(args, cwd);
        if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失败：${r.stderr}`);
        return r.stdout ?? "";
      };
      git(["init", "--bare", remote]);
      git([`--git-dir=${remote}`, "symbolic-ref", "HEAD", "refs/heads/main"]);

      writeMemoryFile("USER.md", "A v1\n");
      const workdir = join(HOME, "workdir-nf-identity");
      rmSync(workdir, { recursive: true, force: true });
      // 真 git + 记录命令序列与每次输出：既要真跑，又要在失败时把 git 原文暴露出来
      const inner = createNodeGitRunner();
      const calls: string[][] = [];
      const results: Array<{ cmd: string; ok: boolean; stderr: string }> = [];
      const runner: GitRunner = {
        exec: (cmd, cwd) => {
          const r = inner.exec(cmd, cwd);
          calls.push([...cmd]);
          results.push({ cmd: cmd.join(" "), ok: r.ok, stderr: r.stderr });
          return r;
        },
      };
      const alerts = makeAlerts("nf-identity");
      const sync = createSync({
        config: { ...SYNC_CONFIG, repo: remote },
        alerts,
        runner,
        workdir,
        statePath: join(HOME, "state-nf-identity.json"),
      });

      // A 首推：workdir 由 sync clone 出来
      const first = await sync.push();
      expect(first.ok).toBe(true);
      expect(first.kind).toBe("pushed");
      // 环境自检：clone 出来的 workdir 确实没有任何 git 身份（user.email / user.name 都取不到）
      expect(run(["config", "user.email"], workdir).stdout.trim()).toBe("");
      expect(run(["config", "user.name"], workdir).stdout.trim()).toBe("");

      // 另一台机器推进远端（改的是另一个文件 → 无内容冲突）
      const other = join(HOME, "nf-other");
      rmSync(other, { recursive: true, force: true });
      git(["clone", remote, other]);
      writeFileSync(join(other, "MEMORY.md"), "B memory\n", "utf-8");
      git(["add", "-A"], other);
      git(["-c", "user.name=B", "-c", "user.email=b@localhost", "commit", "-m", "from B"], other);
      git(["push", "origin", "main"], other);

      // A 本地又改 USER.md → 与远端分叉 → push 非快进 → fetch + rebase 重试（此处正是昨晚炸的那条路径）
      writeMemoryFile("USER.md", "A v2\n");
      calls.length = 0;
      results.length = 0;
      const result = await sync.push();

      // 无身份环境下 rebase 不得报 identity 错误（失败时把 git 原文贴进 diff）
      const rebaseResults = results.filter((r) => r.cmd.includes("rebase") && !r.cmd.includes("--abort"));
      expect(rebaseResults.map((r) => r.stderr).join(" | ")).not.toMatch(/identity unknown/i);
      expect(rebaseResults.every((r) => r.ok)).toBe(true);

      expect(result.ok).toBe(true);
      expect(result.kind).toBe("pushed"); // 旧行为此处会是 "conflict"
      expect(alerts.list().some((a) => a.code === "SYNC_CONFLICT")).toBe(false);

      // 重试确实走了 rebase，且带了兜底身份
      const rebaseCall = calls.find((c) => c.includes("rebase") && !c.includes("--abort"));
      expect(rebaseCall).toBeDefined();
      expect(rebaseCall!.join(" ")).toContain("-c user.name=memx-sync -c user.email=memx@localhost rebase");

      // 远端最终同时含 A 的 USER.md 与 B 的 MEMORY.md（rebase 真的重放成功）
      expect(git([`--git-dir=${remote}`, "show", "main:USER.md"])).toBe("A v2\n");
      expect(git([`--git-dir=${remote}`, "show", "main:MEMORY.md"])).toBe("B memory\n");
    });
  });
});

// issue #21：删除传播。两条路径分别覆盖——
//   push：本地已删、远端（workdir 镜像）仍有 → 从镜像删除并进提交；
//   pull：远端已删、本地仍有 → 删本地副本（先 .bak），且绝不误伤本地新增未推/软删件/范围外文件。
describe("issue #21：isSyncRepoPath（删除传播的安全边界）", () => {
  it("同步范围内的路径才允许传播删除", () => {
    expect(isSyncRepoPath("USER.md")).toBe(true);
    expect(isSyncRepoPath("MEMORY.md")).toBe(true);
    expect(isSyncRepoPath("projects/a/.mem/x.md")).toBe(true);
    expect(isSyncRepoPath("projects/a/.mem/sub/x.md")).toBe(true);
  });

  it(".trash / 点开头文件 / .bak / 范围外 / 非标准 slug 一律拒绝", () => {
    for (const p of [
      "projects/a/.mem/.trash/x.md",
      "projects/a/.mem/.hidden.md",
      "projects/a/.mem/sub/.hidden/x.md",
      "projects/a/.mem/x.md.bak.20260101",
      "projects/a/notes.md",
      "docs/x.md",
      "projects/a/b/.mem/x.md",
      ".trash/USER.md",
      "USER.txt",
    ]) {
      expect(isSyncRepoPath(p), p).toBe(false);
    }
  });

  it("listPendingDeletions 只列基线里、本地已缺失的同步文件", () => {
    const workdir = join(HOME, "workdir-pending-deletions");
    rmSync(workdir, { recursive: true, force: true });
    mkdirSync(join(workdir, ".git"), { recursive: true });
    writeMemoryFile("USER.md", "u\n");
    writeMemoryFile("projects/pd/.mem/keep.md", "keep\n");
    const runner = new FakeRunner((cmd) =>
      cmd.join(" ").includes("ls-tree")
        ? {
            ok: true,
            stdout: [
              "USER.md",
              "projects/pd/.mem/keep.md",
              "projects/pd/.mem/gone.md",
              "projects/pd/.mem/.trash/x.md",
              "docs/out-of-scope.md",
            ].join("\n"),
            stderr: "",
          }
        : { ok: true, stdout: "", stderr: "" },
    );
    expect(listPendingDeletions({ rev: SHA_A, workdir, runner })).toEqual(["projects/pd/.mem/gone.md"]);
  });
});

describe("issue #21 push：本地删除传播到远端", () => {
  it("基线里存在、本地已删 → 从 workdir 删除并进提交；新增未拉的文件不误删", async () => {
    const workdir = join(HOME, "workdir-del-push");
    rmSync(workdir, { recursive: true, force: true });
    mkdirSync(join(workdir, ".git"), { recursive: true });
    mkdirSync(join(workdir, "projects", "delpush", ".mem"), { recursive: true });
    writeFileSync(join(workdir, "projects", "delpush", ".mem", "keep.md"), "keep\n", "utf-8");
    writeFileSync(join(workdir, "projects", "delpush", ".mem", "gone.md"), "gone\n", "utf-8");
    // 另一台机器新写、本机还没拉过的文件：不在基线树里 → 绝不能当成本地删除
    writeFileSync(join(workdir, "projects", "delpush", ".mem", "remote-only.md"), "new\n", "utf-8");

    writeMemoryFile("projects/delpush/.mem/keep.md", "keep\n");
    const statePath = writeStateFile("del-push", { ...okState(SHA_A), lastPushAt: null });

    const runner = new FakeRunner((cmd) => {
      const j = cmd.join(" ");
      if (j.includes("ls-tree")) {
        // SHA_A（基线）里有 keep + gone；SHA_B（push 后的新远端）里只剩 keep
        return j.includes(SHA_A)
          ? { ok: true, stdout: "MEMORY.md\nprojects/delpush/.mem/keep.md\nprojects/delpush/.mem/gone.md\n", stderr: "" }
          : { ok: true, stdout: "MEMORY.md\nprojects/delpush/.mem/keep.md\n", stderr: "" };
      }
      if (j.includes("status --porcelain")) {
        return { ok: true, stdout: " D projects/delpush/.mem/gone.md\n", stderr: "" };
      }
      if (j.includes("diff --cached --numstat")) {
        return { ok: true, stdout: "0\t3\tprojects/delpush/.mem/gone.md\n", stderr: "" };
      }
      if (j.includes("rev-parse origin/main")) return { ok: true, stdout: `${SHA_B}\n`, stderr: "" };
      if (j.includes("rev-list --count")) return { ok: true, stdout: "0\n", stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    });
    const sync = createSync({
      config: SYNC_CONFIG,
      alerts: makeAlerts("del-push"),
      runner,
      workdir,
      statePath,
    });

    // 统计口径：待传播删除 1 个，pendingFiles = 本地文件数 + 1
    const before = sync.status();
    expect(before.pendingDeletions).toBe(1);
    expect(before.pendingFiles).toBe(listToSync().length + 1);

    const result = await sync.push();
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("pushed");
    expect(existsSync(join(workdir, "projects", "delpush", ".mem", "gone.md"))).toBe(false);
    expect(existsSync(join(workdir, "projects", "delpush", ".mem", "keep.md"))).toBe(true);
    // 本地新增未推的同名场景（远端有、基线无、本地无）必须原样保留
    expect(existsSync(join(workdir, "projects", "delpush", ".mem", "remote-only.md"))).toBe(true);
    expect(runner.called("add -A")).toBe(true);
    const commit = runner.calls.find((c) => c.join(" ").includes("commit -m"));
    expect(commit?.join(" ")).toContain("projects/delpush/.mem/gone.md");
    expect(commit?.join(" ")).toContain("-3");
    expect(result.message).toContain("传播删除 1 个");
    // push 成功记下新远端 sha（下次 pull 的删除基线），不再把刚推的删除当远端删除
    expect(readSyncState(statePath)?.lastRemoteSha).toBe(SHA_B);
    expect(sync.status().pendingDeletions).toBe(0);
  });

  it("从未同步过（无 lastRemoteSha 且无历史）→ 不传删除：新机器不会用不完整本地镜像清空远端", async () => {
    const workdir = join(HOME, "workdir-del-push-fresh");
    rmSync(workdir, { recursive: true, force: true });
    mkdirSync(join(workdir, "projects", "delfresh", ".mem"), { recursive: true });
    writeFileSync(join(workdir, "projects", "delfresh", ".mem", "gone.md"), "gone\n", "utf-8");
    writeMemoryFile("projects/delfresh/.mem/keep.md", "keep\n");
    const runner = new FakeRunner((cmd) => {
      const j = cmd.join(" ");
      if (j.includes("status --porcelain")) return { ok: true, stdout: "", stderr: "" };
      if (j.includes("rev-list --count")) return { ok: true, stdout: "0\n", stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    });
    const sync = makeSync(runner, "del-push-fresh", workdir);
    const result = await sync.push();
    expect(result.ok).toBe(true);
    expect(existsSync(join(workdir, "projects", "delfresh", ".mem", "gone.md"))).toBe(true);
    expect(runner.called("ls-tree")).toBe(false);
  });
});

describe("issue #21 pull：尊重远端删除", () => {
  it("远端已删 + 本地仍有 → 删本地副本并备份 .bak；软删件/点开头/范围外/本地新增一律不动", async () => {
    const workdir = join(HOME, "workdir-del-pull");
    rmSync(workdir, { recursive: true, force: true });
    mkdirSync(join(workdir, "projects", "delpull", ".mem"), { recursive: true });
    writeFileSync(join(workdir, "projects", "delpull", ".mem", "keep.md"), "remote keep\n", "utf-8");
    writeFileSync(join(workdir, "projects", "delpull", ".mem", "new.md"), "remote new\n", "utf-8");

    writeMemoryFile("projects/delpull/.mem/keep.md", "local keep\n");
    writeMemoryFile("projects/delpull/.mem/gone.md", "local gone v1\n");
    writeMemoryFile("projects/delpull/.mem/new.md", "remote new\n");
    writeMemoryFile("projects/delpull/.mem/.trash/gone.md.123", "trashed\n");
    writeMemoryFile("projects/delpull/.mem/.hidden.md", "hidden\n");
    writeMemoryFile("projects/delpull/notes.txt", "out of scope\n");

    writeStateFile("del-pull", { ...okState(SHA_A), lastPushAt: null });
    const runner = new FakeRunner((cmd) => {
      const j = cmd.join(" ");
      if (j.includes("ls-remote")) return { ok: true, stdout: `${SHA_B}\trefs/heads/main\n`, stderr: "" };
      if (j.includes("diff --name-only")) {
        return {
          ok: true,
          stdout: [
            "projects/delpull/.mem/gone.md",
            "projects/delpull/.mem/.trash/gone.md.123",
            "projects/delpull/.mem/.hidden.md",
            "projects/delpull/notes.txt",
          ].join("\n"),
          stderr: "",
        };
      }
      if (j.includes("rev-parse origin/main")) return { ok: true, stdout: `${SHA_B}\n`, stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    });
    const sync = makeSync(runner, "del-pull", workdir);

    const result = await sync.pull();
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("pulled");
    expect(result.message).toContain("移除 1 个远端已删文件");
    // 远端已删 → 本地副本消失，但先留了 .bak
    expect(existsSync(join(OPENCODE, "projects/delpull/.mem/gone.md"))).toBe(false);
    const baks = readdirSync(join(OPENCODE, "projects/delpull/.mem")).filter((f) => f.startsWith("gone.md.bak."));
    expect(baks).toHaveLength(1);
    expect(readFileSync(join(OPENCODE, "projects/delpull/.mem", baks[0]!), "utf-8")).toBe("local gone v1\n");
    // 安全网：软删件 / 点开头 / 范围外 / 本地新增（不在远端删除清单里）都不受影响
    expect(existsSync(join(OPENCODE, "projects/delpull/.mem/.trash/gone.md.123"))).toBe(true);
    expect(existsSync(join(OPENCODE, "projects/delpull/.mem/.hidden.md"))).toBe(true);
    expect(existsSync(join(OPENCODE, "projects/delpull/notes.txt"))).toBe(true);
    if (baks.length > 0) expect(baks[0]!.startsWith(".hidden")).toBe(false);
    // 正常远端内容照旧回拷 + 覆盖前备份
    expect(readFileSync(join(OPENCODE, "projects/delpull/.mem/keep.md"), "utf-8")).toBe("remote keep\n");
    expect(readFileSync(join(OPENCODE, "projects/delpull/.mem/new.md"), "utf-8")).toBe("remote new\n");
  });

  it("基线未知（旧状态文件无 lastRemoteSha）→ 不删本地任何文件（保守 fail-safe）", async () => {
    const workdir = join(HOME, "workdir-del-pull-nobase");
    rmSync(workdir, { recursive: true, force: true });
    mkdirSync(join(workdir, "projects", "delnobase", ".mem"), { recursive: true });
    writeFileSync(join(workdir, "projects", "delnobase", ".mem", "keep.md"), "remote\n", "utf-8");
    writeMemoryFile("projects/delnobase/.mem/gone.md", "local\n");
    writeStateFile("del-pull-nobase", {
      lastPushAt: null,
      lastPullAt: "2026-01-01T00:00:00.000Z",
      lastError: "",
      consecutiveFailures: 0,
      lastPiiScan: null,
    });
    const runner = new FakeRunner((cmd) => {
      const j = cmd.join(" ");
      if (j.includes("diff --name-only")) {
        return { ok: true, stdout: "projects/delnobase/.mem/gone.md\n", stderr: "" };
      }
      return { ok: true, stdout: "", stderr: "" };
    });
    const sync = makeSync(runner, "del-pull-nobase", workdir);
    const result = await sync.pull();
    expect(result.ok).toBe(true);
    expect(existsSync(join(OPENCODE, "projects/delnobase/.mem/gone.md"))).toBe(true);
    expect(runner.called("diff --name-only")).toBe(false);
    expect(result.message).not.toContain("移除");
  });
});

describe("issue #21 真实 git 端到端：push 传播删除 + pull 尊重删除", () => {
  const hasGit = spawnSync("git", ["--version"]).status === 0;

  it.skipIf(!hasGit)("A 删文件 push → 远端消失；B 删另一文件 push → A pull 后本地消失且留 .bak", async () => {
    const remote = join(HOME, "delete-origin.git");
    rmSync(remote, { recursive: true, force: true });
    const git = (args: string[], cwd?: string): string => {
      const r = spawnSync("git", args, { cwd, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失败：${r.stderr}`);
      return r.stdout ?? "";
    };
    git(["init", "--bare", remote]);
    git([`--git-dir=${remote}`, "symbolic-ref", "HEAD", "refs/heads/main"]);

    const slug = "dele2e";
    writeMemoryFile(`projects/${slug}/.mem/a.md`, "a\n");
    writeMemoryFile(`projects/${slug}/.mem/b.md`, "b\n");
    const workdir = join(HOME, "workdir-delete-e2e");
    rmSync(workdir, { recursive: true, force: true });
    const statePath = join(HOME, "state-delete-e2e.json");
    const sync = createSync({
      config: { ...SYNC_CONFIG, repo: remote },
      alerts: makeAlerts("delete-e2e"),
      runner: createNodeGitRunner(),
      workdir,
      statePath,
    });

    const pushed = await sync.push();
    expect(pushed.ok).toBe(true);
    expect(git([`--git-dir=${remote}`, "show", `main:projects/${slug}/.mem/b.md`])).toBe("b\n");

    // A 本地删除 b.md → push 必须把删除写进远端提交
    rmSync(join(OPENCODE, `projects/${slug}/.mem/b.md`));
    const pruned = await sync.push();
    expect(pruned.ok).toBe(true);
    expect(pruned.kind).toBe("pushed");
    expect(pruned.message).toContain("传播删除 1 个");
    expect(spawnSync("git", [`--git-dir=${remote}`, "cat-file", "-e", `main:projects/${slug}/.mem/b.md`]).status).not.toBe(0);
    expect(git([`--git-dir=${remote}`, "show", `main:projects/${slug}/.mem/a.md`])).toBe("a\n");
    expect(git(["status", "--porcelain"], workdir).trim()).toBe("");

    // B 机器删除 a.md 并推回
    const other = join(HOME, "delete-other-machine");
    rmSync(other, { recursive: true, force: true });
    git(["clone", remote, other]);
    rmSync(join(other, `projects/${slug}/.mem/a.md`));
    git(["add", "-A"], other);
    git(["-c", "user.name=B", "-c", "user.email=b@localhost", "commit", "-m", "B deletes a"], other);
    git(["push", "origin", "main"], other);

    // A pull：尊重远端删除（删本地 a.md，先备份）
    const pulled = await sync.pull();
    expect(pulled.ok).toBe(true);
    expect(pulled.kind).toBe("pulled");
    expect(pulled.message).toContain("移除 1 个远端已删文件");
    expect(existsSync(join(OPENCODE, `projects/${slug}/.mem/a.md`))).toBe(false);
    const baks = readdirSync(join(OPENCODE, `projects/${slug}/.mem`)).filter((f) => f.startsWith("a.md.bak."));
    expect(baks).toHaveLength(1);
    expect(readFileSync(join(OPENCODE, `projects/${slug}/.mem`, baks[0]!), "utf-8")).toBe("a\n");
    expect(git([`--git-dir=${remote}`, "ls-tree", "-r", "--name-only", "main"]).includes(`projects/${slug}/.mem/a.md`)).toBe(false);

    // 收敛后再 push = no-change（删除不会被反复重放）
    const again = await sync.push();
    expect(again.kind).toBe("no-change");
    expect(readSyncState(statePath)?.lastRemoteSha).toBe(git([`--git-dir=${remote}`, "rev-parse", "main"]).trim());
  });
});
