// P0-4（handoff-20261011 §4 阶段 3-4）：跨进程 read-modify-write 的文件锁（锁文件 + mtime TTL）。
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { withFileLock, FileLockTimeoutError } from "../src/core/store/lock.ts";

const dir = mkdtempSync(join(tmpdir(), "memx-lock-test-"));
const lockPath = join(dir, "test.lock");

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("withFileLock", () => {
  it("持有期间锁文件存在，结束后释放", async () => {
    expect(existsSync(lockPath)).toBe(false);
    await withFileLock(lockPath, () => {
      expect(existsSync(lockPath)).toBe(true);
    });
    expect(existsSync(lockPath)).toBe(false);
  });

  it("串行化并发调用（第二个等第一个交锁）", async () => {
    const events: string[] = [];
    const first = withFileLock(lockPath, async () => {
      events.push("a-start");
      await sleep(80);
      events.push("a-end");
      return "a";
    });
    await sleep(10);
    const second = withFileLock(lockPath, () => {
      events.push("b-start");
      events.push("b-end");
      return "b";
    });
    const [a, b] = await Promise.all([first, second]);
    expect([a, b]).toEqual(["a", "b"]);
    expect(events).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("持锁者崩溃（锁 mtime 超过 TTL）→ 自动夺锁", async () => {
    writeFileSync(lockPath, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    const result = await withFileLock(lockPath, () => "stolen", { ttlMs: 1_000 });
    expect(result).toBe("stolen");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("新鲜锁 + 等锁超时 → FileLockTimeoutError（不无限等）", async () => {
    await withFileLock(lockPath, async () => {
      await expect(
        withFileLock(lockPath, () => "never", { timeoutMs: 60, retryMs: 10, ttlMs: 60_000 }),
      ).rejects.toBeInstanceOf(FileLockTimeoutError);
    });
  });

  it("fn 抛异常也要释放锁", async () => {
    await expect(
      withFileLock(lockPath, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(lockPath)).toBe(false);
    await expect(withFileLock(lockPath, () => "ok")).resolves.toBe("ok");
  });

  it("锁目录不存在时自动建目录（不把冷启动变成失败点）", async () => {
    const nested = join(dir, "no-such-dir", "x.lock");
    await expect(withFileLock(nested, () => "x")).resolves.toBe("x");
  });

  it("清理", () => {
    rmSync(dir, { recursive: true, force: true });
    expect(existsSync(dir)).toBe(false);
  });
});
