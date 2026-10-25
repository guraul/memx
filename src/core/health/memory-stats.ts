// 记忆规模统计（#30）：注入顶距 / 卡片龄期 / `.trash` 计数——**只读**。
// 不写记忆文件、不联网、退出码无关：只回答"离撞顶还有多远、卡片有多老、垃圾堆了多厚"。
//
// 为什么盯 25KB 而不是行数：注入是**每块** 200 行 / 25KB 双上限、先到先算。实测 MEMORY.md
// 84 行就 16KB（≈195B/行），行数还远、字节先撞；按行数看会漏掉真正的临界点。
//
// 零宿主依赖：只碰 node:fs / node:os / node:path，以及 core 自己的索引解析。

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { INJECT_MAX_BYTES } from "../injection.ts";
import { parseMemoryIndex } from "../store/memory-md.ts";

/** 顶距低于该比例（占单块上限）即报警。20% × 25KB = 5KB ≈ 18 条（283B/条），够一轮清理的反应时间。 */
export const HEADROOM_ALERT_RATIO = 0.2;

/** 报警码（`pnpm alerts:clear --code=HEADROOM_LOW` 销账）。 */
export const HEADROOM_ALERT_CODE = "HEADROOM_LOW";

export interface SectionHeadroom {
  slug: string;
  entries: number;
  /** 该节在文件里的行（节头 + 指针 + extras）的 UTF-8 字节数 */
  bytes: number;
  kb: number;
  /** 占单块上限的百分比（可 >100：单节本身就能撑爆一整块） */
  percent: number;
}

