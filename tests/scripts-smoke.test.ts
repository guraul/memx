// CLI 脚本冒烟：这两个脚本是用户/运维直接跑的入口，走 `node --experimental-strip-types`
// 直接加载 src/*.ts —— 值导入缺 `.ts` 扩展名时 tsc 与 vitest 都发现不了，只有真跑才会
// ERR_MODULE_NOT_FOUND（2026-10-13 实际踩到：sync.ts 的 `./store/lock` 让 pnpm run doctor 挂掉）。
// 三个脚本都不写盘、不碰远端：doctor 读 alerts/记忆文件/kv，dry-run 只比对本地与缓存 workdir，不 clone/fetch/push。
import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
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
