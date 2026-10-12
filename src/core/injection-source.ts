// memx · 注入内容的文件读取层（stat 校验缓存）。
//
// `context` hook **每个 step 触发一次**（一轮回复可能十几次）。三个文件每次
// readFileSync 是白烧 IO，且长会话里 IO 抖动会直接体现在首 token 延迟上。
// 这里用 statSync 的 mtimeMs + size 双校验：只 stat，不满足变化就复用上次的文本。
// 文件缺失也缓存（记 mtimeMs=-1），这样"每秒十几次 stat 一个不存在的文件"也不会变成
// 十几次 ENOENT 异常构造——同时新建文件后 mtime 变化会自然打破缓存。
//
// 注意 mtimeMs 精度：同一毫秒内的两次写入理论上会被误判为没变。memx 的写盘是
// writeFileSync(tmp) + renameSync()，rename 会换 inode 且 mtime 必然前进，实测不存在
// 这个窗口；而为了它加 inode 比较属于过度设计。
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { PROTOCOL_FILE_NAME } from "./protocol-template";
import { getUserMdPath } from "./store/user-md";
import { getMemoryIndexPath } from "./store/memory-md";
import type { InjectionSources } from "./injection";

interface CacheEntry {
  mtimeMs: number;
  size: number;
  /** null = 上次 stat 时文件不存在 */
  text: string | null;
}

const MISSING = -1;

export function getProtocolPath(): string {
  return join(homedir(), ".opencode", PROTOCOL_FILE_NAME);
}

export class InjectionSourceCache {
  private readonly entries = new Map<string, CacheEntry>();

  /** 读一个文件，命中未变则返回缓存文本。文件不存在返回 null（静默，不抛）。 */
  read(path: string): string | null {
    let stat: { mtimeMs: number; size: number };
    try {
      const s = statSync(path);
      if (!s.isFile()) {
        this.entries.set(path, { mtimeMs: MISSING, size: MISSING, text: null });
        return null;
      }
      stat = { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      // ENOENT / EACCES / 路径非法——一律当"没有"，绝不抛给宿主
      this.entries.set(path, { mtimeMs: MISSING, size: MISSING, text: null });
      return null;
    }

    const cached = this.entries.get(path);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.text;
    }

    let text: string;
    try {
      text = readFileSync(path, "utf-8");
    } catch {
      this.entries.set(path, { mtimeMs: MISSING, size: MISSING, text: null });
      return null;
    }
    this.entries.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, text });
    return text;
  }

  /** 上次读取是否走了缓存（诊断用；mtime 变了就是 false）。 */
  wasCached(path: string): boolean {
    const cached = this.entries.get(path);
    return cached !== undefined && cached.mtimeMs !== MISSING;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** 读齐三块来源（协议 / USER.md / MEMORY.md），缺的留 null。 */
export function readInjectionSources(cache: InjectionSourceCache): InjectionSources {
  return {
    protocol: cache.read(getProtocolPath()),
    user: cache.read(getUserMdPath()),
    memory: cache.read(getMemoryIndexPath()),
  };
}