export interface IndexHeadroom {
  maxBytes: number;
  /** 整个索引文件的字节数（= 注入时的原始块，含 preamble / 面包屑行） */
  totalBytes: number;
  totalKb: number;
  usedPercent: number;
  /** 剩余顶距占上限的百分比（100 - usedPercent，可为负） */
  headroomPercent: number;
  totalEntries: number;
  sections: SectionHeadroom[];
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function percentOf(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return round1((part / whole) * 100);
}

/**
 * 按节统计索引占用与顶距。**纯函数**（内容由调用方读入），便于单测覆盖空节 / 超大节。
 *
 * `maxBytes` 默认取注入侧常量 `INJECT_MAX_BYTES`（25KB），与真实闸门同源——
 * 不要在这里写死 25600，否则注入上限一改，面板就会撒谎。
 */
export function indexHeadroom(content: string, maxBytes: number = INJECT_MAX_BYTES): IndexHeadroom {
  const doc = parseMemoryIndex(content);
  const sections: SectionHeadroom[] = doc.sections.map((section) => {
    // 用磁盘上的原始行计字节（指针 `raw` + extras 原样），而不是重新序列化：
    // 序列化会补/删空行，面板要反映的是"文件真有这么大"。
    const lines = [`## ${section.slug}`, ...section.entries.map((e) => e.raw), ...(section.extras ?? [])];
    const bytes = Buffer.byteLength(lines.join("\n"), "utf-8");
    return {
      slug: section.slug,
      entries: section.entries.length,
      bytes,
      kb: round1(bytes / 1024),
      percent: percentOf(bytes, maxBytes),
    };
  });

  const totalBytes = Buffer.byteLength(content, "utf-8");
  const usedPercent = percentOf(totalBytes, maxBytes);
  return {
    maxBytes,
    totalBytes,
    totalKb: round1(totalBytes / 1024),
    usedPercent,
    headroomPercent: round1(100 - usedPercent),
    totalEntries: sections.reduce((sum, s) => sum + s.entries, 0),
    sections,
  };
}

/** 顶距不足 → 返回一条 critical 报警；否则 null。纯函数，写账本由调用方决定。 */
export function headroomAlert(
  headroom: IndexHeadroom,
): { level: "critical"; code: string; message: string } | null {
  // 用**未取整**的原始字节比，不用面板上的 headroomPercent（已四舍五入到 0.1）：
  // 19.96% 取整成 20.0 就会漏报，阈值边界必须精确。
  // 1e-9 容差：800/1000 会算出 0.19999999999999996，恰好 20% 不能误报成 19.99%。
  const ratio = headroom.maxBytes > 0 ? 1 - headroom.totalBytes / headroom.maxBytes : 1;
  if (ratio >= HEADROOM_ALERT_RATIO - 1e-9) return null;
  // 消息里**不放具体数字**：数字每次都变，按 code+message 去重就永远去不掉，账本会被同一事实刷满。
  // 具体百分比看 doctor 面板。
  return {
    level: "critical",
    code: HEADROOM_ALERT_CODE,
    message: "MEMORY.md 注入顶距低于 20%（25KB 单块上限），需要清理索引或改按节注入（#32）",
  };
}

export const AGE_BUCKET_KEYS = ["0-7d", "8-30d", "31-90d", "90d+", "unknown"] as const;
export type AgeBucketKey = (typeof AGE_BUCKET_KEYS)[number];

const AGE_BUCKET_LABELS: Record<AgeBucketKey, string> = {
  "0-7d": "≤7天",
  "8-30d": "8-30天",
  "31-90d": "31-90天",
  "90d+": ">90天",
  unknown: "未知",
};

export interface CardAgeBucket {
  key: AgeBucketKey;
  label: string;
  count: number;
}

export interface CardAgeReport {
  total: number;
  buckets: CardAgeBucket[];
}

export interface TrashDirCount {
  slug: string;
  files: number;
}

export interface TrashReport {
  total: number;
  dirs: TrashDirCount[];
}

interface CardFile {
  path: string;
}

/** `~/.opencode/projects/<slug>/.mem/*.md`（含空 slug 遗留的 `projects/.mem/`；跳过 `.trash` 与 tmp）。 */
function listCardFiles(): CardFile[] {
  const projectsDir = join(homedir(), ".opencode", "projects");
  if (!existsSync(projectsDir)) return [];

  const cards: CardFile[] = [];
  for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // 空 slug 遗留（`projects/.mem/`，issue #36）：`.mem` 本身就是卡片目录，不是 slug 目录
    const memDir = entry.name === ".mem" ? join(projectsDir, ".mem") : join(projectsDir, entry.name, ".mem");
    if (!existsSync(memDir)) continue;
    for (const file of readdirSync(memDir, { withFileTypes: true })) {
      // 点开头即排除：`.trash/`（目录）与 `.tmp.*` 残骸都不算卡片
      if (!file.isFile() || !file.name.endsWith(".md") || file.name.startsWith(".")) continue;
      cards.push({ path: join(memDir, file.name) });
    }
  }
  return cards;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

/** 只认 frontmatter 块内的 `created:`；缺失/不可解析都返回 null。
 *  **绝不用 mtime 兜底**：update 会重置 mtime（sync pull 的 copyFileSync 同理），
 *  用 mtime 会把"刚更新过的老卡"显示成新卡，龄期分布直接失真。 */
function readCreated(content: string): string | null {
  const block = content.match(FRONTMATTER_RE)?.[1];
  if (!block) return null;
  return block.match(/^created:\s*(\S+)\s*$/m)?.[1] ?? null;
}

function bucketOf(ageDays: number | null): AgeBucketKey {
  if (ageDays === null) return "unknown";
  if (ageDays <= 7) return "0-7d";
  if (ageDays <= 30) return "8-30d";
  if (ageDays <= 90) return "31-90d";
  return "90d+";
}

/**
 * 卡片龄期分布（按 frontmatter `created` 的 UTC 日期算整天）。
 * 缺 `created` 或值不可解析 → `unknown` 桶（老卡就是这样：`created` 是后加的字段）。
 * 坏日期同样归未知，不单独报错：doctor 是面板，不是校验器。
 */
export function cardAgeBuckets(now: Date = new Date()): CardAgeReport {
  const counts: Record<AgeBucketKey, number> = { "0-7d": 0, "8-30d": 0, "31-90d": 0, "90d+": 0, unknown: 0 };
  let total = 0;

  for (const card of listCardFiles()) {
    total++;
    let created: string | null = null;
    try {
      created = readCreated(readFileSync(card.path, "utf-8"));
    } catch {
      created = null; // 读不了 = 龄期不可知，不猜
    }
    const ts = created === null ? Number.NaN : Date.parse(created);
    // 未来时间（时钟回拨/手写错日期）按 0 天算，不单独开桶
    const ageDays = Number.isNaN(ts) ? null : Math.max(0, Math.floor((now.getTime() - ts) / 86400e3));
    counts[bucketOf(ageDays)]++;
  }

  return {
    total,
    buckets: AGE_BUCKET_KEYS.map((key) => ({ key, label: AGE_BUCKET_LABELS[key], count: counts[key] })),
  };
}

/**
 * `.trash` 文件计数：软删残留的规模。**只展示，不报警**——它是可恢复的历史，不是故障；
 * 突然变小反而可能是有人手工清过。口径 = `.mem/.trash/` 下的普通文件数（子目录不计）。
 */
export function trashCount(): TrashReport {
  const projectsDir = join(homedir(), ".opencode", "projects");
  if (!existsSync(projectsDir)) return { total: 0, dirs: [] };

  const dirs: TrashDirCount[] = [];
  let total = 0;
  for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const memDir = entry.name === ".mem" ? join(projectsDir, ".mem") : join(projectsDir, entry.name, ".mem");
    const trashDir = join(memDir, ".trash");
    if (!existsSync(trashDir)) continue;
    const slug = entry.name === ".mem" ? "(空 slug 遗留)" : entry.name;
    let files = 0;
    try {
      files = readdirSync(trashDir, { withFileTypes: true }).filter((f) => f.isFile()).length;
    } catch {
      continue;
    }
    if (files === 0) continue;
    dirs.push({ slug, files });
    total += files;
  }
  // 面板输出要稳定（readdir 顺序随文件系统），按 slug 排
  dirs.sort((a, b) => a.slug.localeCompare(b.slug));
  return { total, dirs };
}

/** doctor 面板文本（纯函数，好测）。 */
export function formatMemoryStatsPanel(
  headroom: IndexHeadroom,
  ages: CardAgeReport,
  trash: TrashReport,
): string {
  const maxKb = round1(headroom.maxBytes / 1024);
  const lines = [
    `memory index: ${headroom.totalKb}KB / ${maxKb}KB（已用 ${headroom.usedPercent}%，顶距 ${headroom.headroomPercent}%；` +
      `阈值 <${HEADROOM_ALERT_RATIO * 100}% 触发 ${HEADROOM_ALERT_CODE}）`,
  ];

  if (headroom.sections.length === 0) {
    lines.push("  （无节）");
  } else {
    for (const s of headroom.sections) {
      lines.push(`  ${s.slug}: ${s.entries} 条, ${s.kb}KB, ${s.percent}% of ${maxKb}KB`);
    }
  }

  const ageText = ages.buckets.map((b) => `${b.label}=${b.count}`).join(" ");
  lines.push(`card age: ${ageText}（共 ${ages.total} 张，按 frontmatter created；缺失计未知，不用 mtime）`);

  const detail = trash.dirs.map((d) => `${d.slug}=${d.files}`).join(" ");
  lines.push(`trash: ${trash.total} 个文件${detail === "" ? "" : `（${detail}）`}`);
  return lines.join("\n");
}
