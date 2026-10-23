// DSH 宿主适配器的纯逻辑单测（#17 B）：不连真宿主，用最小 stub ctx。
//
// 覆盖 issue D 节要求的五条：slug/注入内容 + 字节恒定、轮末节流、本轮已有写入时跳过、
// 配置为空时跳过（不报错）、工具回执文案。另有两条补充：注入的是"当前项目小节"
// （别的项目条目不进来）、memory_write 真的落到 canonical 记忆库。
//
// 隔离：句柄指向本文件自己的临时 HOME（规则 14：每文件独立 tmp home），绝不碰真实 ~/.opencode。
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const HOME = "/tmp/opencode-memx-test-home-dsh";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => HOME };
});

const { apply, Config, name, inject } = await import("../src/hosts/dsh/index.ts");
const { name: importedName } = await import("../src/hosts/dsh/index.ts");

import type {
  DshAgent,
  DshContext,
  DshGenerateOptions,
  DshPromptSection,
  DshSessionEvent,
  DshToolDefinition,
} from "../src/hosts/dsh/types.ts";

const DIR = join(HOME, ".opencode");
const PROJ_SLUG = "work-proj-a";
const OTHER_SLUG = "work-other";

/** 一份合法 MEMORY_SIGNAL（project 类型必须带 why/how_to_apply）。 */
const SIGNAL =
  '<!-- MEMORY_SIGNAL: {"type":"project","name":"n","description":"d","content":"c","why":"w","how_to_apply":"h","evidence":"e","confidence":"high","source":"explicit"} -->';

interface Harness {
  ctx: DshContext;
  sections: DshPromptSection[];
  tools: DshToolDefinition[];
  listeners: Array<(session: { id: string }, event: DshSessionEvent) => void>;
  calls: DshGenerateOptions[];
  injected: unknown[];
  logs: string[];
  agent: DshAgent;
  emit(type: string, turn?: number, extra?: Record<string, unknown>): void;
  /** 改宿主兜底目录（模拟"没有会话目录记录"时 cwd 变化）。 */
  setDefaultDirectory(dir: string): void;
}

function makeHarness(options?: {
  agentOptions?: { provider?: string; model?: string } | undefined;
  llmText?: string;
  cwd?: string;
  /** 按会话 id 指定 cwd（多会话测试用）。 */
  cwdBySession?: Record<string, string>;
  defaultDirectory?: string;
}): Harness {
  const sections: DshPromptSection[] = [];
  const tools: DshToolDefinition[] = [];
  const listeners: Array<(session: { id: string }, event: DshSessionEvent) => void> = [];
  const calls: DshGenerateOptions[] = [];
  const injected: unknown[] = [];
  const logs: string[] = [];
  let defaultDirectory = options?.defaultDirectory ?? "/fallback";

  const agent: DshAgent = {
    id: "sess-1",
    session: { id: "sess-1" },
    ...(options?.agentOptions !== undefined ? { options: options.agentOptions } : {}),
    inject: (message: unknown) => {
      injected.push(message);
    },
  };

  const ctx: DshContext = {
    systemPrompt: {
      section: (section) => {
        sections.push(section);
        return () => {};
      },
    },
    tools: {
      register: (definition) => {
        tools.push(definition);
        return () => {};
      },
    },
    workingDirectory: {
      get: (session) => options?.cwdBySession?.[session.id] ?? options?.cwd ?? "/work/proj-a",
      get defaultDirectory() {
        return defaultDirectory;
      },
    },
    llm: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stream: (async function* (opts: DshGenerateOptions): any {
        calls.push(opts);
        yield { type: "text-delta", text: options?.llmText ?? "[]" };
      }) as unknown as DshContext["llm"]["stream"],
    },
    agents: { get: (id) => (id === agent.id ? agent : undefined) },
    on: (_event, listener) => {
      listeners.push(listener);
      return () => {};
    },
    logger: {
      warn: (message: unknown) => {
        logs.push(String(message));
      },
    },
  };

  return {
    ctx,
    sections,
    tools,
    listeners,
    calls,
    injected,
    logs,
    agent,
    emit(type, turn, extra) {
      const event: DshSessionEvent = {
        type,
        data: { ...(turn !== undefined ? { turn } : {}), ...(extra ?? {}) },
      };
      for (const listener of listeners) listener(agent.session, event);
    },
    setDefaultDirectory(dir) {
      defaultDirectory = dir;
    },
  };
}

