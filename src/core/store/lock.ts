// P0-4（handoff-20261011 §4 阶段 3-4）：USER.md / MEMORY.md 的跨进程 read-modify-write 竞态。
//
// 现状：插件实例不止一个（每个 opencode 进程、甚至 `opencode run --server` 客户端都会实例化
// 插件），各自 read → LLM → write 全文件，后写者覆盖先写者（丢条目）。
// 内存里的 `refinementInFlight` 只挡同进程内并发。
//
// 方案（用户拍板：不上 SQLite，"竞态用锁修"）：锁文件 + mtime TTL。
//   - 获取：`openSync(path, "wx")`（独占创建，原子）
//   - 陈旧：持锁者崩溃时锁文件不会自己消失 → mtime 超过 ttlMs 视为陈旧，夺锁重试
//   - 超时：等锁超过 timeoutMs 抛错（不无限等；错误进 diag.lastError，缓冲保留待下轮）
// 注意：锁只包住 read-modify-write，**绝不能包住 LLM 调用**（那会把锁持有到几十秒）。
import { closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

export interface FileLockOptions {
  /** 锁文件 mtime 超过该值视为持锁者已崩溃，自动夺锁（默认 30s） */
  ttlMs?: number;
  /** 等锁上限，超时抛 FileLockTimeoutError（默认 5s） */
  timeoutMs?: number;
  /** 重试间隔（默认 50ms） */
  retryMs?: number;
  /** 测试注入点 */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class FileLockTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileLockTimeoutError";
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 尝试夺锁：成功返回 true；EEXIST 返回 false；其他错误原样抛出 */
function tryAcquire(lockPath: string): boolean {
  try {
    closeSync(openSync(lockPath, "wx"));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/** 陈旧判定 + 夺锁；返回 true 表示已把陈旧锁清掉（调用方应立刻重试） */
function stealIfStale(lockPath: string, ttlMs: number, now: () => number): boolean {
  try {
    const st = statSync(lockPath);
    if (now() - st.mtimeMs > ttlMs) {
      unlinkSync(lockPath);
      return true;
    }
  } catch {
    // 锁在判定期间被持锁者释放（ENOENT）或权限异常：下一轮 tryAcquire 会重试
  }
  return false;
}

export async function withFileLock<T>(
  lockPath: string,
  fn: () => T | Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  const ttlMs = opts.ttlMs ?? 30_000;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const retryMs = opts.retryMs ?? 50;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;

  const startedAt = now();
  // 锁文件所在目录（通常是 ~/.opencode）必须先存在：冷启动下可能还没被 install.sh/首次写盘建出来，
  // 不建就直接 ENOENT 抛错，等于把"锁"变成新的失败点。
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch {
    // 建不出来就让 tryAcquire 如实抛错
  }
  for (;;) {
    if (tryAcquire(lockPath)) break;
    if (stealIfStale(lockPath, ttlMs, now)) continue;
    if (now() - startedAt >= timeoutMs) {
      throw new FileLockTimeoutError(`memx: lock timeout after ${timeoutMs}ms (${lockPath})`);
    }
    await sleep(retryMs);
  }

  try {
    return await fn();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // 锁已被夺（自己的 mtime 被判陈旧）或已删除：绝不能因此抛回调用方
    }
  }
}

export function userMdLockPath(): string {
  return join(homedir(), ".opencode", ".USER.md.lock");
}

export function memoryIndexLockPath(): string {
  return join(homedir(), ".opencode", ".MEMORY.md.lock");
}

/** 是否为陈旧锁残留（doctor 诊断用；只读，不夺锁） */
export function isLockStale(lockPath: string, ttlMs: number, now: () => number = Date.now): boolean {
  if (!existsSync(lockPath)) return false;
  try {
    return now() - statSync(lockPath).mtimeMs > ttlMs;
  } catch {
    return false;
  }
}
