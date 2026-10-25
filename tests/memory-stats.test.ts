import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  AGE_BUCKET_KEYS,
  HEADROOM_ALERT_CODE,
  cardAgeBuckets,
  formatMemoryStatsPanel,
  headroomAlert,
  indexHeadroom,
  trashCount,
} from "../src/core/health/memory-stats.ts";

const TEST_HOME = vi.hoisted(() => `/tmp/opencode-memx-memory-stats-${process.pid}`);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => TEST_HOME };
});

const PROJECTS = join(TEST_HOME, ".opencode", "projects");

beforeEach(() => {
  rmSync(PROJECTS, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const ENTRY_A = "- [a](~/.opencode/projects/alpha/.mem/a.md) - hook a";
const ENTRY_B = "- [b](~/.opencode/projects/alpha/.mem/b.md) - hook b";
const ENTRY_C = "- [c](~/.opencode/projects/beta/.mem/c.md) - hook c";

const INDEX = [
  "# Project Memory",
  "",
  "## alpha",
  ENTRY_A,
  ENTRY_B,
  "",
  "## beta",
  ENTRY_C,
  "",
].join("\n");

describe("indexHeadroom", () => {
  it("按节算条目数 / KB / 占比，总量按整份文件字节算", () => {
    const h = indexHeadroom(INDEX);
    expect(h.maxBytes).toBe(25 * 1024);
    expect(h.totalBytes).toBe(Buffer.byteLength(INDEX, "utf-8"));
    expect(h.totalEntries).toBe(3);
    expect(h.sections.map((s) => s.slug)).toEqual(["alpha", "beta"]);
    expect(h.sections[0]!.entries).toBe(2);
    expect(h.sections[0]!.bytes).toBe(Buffer.byteLength(`## alpha\n${ENTRY_A}\n${ENTRY_B}\n`, "utf-8"));
    expect(h.sections[1]!.entries).toBe(1);
    // 节间空行 + preamble 不计进节，但计进总量
    expect(h.sections[0]!.bytes + h.sections[1]!.bytes).toBeLessThan(h.totalBytes);
    expect(h.sections[0]!.percent).toBe(Math.round((h.sections[0]!.bytes / h.maxBytes) * 1000) / 10);
    expect(h.usedPercent).toBe(Math.round((h.totalBytes / h.maxBytes) * 1000) / 10);
    expect(h.headroomPercent).toBe(100 - h.usedPercent);
  });

  it("空文件：无节、零占用、顶距 100%", () => {
    const h = indexHeadroom("");
    expect(h.sections).toEqual([]);
    expect(h.totalBytes).toBe(0);
    expect(h.totalEntries).toBe(0);
    expect(h.usedPercent).toBe(0);
    expect(h.headroomPercent).toBe(100);
    expect(headroomAlert(h)).toBeNull();
  });

  it("空节（有节头无条目）仍然列出，条目数 0", () => {
    const h = indexHeadroom("## empty\n", 100);
    expect(h.sections).toHaveLength(1);
    expect(h.sections[0]).toMatchObject({ slug: "empty", entries: 0, bytes: 9 });
    expect(h.sections[0]!.percent).toBe(9);
  });

  it("超大节：占比可 >100%，顶距转负（已撞顶）", () => {
    const huge = `## big\n${"- [x](p) - y\n".repeat(100)}`;
    const h = indexHeadroom(huge, 1000);
    expect(h.sections[0]!.percent).toBeGreaterThan(100);
    expect(h.usedPercent).toBeGreaterThan(100);
    expect(h.headroomPercent).toBeLessThan(0);
    expect(headroomAlert(h)?.code).toBe(HEADROOM_ALERT_CODE);
  });

  it("maxBytes 可注入（与注入上限同源的默认值仍是 25KB）", () => {
    const content = "x".repeat(400);
    const h = indexHeadroom(content, 1000);
    expect(h.maxBytes).toBe(1000);
    expect(h.usedPercent).toBe(40);
    expect(h.headroomPercent).toBe(60);
  });
});

describe("20% 阈值边界", () => {
  it("顶距 19.9% → critical HEADROOM_LOW", () => {
    const h = indexHeadroom("x".repeat(801), 1000);
    expect(h.headroomPercent).toBe(19.9);
    const alert = headroomAlert(h);
    expect(alert).not.toBeNull();
    expect(alert!.level).toBe("critical");
    expect(alert!.code).toBe(HEADROOM_ALERT_CODE);
  });

  it("顶距恰好 20% → 不报（阈值是「低于」）", () => {
    const h = indexHeadroom("x".repeat(800), 1000);
    expect(h.headroomPercent).toBe(20);
    expect(headroomAlert(h)).toBeNull();
  });

  it("顶距 20.1% → 不报", () => {
    const h = indexHeadroom("x".repeat(799), 1000);
    expect(h.headroomPercent).toBe(20.1);
    expect(headroomAlert(h)).toBeNull();
  });

  it("报警 message 不随测得的百分比变化（否则按 code+message 去重永远失效）", () => {
    const a = headroomAlert(indexHeadroom("x".repeat(810), 1000))!;
    const b = headroomAlert(indexHeadroom("x".repeat(1000), 1000))!;
    expect(a.message).toBe(b.message);
    expect(a.message).not.toContain("19%");
  });
});

function writeCard(slug: string, filename: string, opts: { created?: string | undefined } = {}): void {
  const dir = join(PROJECTS, slug, ".mem");
  mkdirSync(dir, { recursive: true });
  const fm = ["---", `name: ${filename}`, "description: d", "type: project"];
  if (opts.created !== undefined) fm.push(`created: ${opts.created}`);
  fm.push("updated: 2026-10-25", "---", "", "body");
  writeFileSync(join(dir, filename), fm.join("\n") + "\n", "utf-8");
}

const NOW = new Date("2026-10-25T00:00:00Z");

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 86400e3).toISOString().slice(0, 10);
}

describe("cardAgeBuckets", () => {
  it("按 created 分桶，边界归到左侧桶（7/8、30/31、90/91）", () => {
    for (const n of [7, 8, 30, 31, 90, 91]) {
      writeCard("boundary", `c${n}.md`, { created: daysAgo(n) });
    }
    const r = cardAgeBuckets(NOW);
    expect(r.total).toBe(6);
    expect(r.buckets.map((b) => [b.key, b.count])).toEqual([
      ["0-7d", 1],
      ["8-30d", 2],
      ["31-90d", 2],
      ["90d+", 1],
      ["unknown", 0],
    ]);
  });

  it("缺 created → 未知桶（不拿 mtime 兜底），坏日期同样未知", () => {
    writeCard("old", "no-created.md");
    writeCard("old", "bad-created.md", { created: "not-a-date" });
    // mtime 就是现在：若用 mtime 兜底，这两张会落进 ≤7天 桶
    const r = cardAgeBuckets(NOW);
    const byKey = Object.fromEntries(r.buckets.map((b) => [b.key, b.count]));
    expect(byKey.unknown).toBe(2);
    expect(byKey["0-7d"]).toBe(0);
    expect(r.total).toBe(2);
  });

  it("未来日期（时钟回拨/手写错）按 0 天算，不单开桶", () => {
    writeCard("future", "future.md", { created: "2027-01-01" });
    const byKey = Object.fromEntries(cardAgeBuckets(NOW).buckets.map((b) => [b.key, b.count]));
    expect(byKey["0-7d"]).toBe(1);
    expect(byKey.unknown).toBe(0);
  });

  it("只统计 .mem/*.md：跳过 .trash、tmp 残骸与非 md 文件", () => {
    writeCard("s", "real.md", { created: daysAgo(1) });
    const memDir = join(PROJECTS, "s", ".mem");
    mkdirSync(join(memDir, ".trash"), { recursive: true });
    writeFileSync(join(memDir, ".trash", "real.md.1000"), "old", "utf-8");
    writeFileSync(join(memDir, "real.md.tmp.2000"), "tmp", "utf-8");
    writeFileSync(join(memDir, "notes.txt"), "x", "utf-8");
    expect(cardAgeBuckets(NOW).total).toBe(1);
  });

  it("桶集合固定且顺序稳定（面板不用猜）", () => {
    expect(cardAgeBuckets(NOW).buckets.map((b) => b.key)).toEqual([...AGE_BUCKET_KEYS]);
  });
});

describe("trashCount", () => {
  it("按 .mem/.trash 计普通文件数，目录不计；含空 slug 遗留目录", () => {
    const a = join(PROJECTS, "alpha", ".mem", ".trash");
    mkdirSync(a, { recursive: true });
    writeFileSync(join(a, "x.md.1"), "x", "utf-8");
    writeFileSync(join(a, "y.md.2"), "y", "utf-8");
    mkdirSync(join(a, "subdir"));

    const b = join(PROJECTS, "beta", ".mem", ".trash");
    mkdirSync(b, { recursive: true });
    writeFileSync(join(b, "z.md.3"), "z", "utf-8");

    // 空 slug 遗留：projects/.mem 本身就是卡片目录（#36）
    const legacy = join(PROJECTS, ".mem", ".trash");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "old.md.4"), "o", "utf-8");

    const r = trashCount();
    expect(r.total).toBe(4);
    expect(r.dirs).toEqual([
      { slug: "(空 slug 遗留)", files: 1 },
      { slug: "alpha", files: 2 },
      { slug: "beta", files: 1 },
    ]);
  });

  it("没有 projects 目录 / 空 trash → 0", () => {
    expect(trashCount()).toEqual({ total: 0, dirs: [] });
    mkdirSync(join(PROJECTS, "empty", ".mem", ".trash"), { recursive: true });
    expect(trashCount()).toEqual({ total: 0, dirs: [] });
  });
});

describe("formatMemoryStatsPanel", () => {
  it("打出顶距、各节、龄期、trash 四类行", () => {
    writeCard("alpha", "a.md", { created: daysAgo(2) });
    mkdirSync(join(PROJECTS, "alpha", ".mem", ".trash"), { recursive: true });
    writeFileSync(join(PROJECTS, "alpha", ".mem", ".trash", "a.md.1"), "x", "utf-8");

    const panel = formatMemoryStatsPanel(
      indexHeadroom(INDEX),
      cardAgeBuckets(NOW),
      trashCount(),
    );
    expect(panel).toContain("memory index:");
    expect(panel).toContain(`${indexHeadroom(INDEX).usedPercent}%`);
    expect(panel).toContain("alpha: 2 条");
    expect(panel).toContain("beta: 1 条");
    expect(panel).toContain("card age:");
    expect(panel).toContain("≤7天=1");
    expect(panel).toContain("trash: 1 个文件（alpha=1）");
  });

  it("无节时给出占位，不抛", () => {
    const panel = formatMemoryStatsPanel(indexHeadroom(""), cardAgeBuckets(NOW), trashCount());
    expect(panel).toContain("（无节）");
    expect(panel).toContain("trash: 0 个文件");
  });
});
