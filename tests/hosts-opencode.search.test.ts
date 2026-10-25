// OpenCode 宿主 `memory_search` 工具单测（#29）。
//
// 为什么单独建文件：`src/hosts/opencode/index.ts` 过去没有插件级测试（工具回执只在 DSH 侧由
// `hosts-dsh.test.ts` 覆盖）。这里用最小 ctx stub 直调 default 插件的 `setup()`，把
// `ctx.tool.transform` 注册出来的工具抓下来直接 execute——不连真宿主。
//
// 覆盖 issue #29 要求的三类回执：命中（含跨节命中）/ 空结果 / core 抛错（绝不抛回宿主），
// 外加两条回归面：20 条上限、缺省 slug 派生失败（空 cwd）退化为全库。
//
// 隔离：homedir 指向本文件自己的临时目录（规则 14：每文件独立 tmp home），绝不碰真实 ~/.opencode。
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin";

const TEST_HOME = vi.hoisted(() => `/tmp/opencode-memx-search-test-home-${process.pid}`);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => TEST_HOME };
});

// core 抛错分支要可控：命中 / 空结果走**真实**实现（真检索），只有开关打开时才抛。
const searchFault = vi.hoisted(() => ({ throw: false }));

vi.mock("../src/core/store/memory-search.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/store/memory-search.ts")>();
  return {
    ...actual,
    searchMemories: (keyword: string, slug?: string) => {
      if (searchFault.throw) throw new Error("boom");
      return actual.searchMemories(keyword, slug);
    },
  };
});

const plugin = (await import("../src/hosts/opencode/index.ts")).default;

const DIR = join(TEST_HOME, ".opencode");
const PROJ_SLUG = "work-proj-a";
const OTHER_SLUG = "agent-mobile";

interface ToolDef {
  name: string;
  description: string;
  input?: { required?: string[]; properties?: Record<string, unknown> };
  options?: { codemode?: boolean };
  execute: (input: unknown, ctx: unknown) => Promise<{ content?: unknown }>;
}

interface Harness {
  tools: ToolDef[];
  cleanup: () => Promise<void> | void;
}

/** 假事件流：只等 abort（setup 的事件循环是后台任务，测试里不需要真事件）。 */
function stubEventStream(signal: AbortSignal): AsyncIterable<{ type: string; data?: unknown }> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<{ type: string; data?: unknown }>> {
          return new Promise((resolve) => {
            if (signal.aborted) {
              resolve({ done: true, value: undefined });
              return;
            }
            signal.addEventListener("abort", () => resolve({ done: true, value: undefined }), { once: true });
          });
        },
      };
    },
  };
}

async function startPlugin(directory: string): Promise<Harness> {
  const tools: ToolDef[] = [];
  const noop = async (): Promise<void> => {};

  const ctx = {
    location: { directory },
    options: {},
    storage: { get: async () => undefined, set: noop, remove: noop },
    event: { subscribe: ({ signal }: { signal: AbortSignal }) => stubEventStream(signal) },
    session: {
      hook: async () => ({ dispose: noop }),
      context: async () => [],
    },
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          add: (tool: ToolDef) => {
            tools.push(tool);
          },
          list: () => tools,
          get: (id: string) => tools.find((tool) => tool.name === id),
          update: () => {},
          remove: () => {},
          namespace: () => {},
        });
        return { dispose: noop };
      },
    },
  } as unknown as Plugin.Context;

  const cleanup = await plugin.setup(ctx);
  return { tools, cleanup: cleanup ?? (() => {}) };
}

/** 工具调用上下文：只有 memory_write 会读 sessionID，其余字段凑齐形状即可。 */
const toolCtx = {
  sessionID: "ses_1",
  agent: "build",
  messageID: "msg_1",
  id: "call_1",
  signal: new AbortController().signal,
  progress: async () => {},
};

/** 先走 memory_write 造一条真实记忆（文件 + 索引都落盘），再让被测工具去搜。 */
async function seedViaWrite(h: Harness, text: string, name: string): Promise<void> {
  const write = h.tools.find((tool) => tool.name === "memory_write")!;
  const result = (await write.execute({ text, name }, toolCtx)) as { content?: unknown };
  expect(String(result.content)).toContain("已记住");
}

