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
//
// 位置说明（#17 A 步）：本文件原先在 `core/injection-source.ts`，与 `core/pipeline/` 的
// 会话流水线同属"多宿主共用"的一层，故一并搬进 pipeline/。导入方（opencode 宿主、
// 单测）跟着改路径，语义与缓存行为不变。
//
// #32：注入范围从「OpenCode 整份 / DSH 单节」统一成「**当前节 + related**」——
// 只取当前 slug 一节会丢跨节记忆（实测 58% 的 hook 在讲别的项目：slug 按 cwd 派生、
// 内容按主题写，于是 `/memx` 下开会话看不到躺在 `agent-mobile` 节里的 memx 记忆）。
// related = 其它节里按「项目目录末段 + 词边界」命中的条目（hook 优先，正文兜底），
// 按索引顺序取前 10 条，纯确定性（无时间/计数/随机）→ 宿主注入字节恒定照旧成立。
import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { PROTOCOL_FILE_NAME } from "../protocol-template.ts";
import { getUserMdPath } from "../store/user-md.ts";
import { getMemoryIndexPath, parseMemoryIndex, serializeMemoryIndex } from "../store/memory-md.ts";
import type { MemoryIndexDoc, MemoryIndexEntry } from "../store/memory-md.ts";
import type { InjectionSources } from "../injection.ts";

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

/** related 条目的注入上限（索引顺序前 N 条）。 */
export const RELATED_INJECT_LIMIT = 10;

/**
 * 不能当匹配键的目录末段：它们描述的是**路径容器**，不是项目名。
 *
 * 典型形态 `/<user>/workspace/<project>`、`/root/project/<project>`：拿 `workspace`
 * 或 `project` 去匹配，几乎每一节都会命中（等于把整份索引又注回来了，只是顺序更乱）。
 * 大小写不敏感（比对前统一小写）。
 */
export const INJECTION_KEY_STOPWORDS: readonly string[] = [
  "workspace",
  "workspaces",
  "projects",
  "project",
  "users",
  "user",
  "home",
  "root",
  "root-project",
  "tmp",
  "temp",
  "src",
  "code",
  "repos",
  "repo",
  "dev",
  "opt",
  "var",
  "desktop",
  "documents",
  "gubin",
];

/**
 * 项目目录的**末段**做匹配键（`/Users/gubin/workspace/memx` → `memx`）。
 *
 * 为什么不是 slug：slug 是整条路径压平（`Users-gubin-workspace-memx`），实测只命中
 * 1/13 的跨节条目；而末段 `memx` 命中 13/13（钩子是按主题写的，主题就是项目名）。
 * 停用词 / 空目录 / 单字符 → null（宁可少注入，不可误注入）。
 */
export function injectionKeyForDirectory(directory: string | null | undefined): string | null {
  if (typeof directory !== "string") return null;
  const trimmed = directory.trim().replace(/[\\/]+$/, "");
  if (trimmed === "") return null;
  const segment = basename(trimmed);
  if (segment === "" || segment === "/" || segment === "." || segment === "..") return null;
  const key = segment.toLowerCase();
  if (key.length < 2) return null;
  if (INJECTION_KEY_STOPWORDS.includes(key)) return null;
  return key;
}

/**
 * 词边界匹配（大小写不敏感）。
 *
 * `\w` 只含 ASCII 字母数字下划线：所以 `用memx提炼` / `memx仓库` 两侧都算边界（中文
 * 不是 word 字符），而 `memx_pr_squash_only` 里的 `memx_` 不算命中（下划线是 word）。
 * 短名会误报（`memx-worktrees` 命中 `memx`）—— 方向是"多注入一条"，不是"少注入"。
 */