/** 驱动完整一轮：turn/start → assistant/message → turn/end。 */
function emitTurn(h: Harness, turn: number, assistant: string): void {
  h.emit("turn/start", turn);
  h.emit("assistant/message", turn, {
    step: 1,
    message: { role: "assistant", content: [{ type: "text", text: assistant }] },
  });
  h.emit("turn/end", turn, { reason: "success" });
}

const settle = (ms = 120): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(() => {
  mkdirSync(DIR, { recursive: true });
});

beforeEach(() => {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, "memx-protocol.md"), "PROTOCOL-BODY", "utf-8");
  writeFileSync(join(DIR, "USER.md"), "USER-BODY", "utf-8");
  writeFileSync(
    join(DIR, "MEMORY.md"),
    [
      `## ${PROJ_SLUG}`,
      `- [项目记忆](${join(DIR, "projects", PROJ_SLUG, ".mem", "project_a.md")}) - 本项目专属钩子`,
      "",
      `## ${OTHER_SLUG}`,
      `- [别的项目](${join(DIR, "projects", OTHER_SLUG, ".mem", "project_b.md")}) - 不该出现`,
      "",
    ].join("\n"),
    "utf-8",
  );
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

describe("插件契约", () => {
  it("导出 name / inject / Config / apply，name 为 memx", () => {
    expect(name).toBe("memx");
    expect(importedName).toBe("memx");
    expect(typeof apply).toBe("function");
    expect([...inject]).toContain("systemPrompt");
    expect([...inject]).toContain("tools");
    expect([...inject]).toContain("llm");
  });

  it("Config 是 standard-schema：缺省合法、类型错给 issues、volatile 四个字段全在", () => {
    expect(Config["~standard"].validate({})).toEqual({ value: {} });
    expect(Config["~standard"].validate({ provider: "p", model: "m" })).toEqual({
      value: { provider: "p", model: "m" },
    });
    const bad = Config["~standard"].validate({ provider: 1 }) as { issues?: unknown[] };
    expect(Array.isArray(bad.issues)).toBe(true);
    expect([...Config.volatileKeys]).toEqual(["provider", "model", "autoRefine", "throttleMinutes"]);
  });

  it("Config 校验 autoRefine：布尔通过、非布尔给 issues", () => {
    expect(Config["~standard"].validate({ autoRefine: false })).toEqual({ value: { autoRefine: false } });
    expect(Config["~standard"].validate({ autoRefine: true })).toEqual({ value: { autoRefine: true } });
    for (const bad of ["true", 1, 0, {}]) {
      const result = Config["~standard"].validate({ autoRefine: bad }) as { issues?: Array<{ path: string[] }> };
      expect(Array.isArray(result.issues)).toBe(true);
      expect(result.issues?.[0]?.path).toEqual(["autoRefine"]);
    }
  });
});