function searchTool(tools: ToolDef[]): ToolDef {
  return tools.find((tool) => tool.name === "memory_search")!;
}

async function search(h: Harness, input: unknown): Promise<string> {
  const value = await searchTool(h.tools).execute(input, toolCtx);
  return String(value.content);
}

beforeAll(() => {
  mkdirSync(DIR, { recursive: true });
});

beforeEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  searchFault.throw = false;
});

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("memory_search 注册面", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startPlugin("/work/proj-a");
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it("注册进工具面，keyword 必填、slug 可选，并声明 codemode:false", () => {
    const tool = searchTool(h.tools);
    expect(tool).toBeTruthy();
    expect(tool.input?.required).toEqual(["keyword"]);
    expect(Object.keys(tool.input?.properties ?? {})).toEqual(["keyword", "slug"]);
    // 与 memory_write 同一补丁：不被 codemode 包成 execute，否则 App 按工具名认不出
    expect(tool.options).toEqual({ codemode: false });
  });
});

describe("memory_search 回执（三类）", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startPlugin("/work/proj-a");
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it("命中：返回 slug/file:line — 命中行，缺省只查当前项目", async () => {
    await seedViaWrite(h, "BFF CORS 只放行 9928 三个 origin", "CORS 白名单");

    const content = await search(h, { keyword: "bff cors" });
    expect(content).toMatch(new RegExp(`^${PROJ_SLUG}/[^:\\n]+:\\d+ — `));
    expect(content).toContain("BFF CORS 只放行 9928 三个 origin");
  });

  it("命中：显式 slug 能搜到当前节之外的条目（跨节可发现性）", async () => {
    const otherDir = join(DIR, "projects", OTHER_SLUG, ".mem");
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(otherDir, "feedback_pnpm.md"), "# pnpm 纪律\n- 包管理器只用 pnpm，禁用 npm\n", "utf-8");

    // 缺省 slug = 当前目录（work-proj-a）→ 看不到别的节
    expect(await search(h, { keyword: "包管理器只用" })).toBe("[memx] 未匹配：包管理器只用");

    const content = await search(h, { keyword: "包管理器只用", slug: OTHER_SLUG });
    expect(content).toMatch(new RegExp(`^${OTHER_SLUG}/feedback_pnpm\\.md:\\d+ — `));
    expect(content).toContain("包管理器只用 pnpm");
  });

  it("空结果：回执是「[memx] 未匹配：<keyword>」", async () => {
    await seedViaWrite(h, "BFF CORS 只放行 9928 三个 origin", "CORS 白名单");
    expect(await search(h, { keyword: "根本不存在的关键词" })).toBe("[memx] 未匹配：根本不存在的关键词");
  });

  it("core 抛错：转成失败回执，绝不把异常抛给宿主", async () => {
    searchFault.throw = true;
    const content = await search(h, { keyword: "任意" });
    expect(content).toBe("[memx] memory_search 失败：Error: boom");
  });

  it("最多 20 条：超出部分折成「… 另有 N 处未显示」", async () => {
    const memDir = join(DIR, "projects", PROJ_SLUG, ".mem");
    mkdirSync(memDir, { recursive: true });
    const lines = ["# 大批量", ...Array.from({ length: 25 }, (_, i) => `- BULKKEY 第 ${i + 1} 行`)];
    writeFileSync(join(memDir, "project_bulk.md"), lines.join("\n") + "\n", "utf-8");

    const content = await search(h, { keyword: "bulkkey" });
    const rendered = content.split("\n");
    expect(rendered).toHaveLength(21);
    expect(rendered[20]).toBe("… 另有 5 处未显示");
  });

  it("缺省 slug 派生失败（空 cwd）→ 退化为全库检索，而不是报错", async () => {
    await seedViaWrite(h, "BFF CORS 只放行 9928 三个 origin", "CORS 白名单");

    const all = await startPlugin("");
    try {
      const content = await search(all, { keyword: "bff cors" });
      expect(content).toMatch(new RegExp(`^${PROJ_SLUG}/[^:\\n]+:\\d+ — `));
      expect(content).toContain("BFF CORS 只放行 9928 三个 origin");
    } finally {
      await all.cleanup();
    }
  });
});
