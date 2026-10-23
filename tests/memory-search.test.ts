// core 记忆检索（原 mem CLI 的 `cmdSearch` 上提）单测。
//
// 隔离：句柄指向本文件自己的临时 HOME（规则 14：每文件独立 tmp home），绝不碰真实 ~/.opencode。
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const HOME = "/tmp/memx-test-home-memory-search";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => HOME };
});

const { searchMemories } = await import("../src/core/store/memory-search.ts");

const DIR = join(HOME, ".opencode");
const SLUG_A = "work-proj-a";
const SLUG_B = "work-other";
const MEM_A = join(DIR, "projects", SLUG_A, ".mem");
const MEM_B = join(DIR, "projects", SLUG_B, ".mem");

const FILE_A = ["# 项目 A 记忆", "- BFF CORS 只放行 9928 三个 origin", "  memory-index-lock 小写行", ""].join("\n");
const FILE_B = ["# 别的项目", "这里也提到 bff cors，但不该被单 slug 检索命中", ""].join("\n");

beforeAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(MEM_A, { recursive: true });
  mkdirSync(MEM_B, { recursive: true });
  writeFileSync(join(MEM_A, "project_a.md"), FILE_A, "utf-8");
  writeFileSync(join(MEM_B, "project_b.md"), FILE_B, "utf-8");
  writeFileSync(
    join(DIR, "MEMORY.md"),
    [
      `## ${SLUG_A}`,
      `- [项目 A](${join(MEM_A, "project_a.md")}) - 本项目专属`,
      "",
      `## ${SLUG_B}`,
      `- [别的项目](${join(MEM_B, "project_b.md")}) - 不该串项目`,
      "",
    ].join("\n"),
    "utf-8",
  );
});

beforeEach(() => {
  // 每个用例从同一份夹具出发（有用例会临时加文件）
  writeFileSync(join(MEM_A, "project_a.md"), FILE_A, "utf-8");
  writeFileSync(join(MEM_B, "project_b.md"), FILE_B, "utf-8");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

describe("searchMemories · 命中", () => {
  it("命中返回 file + 行号（从 1 起）+ trim 后的命中行", () => {
    const hits = searchMemories("BFF CORS", SLUG_A);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({
      slug: SLUG_A,
      file: "project_a.md",
      line: 2,
      text: "- BFF CORS 只放行 9928 三个 origin",
    });
  });

  it("行号按真实文件行算（第 3 行命中就是 3）", () => {
    const hits = searchMemories("memory-index-lock", SLUG_A);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.line).toBe(3);
    expect(hits[0]!.text).toBe("memory-index-lock 小写行");
  });
});

describe("searchMemories · 不命中", () => {
  it("关键词不存在返回空数组（不抛）", () => {
    expect(searchMemories("这个词一定不存在-zzz", SLUG_A)).toEqual([]);
  });

  it("空关键词返回空数组（不把空串当通配）", () => {
    expect(searchMemories("", SLUG_A)).toEqual([]);
    expect(searchMemories("   ", SLUG_A)).toEqual([]);
  });

  it("指定不存在的 slug 返回空数组", () => {
    expect(searchMemories("BFF", "no-such-slug")).toEqual([]);
  });
});

describe("searchMemories · 范围", () => {
  it("不传 slug 时跨 slug 检索（两个项目都命中）", () => {
    const hits = searchMemories("bff cors");
    expect(hits.map((h) => h.slug).sort()).toEqual([SLUG_A, SLUG_B].sort());
  });

  it("传 slug 时只检索该项目", () => {
    const hits = searchMemories("bff cors", SLUG_B);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.slug).toBe(SLUG_B);
    expect(hits[0]!.file).toBe("project_b.md");
  });
});

describe("searchMemories · 大小写", () => {
  it("大小写不敏感：小写关键词命中大写正文", () => {
    expect(searchMemories("bff cors", SLUG_A)).toHaveLength(1);
  });

  it("大小写不敏感：大写关键词命中到小写正文", () => {
    const hits = searchMemories("MEMORY-INDEX-LOCK", SLUG_A);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.line).toBe(3);
  });
});