describe("注入（每会话一次、字节恒定）", () => {
  it("按 cwd 得到 slug，注入协议 + 画像 + 当前项目小节，别的小节不进来", () => {
    const h = makeHarness();
    apply(h.ctx, {});

    expect(h.sections).toHaveLength(1);
    const section = h.sections[0]!;
    expect(section.name).toBe("memx:memory");
    expect(section.interpolate).toBe(false);

    const text = (section.text as (c: unknown) => string)({ agent: h.agent });
    expect(text).toContain("PROTOCOL-BODY");
    expect(text).toContain("USER-BODY");
    expect(text).toContain(`## ${PROJ_SLUG}`);
    expect(text).toContain("本项目专属钩子");
    expect(text).not.toContain(OTHER_SLUG);
    expect(text).not.toContain("不该出现");
  });

  it("同一会话两次求值字节完全相同；文件后来变了也不重算（会话内恒定）", () => {
    const h = makeHarness();
    apply(h.ctx, {});
    const section = h.sections[0]!;
    const evaluate = section.text as (c: unknown) => string;

    const first = evaluate({ agent: h.agent });
    writeFileSync(join(DIR, "USER.md"), "USER-CHANGED-LATER", "utf-8");
    const second = evaluate({ agent: h.agent });

    expect(second).toBe(first);
    expect(second).not.toContain("USER-CHANGED-LATER");
  });

  it("换一个会话（另一个 agent）会重新求值，拿到新内容", () => {
    const h = makeHarness();
    apply(h.ctx, {});
    const evaluate = h.sections[0]!.text as (c: unknown) => string;
    const first = evaluate({ agent: h.agent });
    writeFileSync(join(DIR, "USER.md"), "USER-SECOND-SESSION", "utf-8");
    const other = { ...h.agent, id: "sess-2", session: { id: "sess-2" } } as DshAgent;
    const second = evaluate({ agent: other });
    expect(second).not.toBe(first);
    expect(second).toContain("USER-SECOND-SESSION");
  });

  it("拿不到会话键时绝不缓存：两次求值各自重算（cwd 变了就跟着变）", () => {
    const h = makeHarness({ defaultDirectory: "/work/proj-a" });
    apply(h.ctx, {});
    const evaluate = h.sections[0]!.text as (c: unknown) => string;

    const first = evaluate(undefined);
    expect(first).toContain(`## ${PROJ_SLUG}`);
    expect(first).not.toContain(OTHER_SLUG);

    // 兜底目录换了：若走全局兜底缓存，这里还会是 A 项目的旧文本（串项目）
    h.setDefaultDirectory("/work/other");
    const second = evaluate(undefined);
    expect(second).toContain(`## ${OTHER_SLUG}`);
    expect(second).not.toContain("本项目专属钩子");
  });

  it("两个不同 agent（不同 cwd）各自拿到自己的小节，互不串味", () => {
    const h = makeHarness({
      cwdBySession: { "sess-1": "/work/proj-a", "sess-2": "/work/other" },
    });
    apply(h.ctx, {});
    const evaluate = h.sections[0]!.text as (c: unknown) => string;
    const other = { ...h.agent, id: "sess-2", session: { id: "sess-2" } } as DshAgent;

    const a = evaluate({ agent: h.agent });
    const b = evaluate({ agent: other });

    expect(a).toContain(`## ${PROJ_SLUG}`);
    expect(a).not.toContain(OTHER_SLUG);
    expect(b).toContain(`## ${OTHER_SLUG}`);
    expect(b).not.toContain(PROJ_SLUG);
    expect(b).not.toContain("本项目专属钩子");

    // 各自命中自己的缓存，仍不串
    expect(evaluate({ agent: h.agent })).toBe(a);
    expect(evaluate({ agent: other })).toBe(b);
  });
});

