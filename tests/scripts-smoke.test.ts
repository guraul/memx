// CLI 脚本冒烟：这两个脚本是用户/运维直接跑的入口，走 `node --experimental-strip-types`
// 直接加载 src/*.ts —— 值导入缺 `.ts` 扩展名时 tsc 与 vitest 都发现不了，只有真跑才会
// ERR_MODULE_NOT_FOUND（2026-10-13 实际踩到：sync.ts 的 `./store/lock` 让 pnpm run doctor 挂掉）。
// 三个脚本都不写盘、不碰远端：doctor 读 alerts/记忆文件/kv，dry-run 只比对本地与缓存 workdir，不 clone/fetch/push。
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
