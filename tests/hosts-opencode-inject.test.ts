// OpenCode 宿主「注入 = 当前节 + related」接线测试（#32）。
//
// 为什么单独建文件：注入逻辑本身在 core（`buildMemoryInjection`）已有单测，这里只钉**接线**——
// `ctx.location.directory` 有没有真的传给 `readInjectionSourcesForSlug`、整份索引有没有真的
// 收敛成「本节 + related」。接线错了的症状是静默的（模型拿不到跨节记忆，或者仍然被整份索引
// 挤占 context），所以用一个最小 ctx stub 直接抓 `session.hook("context", …)` 的回调来打。
//
// 隔离：homedir 指向本文件自己的临时目录（规则 14：每文件独立 tmp home）。
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin";

const TEST_HOME = vi.hoisted(() => `/tmp/opencode-memx-inject-test-home-${process.pid}`);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => TEST_HOME };
});

const plugin = (await import("../src/hosts/opencode/index.ts")).default;

const DIR = join(TEST_HOME, ".opencode");
const CWD = "/Users/gubin/workspace/memx";

interface HookEvent {
  sessionID: string;
  agent?: string;
  system: Array<{ type: "text"; text: string }>;
  options: Record<string, unknown>;
}

interface Harness {
  run: (event: HookEvent) => void;
  cleanup: () => Promise<void> | void;
}

/** 假事件流：只等 abort（setup 的事件循环是后台任务，这里不需要真事件）。 */
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
  const noop = async (): Promise<void> => {};
  let hook: ((event: HookEvent) => void) | null = null;

  const ctx = {
    location: { directory },
    options: {},
    storage: { get: async () => undefined, set: noop, remove: noop },
    event: { subscribe: ({ signal }: { signal: AbortSignal }) => stubEventStream(signal) },
    session: {
      hook: async (name: string, callback: (event: HookEvent) => void) => {
        if (name === "context") hook = callback;
        return { dispose: noop };
      },
      context: async () => [],
    },
    tool: {
      transform: async () => ({ dispose: noop }),
    },
  } as unknown as Plugin.Context;

  const cleanup = await plugin.setup(ctx);
  // setup 里注册 hook 是同步等价的（await 一次 microtask 即可就绪）
  await Promise.resolve();
  return {
    run: (event) => {
      if (hook === null) throw new Error("context hook 未注册");
      hook(event);
    },
    cleanup: cleanup ?? (() => {}),
  };
}

beforeAll(() => {
  mkdirSync(DIR, { recursive: true });
});

beforeEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, "memx-protocol.md"), "PROTOCOL-BODY", "utf-8");
  writeFileSync(join(DIR, "USER.md"), "USER-BODY", "utf-8");
  writeFileSync(
    join(DIR, "MEMORY.md"),
    [
      "## Users-gubin-workspace-memx",
      `- [本项目](${join(DIR, "projects", "Users-gubin-workspace-memx", ".mem", "own.md")}) - 本项目专属钩子`,
      "",
      "## Users-gubin-workspace-agent-mobile",
      `- [跨节](${join(DIR, "projects", "Users-gubin-workspace-agent-mobile", ".mem", "cross.md")}) - memx 注入通道实况`,
      `- [无关](${join(DIR, "projects", "Users-gubin-workspace-agent-mobile", ".mem", "other.md")}) - 只有 homebase 相关`,
      "",
    ].join("\n"),
    "utf-8",
  );
});

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const event = (): HookEvent => ({
  sessionID: "ses_1",
  agent: "build",
  system: [{ type: "text", text: "HOST-SYSTEM" }],
  options: {},
});

describe("OpenCode 注入接线 — 当前节 + related", () => {
  it("cwd 末段命中其它节：追加的内容里既有本节也有 related", async () => {
    const h = await startPlugin(CWD);
    const e = event();
    h.run(e);
    await h.cleanup();

    const text = e.system.map((p) => p.text).join("\n");
    expect(e.system[0]!.text).toBe("HOST-SYSTEM");
    expect(text).toContain("PROTOCOL-BODY");
    expect(text).toContain("USER-BODY");
    expect(text).toContain("## Users-gubin-workspace-memx");
    expect(text).toContain("本项目专属钩子");
    expect(text).toContain("## related: memx");
    expect(text).toContain("memx 注入通道实况");
    // 不再注入整份索引：别的节里与本项目无关的条目一条都不进
    expect(text).not.toContain("只有 homebase 相关");
  });

  it("同一会话两次 hook → 字节完全相同（每 step 触发也不能抖）", async () => {
    const h = await startPlugin(CWD);
    const first = event();
    const second = event();
    h.run(first);
    h.run(second);
    await h.cleanup();
    expect(second.system.map((p) => p.text)).toEqual(first.system.map((p) => p.text));
  });

  it("目录取不到（空串）→ 只注入本节，不猜 related", async () => {
    const h = await startPlugin("");
    const e = event();
    h.run(e);
    await h.cleanup();

    const text = e.system.map((p) => p.text).join("\n");
    expect(text).not.toContain("## related");
    expect(text).not.toContain("memx 注入通道实况");
  });
});