describe("轮末补记", () => {
  it("有标记信号的轮次会触发一次提炼（llm.stream 被调用）", async () => {
    const h = makeHarness({ agentOptions: { provider: "p", model: "m" } });
    apply(h.ctx, {});

    emitTurn(h, 1, `好的${SIGNAL}`);
    await settle();

    expect(h.calls.length).toBe(1);
    expect(h.calls[0]!.provider).toBe("p");
    expect(h.calls[0]!.model).toBe("m");
  });

  it("节流：10 分钟内的第二轮不再触发提炼", async () => {
    const h = makeHarness({ agentOptions: { provider: "p", model: "m" } });
    apply(h.ctx, {});

    emitTurn(h, 1, `第一轮${SIGNAL}`);
    await settle();
    expect(h.calls.length).toBe(1);

    emitTurn(h, 2, `第二轮${SIGNAL}`);
    await settle();
    expect(h.calls.length).toBe(1);
  });

  it("节流可被配置覆盖：throttleMinutes 设为极小值后立刻再触发", async () => {
    const h = makeHarness({ agentOptions: { provider: "p", model: "m" } });
    apply(h.ctx, { throttleMinutes: 0.0001 });

    emitTurn(h, 1, `第一轮${SIGNAL}`);
    await settle();
    emitTurn(h, 2, `第二轮${SIGNAL}`);
    await settle();

    expect(h.calls.length).toBe(2);
  });

  it("本轮已有 memory_write → 跳过轮末补记", async () => {
    const h = makeHarness({ agentOptions: { provider: "p", model: "m" } });
    apply(h.ctx, {});

    const tool = h.tools.find((t) => t.name === "memory_write")!;

    // 写入必须发生在"这一轮之内"：turn/start 之后、turn/end 之前
    h.emit("turn/start", 1);
    const result = (await tool.execute({ text: "显式记住的一条" }, { agent: h.agent })) as {
      ok: boolean;
    };
    expect(result.ok).toBe(true);
    h.emit("assistant/message", 1, {
      step: 1,
      message: { role: "assistant", content: [{ type: "text", text: `顺带一个信号${SIGNAL}` }] },
    });
    h.emit("turn/end", 1, { reason: "success" });
    await settle();

    expect(h.calls.length).toBe(0);
  });

  it("配置为空且会话没有模型 → 跳过提炼、不报错，并在诊断里留一条", async () => {
    const h = makeHarness({ agentOptions: undefined });
    apply(h.ctx, {});

    emitTurn(h, 1, `信号${SIGNAL}`);
    await settle();

    expect(h.calls.length).toBe(0);
    expect(h.logs.some((l) => l.includes("取不到提炼模型"))).toBe(true);
  });

  it("autoRefine=false → 轮末不触发提炼（有信号也不调 llm.stream）", async () => {
    const h = makeHarness({ agentOptions: { provider: "p", model: "m" } });
    apply(h.ctx, { autoRefine: false });

    emitTurn(h, 1, `信号${SIGNAL}`);
    await settle();

    expect(h.calls.length).toBe(0);
  });

  it("autoRefine=false 只关自动补记：显式 memory_write 仍然写盘", async () => {
    const h = makeHarness({ agentOptions: { provider: "p", model: "m" } });
    apply(h.ctx, { autoRefine: false });
    const tool = h.tools.find((t) => t.name === "memory_write")!;

    const value = (await tool.execute({ text: "关了自动提炼也要能显式记住", name: "显式记住" }, { agent: h.agent })) as {
      ok: boolean;
    };
    expect(value.ok).toBe(true);

    emitTurn(h, 1, `信号${SIGNAL}`);
    await settle();
    expect(h.calls.length).toBe(0);
    expect(readFileSync(join(DIR, "MEMORY.md"), "utf-8")).toContain("关了自动提炼也要能显式记住");
  });

  it("autoRefine=true → 触发提炼（显式开启与缺省同义）", async () => {
    const h = makeHarness({ agentOptions: { provider: "p", model: "m" } });
    apply(h.ctx, { autoRefine: true });

    emitTurn(h, 1, `信号${SIGNAL}`);
    await settle();

    expect(h.calls.length).toBe(1);
  });

  it("宿主 volatile cell 形态的配置也能读全（provider/model/autoRefine/throttleMinutes）", async () => {
    const cell = <T,>(value: T) => ({ get: () => value });
    const h = makeHarness({ agentOptions: { provider: "session-p", model: "session-m" } });
    apply(
      h.ctx,
      {
        provider: cell("cfg-p"),
        model: cell("cfg-m"),
        autoRefine: cell(true),
        throttleMinutes: cell(0.0001),
      } as unknown as Parameters<typeof apply>[1],
    );

    emitTurn(h, 1, `第一轮${SIGNAL}`);
    await settle();
    emitTurn(h, 2, `第二轮${SIGNAL}`);
    await settle();

    // provider/model 拆包成功（否则会落到 session-p/session-m）；throttle 拆包成功（否则第二轮被 10 分钟节流）
    expect(h.calls.length).toBe(2);
    expect(h.calls[0]!.provider).toBe("cfg-p");
    expect(h.calls[0]!.model).toBe("cfg-m");
  });

  it("宿主 volatile cell 的 autoRefine=false 同样能关掉补记", async () => {
    const cell = <T,>(value: T) => ({ get: () => value });
    const h = makeHarness({ agentOptions: { provider: "p", model: "m" } });
    apply(h.ctx, { autoRefine: cell(false) } as unknown as Parameters<typeof apply>[1]);

    emitTurn(h, 1, `信号${SIGNAL}`);
    await settle();

    expect(h.calls.length).toBe(0);
  });

  it("volatile cell 是活的：设置改了下一轮就生效（不在 apply 时快照）", async () => {
    let provider = "cfg-p1";
    let autoRefine = true;
    const h = makeHarness({ agentOptions: { provider: "session-p", model: "session-m" } });
    apply(
      h.ctx,
      {
        provider: { get: () => provider },
        model: { get: () => "cfg-m" },
        autoRefine: { get: () => autoRefine },
        throttleMinutes: { get: () => 0.0001 },
      } as unknown as Parameters<typeof apply>[1],
    );

    emitTurn(h, 1, `第一轮${SIGNAL}`);
    await settle();
    expect(h.calls.length).toBe(1);
    expect(h.calls[0]!.provider).toBe("cfg-p1");

    // 模拟宿主 loader/volatile-update：cell 里的值原位变了
    provider = "cfg-p2";
    emitTurn(h, 2, `第二轮${SIGNAL}`);
    await settle();
    expect(h.calls.length).toBe(2);
    expect(h.calls[1]!.provider).toBe("cfg-p2");

    // 关掉开关同样立即生效
    autoRefine = false;
    emitTurn(h, 3, `第三轮${SIGNAL}`);
    await settle();
    expect(h.calls.length).toBe(2);
  });

  it("插件配置优先于会话模型", async () => {
    const h = makeHarness({ agentOptions: { provider: "session-p", model: "session-m" } });
    apply(h.ctx, { provider: "cfg-p", model: "cfg-m" });

    emitTurn(h, 1, `信号${SIGNAL}`);
    await settle();

    expect(h.calls.length).toBe(1);
    expect(h.calls[0]!.provider).toBe("cfg-p");
    expect(h.calls[0]!.model).toBe("cfg-m");
  });
});

