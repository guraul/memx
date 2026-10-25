// CLI 脚本冒烟：这两个脚本是用户/运维直接跑的入口，走 `node --experimental-strip-types`
// 直接加载 src/*.ts —— 值导入缺 `.ts` 扩展名时 tsc 与 vitest 都发现不了，只有真跑才会
// ERR_MODULE_NOT_FOUND（2026-10-13 实际踩到：sync.ts 的 `./store/lock` 让 pnpm run doctor 挂掉）。
// 三个脚本都不写记忆文件、不碰远端：doctor 读 alerts/记忆文件/kv，dry-run 只比对本地与缓存 workdir，不 clone/fetch/push。
// （#30 起 doctor 是唯一有写副作用的：顶距 <20% 时往报警账本 append 一条 HEADROOM_LOW，故新增用例全部用临时 HOME。）
import { describe, it, expect, vi, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 只放大本文件的用例超时（issue #16）：这里的用例都用 `spawnSync` 起 node 子进程跑
// `--experimental-strip-types` 脚本，冷启动 + 类型剥离在高负载机器上可能超过 vitest 默认 5s
// （2026-10-17 与 10-22 两次高负载下各红了 5 例，原样重跑即全绿）。spawnSync 是同步阻塞的，vitest 的
// 5s 计时包含整段子进程执行，负载越高越容易踩线。不改全局 testTimeout：其它用例保持 5s，
// 真正的性能退化仍能暴露。
vi.setConfig({ testTimeout: 30_000 });

const CASES = [
  { script: "scripts/doctor.ts", args: [], marker: "sync: enabled=" },
  { script: "scripts/sync-dry-run.ts", args: [], marker: "memx sync dry-run" },
  // status / pii 都是只读模式：不发任何 git 命令，所以在测试里跑真实 config 也安全
  { script: "scripts/sync-op.ts", args: ["status"], marker: "待同步" },
  { script: "scripts/sync-op.ts", args: ["pii"], marker: "PII 自查" },
];

describe("CLI 脚本能真的加载并跑完（node --experimental-strip-types）", () => {
  for (const { script, args, marker } of CASES) {
    it(`${script} 退出码 0、无模块解析错误、打出面板`, () => {
      const path = fileURLToPath(new URL(`../${script}`, import.meta.url));
      const r = spawnSync(process.execPath, ["--experimental-strip-types", path, ...args], {
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(r.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(marker);
    });
  }
});

// #30：doctor 新增的 memory stats 段。用临时 HOME 起子进程（打桩方式与上面一致，只是把 ~ 指到 fixture），
// 这样既能断言面板内容，又不会碰到本机真实记忆/账本。
describe("doctor 的 memory stats 段（#30）", () => {
  const homes: string[] = [];

  afterAll(() => {
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  });

  function makeHome(): string {
    const home = mkdtempSync(join(tmpdir(), "memx-doctor-stats-"));
    homes.push(home);
    mkdirSync(join(home, ".opencode", "projects", "root-project", ".mem", ".trash"), { recursive: true });
    return home;
  }

  function runDoctor(home: string): ReturnType<typeof spawnSync> {
    const path = fileURLToPath(new URL("../scripts/doctor.ts", import.meta.url));
    return spawnSync(process.execPath, ["--experimental-strip-types", path], {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, HOME: home },
    });
  }

  it("打出各节 / 卡片龄期 / trash；顶距充足时不写报警", () => {
    const home = makeHome();
    const memDir = join(home, ".opencode", "projects", "root-project", ".mem");
    writeFileSync(
      join(memDir, "a.md"),
      "---\nname: a\ndescription: d\ntype: project\ncreated: 2026-01-02\n---\n\nbody\n",
      "utf-8",
    );
    // 老卡没有 created：必须落「未知」，不得用 mtime 兜底
    writeFileSync(join(memDir, "b.md"), "---\nname: b\ndescription: d\ntype: project\n---\n\nbody\n", "utf-8");
    writeFileSync(join(memDir, ".trash", "old.md.1"), "x", "utf-8");
    writeFileSync(
      join(home, ".opencode", "MEMORY.md"),
      "# Project Memory\n\n## root-project\n- [a](~/.opencode/projects/root-project/.mem/a.md) - hook a\n",
      "utf-8",
    );

    const r = runDoctor(home);
    expect(r.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("memory index:");
    expect(r.stdout).toMatch(/root-project: 1 条, [\d.]+KB, [\d.]+% of 25KB/);
    expect(r.stdout).toContain("card age:");
    expect(r.stdout).toContain("未知=1");
    expect(r.stdout).toContain("trash: 1 个文件（root-project=1）");
    expect(existsSync(join(home, ".opencode", "memx-alerts.json"))).toBe(false);
  });

  it("顶距 <20% → 写一条 critical HEADROOM_LOW；重复跑不重复写；退出码仍 0", () => {
    const home = makeHome();
    // ~22KB 的索引：25KB 上限下顶距 <20%
    const filler = "- [x](~/.opencode/projects/root-project/.mem/x.md) - y\n".repeat(400);
    writeFileSync(join(home, ".opencode", "MEMORY.md"), `## root-project\n${filler}`, "utf-8");

    const first = runDoctor(home);
    expect(first.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("HEADROOM_LOW");

    const alertsPath = join(home, ".opencode", "memx-alerts.json");
    const alerts: Array<{ level: string; code: string }> = JSON.parse(readFileSync(alertsPath, "utf-8"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ level: "critical", code: "HEADROOM_LOW" });

    // 同 code+message 去重（与 core/sync.ts 一致）：第二次不追加
    expect(runDoctor(home).status).toBe(0);
    const again: unknown[] = JSON.parse(readFileSync(alertsPath, "utf-8"));
    expect(again).toHaveLength(1);
  });
});