export function matchesInjectionKey(text: string, key: string): boolean {
  if (key === "" || text === "") return false;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<!\\w)${escaped}(?!\\w)`, "i").test(text);
}

function filenameOf(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1] ?? filePath;
}

function renderSection(slug: string, entries: MemoryIndexEntry[]): string {
  return serializeMemoryIndex({ preamble: [], sections: [{ slug, entries }] }).trim();
}

/**
 * 选 related 条目：其它节里命中匹配键的条目，**索引顺序前 limit 条**。
 *
 * - hook 命中就收，不再读正文（省一次读盘）；hook 不中才用 `readCard` 的正文兜底。
 * - 按**文件名**去重：同一张卡被登记在两个节是存量事实（#32 实测），当前节已有的
 *   卡片一律不再从 related 里重复注入。
 * - 不排序、不看时间、不随机：同一份索引 + 同一个键永远选出同一批（注入字节恒定的前提）。
 */
export function selectRelatedEntries(
  doc: MemoryIndexDoc,
  slug: string,
  key: string,
  readCard?: (filePath: string) => string | null,
  limit: number = RELATED_INJECT_LIMIT,
): MemoryIndexEntry[] {
  if (key === "" || limit <= 0) return [];

  const seen = new Set<string>();
  const current = doc.sections.find((s) => s.slug === slug);
  for (const entry of current?.entries ?? []) seen.add(filenameOf(entry.filePath));

  const picked: MemoryIndexEntry[] = [];
  for (const section of doc.sections) {
    if (section.slug === slug) continue;
    for (const entry of section.entries) {
      if (picked.length >= limit) return picked;
      const filename = filenameOf(entry.filePath);
      if (seen.has(filename)) continue;
      if (!matchesInjectionKey(entry.hook, key)) {
        const body = readCard?.(entry.filePath) ?? null;
        if (body === null || !matchesInjectionKey(body, key)) continue;
      }
      seen.add(filename);
      picked.push(entry);
    }
  }
  return picked;
}

export interface MemoryInjectionInput {
  indexContent?: string | null | undefined;
  slug: string;
  /** 会话工作目录（related 的匹配键从它的末段取）。 */
  directory?: string | null | undefined;
  /** 读卡片正文（hook 未命中时兜底）；缺省 = 不读正文，只按 hook 匹配。 */
  readCard?: ((filePath: string) => string | null) | undefined;
  limit?: number | undefined;
}

export interface MemoryInjection {
  /** 合并后的注入文本；当前节与 related 都空 → null（调用方据此一个 part 都不加）。 */
  text: string | null;
  /** 当前节条目数 */
  current: number;
  /** related 条目数 */
  related: number;
  /** 本次匹配用的键；null = 拿不到可用的键（停用词/无目录），不找 related。 */
  key: string | null;
}

/**
 * 注入文本 = **当前节 + related**（#32）。纯函数：除 `readCard` 回调外没有任何 IO，
 * 也不引入时间戳/计数/随机，所以同一份索引在同一 cwd 下每次渲染出同一段字节。
 *
 * 非受管行（`extras`：健康日志注释、用户手写说明）**不注入**：它们不是给模型的记忆，
 * 而且带时间戳的话会破坏"会话内字节恒定"。
 */
export function buildMemoryInjection(input: MemoryInjectionInput): MemoryInjection {
  const key = injectionKeyForDirectory(input.directory);
  const empty: MemoryInjection = { text: null, current: 0, related: 0, key };
  if (typeof input.indexContent !== "string" || input.indexContent.trim() === "") return empty;

  const doc = parseMemoryIndex(input.indexContent);
  const slug = input.slug.trim();
  const current = slug === "" ? undefined : doc.sections.find((s) => s.slug === slug);
  const currentEntries = current?.entries ?? [];
  const related =
    key === null ? [] : selectRelatedEntries(doc, slug, key, input.readCard, input.limit ?? RELATED_INJECT_LIMIT);

  if (currentEntries.length === 0 && related.length === 0) return empty;

  const chunks: string[] = [];
  if (currentEntries.length > 0) chunks.push(renderSection(slug, currentEntries));
  if (related.length > 0) chunks.push(renderSection(`related: ${key}`, related));
  return { text: chunks.join("\n\n"), current: currentEntries.length, related: related.length, key };
}

/** 把索引里的 `~/…` 卡片路径还原成绝对路径（索引存的是可移植写法）。 */
export function expandHomePath(filePath: string): string {
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/")) return join(homedir(), filePath.slice(2));
  return filePath;
}

/**
 * `buildMemoryInjection` 的读盘壳：卡片正文与索引都走同一个 `InjectionSourceCache`
 * （stat 缓存 → 每 step 只 stat，不重复 readFileSync）。
 */
export function memoryInjectionForScope(
  cache: InjectionSourceCache,
  indexContent: string | null | undefined,
  slug: string,
  directory: string | null | undefined,
): MemoryInjection {
  return buildMemoryInjection({
    indexContent,
    slug,
    directory,
    readCard: (filePath) => cache.read(expandHomePath(filePath)),
  });
}

/**
 * 两个宿主共用的一份读法：协议 + 画像 + （当前节 + related）。
 * 注入范围不再分叉（OpenCode 从整份索引收敛到本节 + related，DSH 从单节放宽到 + related）。
 */
export function readInjectionSourcesForSlug(
  cache: InjectionSourceCache,
  slug: string,
  directory: string | null | undefined,
): InjectionSources {
  return {
    protocol: cache.read(getProtocolPath()),
    user: cache.read(getUserMdPath()),
    memory: memoryInjectionForScope(cache, cache.read(getMemoryIndexPath()), slug, directory).text,
  };
}