describe("memory_write 工具", () => {
  it("回执是「[memx] 已记住：<name>」，且真的写进 canonical 记忆库与索引", async () => {
    const h = makeHarness();
    apply(h.ctx, {});
    const tool = h.tools.find((t) => t.name === "memory_write")!;

    // 参数 schema 与 opencode 对齐：text 必填，其余可选
    const parameters = tool.parameters as { required?: string[]; properties?: Record<string, unknown> };
    expect(parameters.required).toEqual(["text"]);
    expect(Object.keys(parameters.properties ?? {})).toEqual(
      expect.arrayContaining(["text", "type", "name", "description", "why", "how_to_apply"]),
    );

    const value = (await tool.execute({ text: "以后回复都用中文", name: "用中文回复" }, { agent: h.agent })) as {
      ok: boolean;
      name: string;
      message: string;
    };

    expect(value.ok).toBe(true);
    expect(value.name).toBe("用中文回复");
    expect(value.message).toBe("[memx] 已记住：用中文回复");

    const rendered = tool.output.render({}, value);
    expect(rendered).toEqual([{ type: "text", text: "[memx] 已记住：用中文回复" }]);

    const index = readFileSync(join(DIR, "MEMORY.md"), "utf-8");
    expect(index).toContain("以后回复都用中文");
    // 文件名走 core 的 slugify（中文名折叠成确定性短哈希），只断言内容落到本项目目录
    const memDir = join(DIR, "projects", PROJ_SLUG, ".mem");
    const files = readdirSync(memDir).filter((f) => f.endsWith(".md"));
    expect(files).toHaveLength(1);
    expect(readFileSync(join(memDir, files[0]!), "utf-8")).toContain("以后回复都用中文");
    // 别的项目小节没被动
    expect(index).toContain(`## ${OTHER_SLUG}`);
  });

  it("text 为空 → 失败回执，不抛", async () => {
    const h = makeHarness();
    apply(h.ctx, {});
    const tool = h.tools.find((t) => t.name === "memory_write")!;
    const value = (await tool.execute({ text: "   " }, { agent: h.agent })) as { ok: boolean; message: string };
    expect(value.ok).toBe(false);
    expect(value.message).toContain("memory_write 失败");
  });
});
