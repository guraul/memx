import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import {
  createSync,
  scanSensitive,
  listToSync,
  buildDryRunReport,
  type GitRunner,
} from "../src/core/sync";
import { createFileAlertStore, type AlertStore } from "../src/core/alerts";
import { MemxConfigSchema } from "../src/core/config";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => "/tmp/opencode-memx-sync-test-home" };
});

const HOME = "/tmp/opencode-memx-sync-test-home";
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
  constructor(private responder: (cmd: string[]) => { ok: boolean; stdout: string; stderr: string }) {}
  exec(cmd: string[], _cwd: string): { ok: boolean; stdout: string; stderr: string } {
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

function makeSync(runner: FakeRunner, name: string, workdir?: string, config = SYNC_CONFIG) {
  return createSync({
    config,
    alerts: makeAlerts(name),
    runner,
    workdir: workdir ?? join(HOME, `workdir-${name}`),
    statePath: join(HOME, `state-${name}.json`),
  });
}

describe("scanSensitive", () => {
  it("正例：8 类规则各命中一次，只报行号+规则名", () => {
    const text = [
      "openai: sk-abc123XYZ7890abcd",
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

  it("命中只含 pattern+line 两个字段，绝不回显内容", () => {
    const hits = scanSensitive("aws: AKIAIOSFODNN7EXAMPLE\n");
    expect(hits).toHaveLength(1);
    expect(Object.keys(hits[0]!).sort()).toEqual(["line", "pattern"]);
    expect(JSON.stringify(hits)).not.toContain("AKIAIOSFODNN7EXAMPLE");
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
    writeMemoryFile("USER.md", "my key is sk-abc123XYZ7890abcd\n");
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
    expect(JSON.stringify(list)).not.toContain("sk-abc123XYZ7890abcd");
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

  it("无改动 → 不 commit 不 push", async () => {
    writeMemoryFile("USER.md", "same\n");
    const workdir = join(HOME, "workdir-nochange");
    mkdirSync(join(workdir, ".git"), { recursive: true });
    writeFileSync(join(workdir, "USER.md"), "same\n", "utf-8");
    const runner = new FakeRunner((cmd) => {
      if (cmd.join(" ").includes("status --porcelain")) return { ok: true, stdout: "", stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    });
    const sync = makeSync(runner, "nochange", workdir);
    const result = await sync.push();
    expect(result.kind).toBe("no-change");
    expect(runner.called("commit")).toBe(false);
    expect(runner.called("push")).toBe(false);
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
    expect(report.piiHits[0]).toEqual({ file: "USER.md", pattern: "aws-access-key", line: 1 });
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
});
