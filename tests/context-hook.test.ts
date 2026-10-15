// `context` hook 的行为测试（hosts/opencode/context-hook.ts）——插件最要紧的一段。
//
// 这个 hook 跑在宿主**每个 step** 的组装管线上。写坏它的症状全是静默的：模型变笨、
// 提炼子会话拿不到 JSON、或者 403（#82 那类 FreeTierError）。所以这里钉死三件事：
//
//   1. 子会话分支**整体替换** system，且注入**绝不**参与（污染提炼调用 = 提炼质量塌 + 403 高危）
//   2. 非子会话只**追加**，宿主原有的 agent.system / AGENTS.md 正文一行都不能少
//   3. 闸门与空来源都真的什么都不改（不是改成空数组）
//
// 事件形状照 v2 SDK 的 SessionContext（node_modules/@opencode/plugin/dist/promise/session.d.ts:29）：
// system/options/tools 可变，agent 只读。注入只碰 system。
import { describe, it, expect } from "vitest";
import { applyContextHook } from "../src/hosts/opencode/context-hook.ts";
import type { ContextHookEvent, ContextHookDeps } from "../src/hosts/opencode/context-hook.ts";
import type { InjectionSources } from "../src/core/injection.ts";
import { DEFAULT_AGENT_GATE } from "../src/core/injection.ts";

const PROTOCOL = "# memx signal protocol\n\nemit <!-- STYLE_SIGNAL: ... -->";
const USER = "# User Profile & Style\n\n- [2026-10-12] 先给结论";
const MEMORY = "# Project Memory\n\n- [proj](proj.md) - 索引";

const ALL_SOURCES: InjectionSources = { protocol: PROTOCOL, user: USER, memory: MEMORY };

/** 宿主在 hook 触发前已经装好的 system：agent.system + AGENTS.md 合并正文（两个 part）。 */
const HOST_SYSTEM = [
  { type: "text" as const, text: "AGENT_SYSTEM_PROMPT" },
  { type: "text" as const, text: "Instructions from: /repo/AGENTS.md\n项目规则……" },
];

const event = (over: Partial<ContextHookEvent> = {}): ContextHookEvent => ({
  sessionID: "ses_user",
  agent: "build",
  system: [...HOST_SYSTEM],
  options: { maxTokens: 32000 },
  ...over,
});

const deps = (over: Partial<ContextHookDeps> = {}): ContextHookDeps => ({
  childSessions: new Map(),
  gate: DEFAULT_AGENT_GATE,
  readSources: () => ALL_SOURCES,
  ...over,
});

const texts = (e: ContextHookEvent) => e.system.map((p) => p.text);

describe("子会话分支 — 整体替换，且注入绝不参与（最重要的回归护栏）", () => {
  const CHILD = "提炼提示词：只输出 JSON 数组";
  const childDeps = () => deps({ childSessions: new Map([["ses_child", CHILD]]) });

  it("命中的子会话：system 被**整体替换**成提炼提示词（只剩一个 part）", () => {
    const e = event({ sessionID: "ses_child" });
    const outcome = applyContextHook(e, childDeps());
    expect(outcome).toEqual({ kind: "child", system: CHILD });
    expect(e.system).toEqual([{ type: "text", text: CHILD }]);
  });

  it("⚠️ 替换时宿主原有内容被抹掉是**预期行为**（提炼要的就是干净 system）", () => {
    const e = event({ sessionID: "ses_child" });
    applyContextHook(e, childDeps());
    expect(texts(e)).not.toContain("AGENT_SYSTEM_PROMPT");
    expect(texts(e)).not.toContain("Instructions from: /repo/AGENTS.md\n项目规则……");
  });

  it("⚠️ 即便三块内容全部齐备，子会话也**一点都注不进去**", () => {
    const e = event({ sessionID: "ses_child" });
    applyContextHook(e, childDeps());
    expect(texts(e)).toHaveLength(1);
    for (const leaked of [PROTOCOL, USER, MEMORY]) {
      expect(texts(e).join("\n")).not.toContain(leaked);
    }
    expect(texts(e).join("\n")).not.toContain("memx signal protocol");
  });

  it("子会话同时把 temperature 压到 0.2", () => {
    const e = event({ sessionID: "ses_child" });
    applyContextHook(e, childDeps());
    expect(e.options.temperature).toBe(0.2);
  });

  it("子会话**不碰** tools（清空 tools 会触发 #82 的 403 FreeTierError）", () => {
    const e = event({ sessionID: "ses_child" });
    (e as unknown as { tools: Record<string, unknown> }).tools = { bash: {}, read: {} };
    applyContextHook(e, childDeps());
    const tools = (e as unknown as { tools: Record<string, unknown> }).tools;
    expect(Object.keys(tools)).toEqual(["bash", "read"]);
    expect(tools).not.toEqual({});
  });

  it("非子会话不设 temperature（保留宿主给的值）", () => {
    const e = event();
    applyContextHook(e, deps());
    expect(e.options.temperature).toBeUndefined();
    expect(e.options.maxTokens).toBe(32000);
  });

  it("同一个 deps 连打 child / user 两个会话：分支互不串味（子会话不会污染普通会话的 system）", () => {
    const d = childDeps();
    const child = event({ sessionID: "ses_child" });
    const user = event({ sessionID: "ses_user" });
    applyContextHook(child, d);
    applyContextHook(user, d);

    expect(texts(child)).toEqual([CHILD]);
    expect(texts(user)).toContain("AGENT_SYSTEM_PROMPT");
    expect(texts(user)).toContain(PROTOCOL);
  });
});

describe("非子会话 — 只追加，宿主内容一行都不能少", () => {
  it("原有 part 原封不动排在前面，注入内容接在后面", () => {
    const e = event();
    applyContextHook(e, deps());
    expect(texts(e)).toEqual([
      "AGENT_SYSTEM_PROMPT",
      "Instructions from: /repo/AGENTS.md\n项目规则……",
      PROTOCOL,
      USER,
      MEMORY,
    ]);
  });

  it("宿主 part 的对象身份不变（不是复制，是真·append）", () => {
    const e = event();
    const [first, second] = e.system;
    applyContextHook(e, deps());
    expect(e.system[0]).toBe(first);
    expect(e.system[1]).toBe(second);
  });

  it("只有协议存在 → 追加一个 part，宿主两块都在", () => {
    const e = event();
    applyContextHook(e, deps({ readSources: () => ({ protocol: PROTOCOL }) }));
    expect(texts(e)).toEqual(["AGENT_SYSTEM_PROMPT", "Instructions from: /repo/AGENTS.md\n项目规则……", PROTOCOL]);
  });

  it("原有 system 为空数组 → 结果就是注入内容（不会崩、也不会凭空造宿主内容）", () => {
    const e = event({ system: [] });
    applyContextHook(e, deps());
    expect(texts(e)).toEqual([PROTOCOL, USER, MEMORY]);
  });

  it("宿主 system 字段为 undefined → 退化成「只有注入内容」，不抛", () => {
    const e = event();
    (e as unknown as { system: unknown }).system = undefined;
    expect(() => applyContextHook(e, deps())).not.toThrow();
    expect(texts(e)).toEqual([PROTOCOL, USER, MEMORY]);
  });

  it("连打 5 个 step（hook 每 step 触发）→ system 不累积：每次都从宿主那份开始追加", () => {
    // 每 step 宿主都会重新构造一份 baseTranscript（model-request.ts:110-116），
    // 所以注入不能有跨 step 的残留。
    for (let step = 0; step < 5; step++) {
      const e = event();
      const outcome = applyContextHook(e, deps());
      expect(outcome.kind).toBe("injected");
      expect(e.system).toHaveLength(2 + 3);
      expect(texts(e).filter((t) => t === PROTOCOL)).toHaveLength(1);
    }
  });
});

describe("闸门 — 被挡下时一个字都不改", () => {
  it("enabled=false → system 原封不动", () => {
    const before = event();
    const snapshot = JSON.stringify(before.system);
    const outcome = applyContextHook(before, deps({ gate: { ...DEFAULT_AGENT_GATE, enabled: false } }));
    expect(outcome).toEqual({ kind: "gated" });
    expect(JSON.stringify(before.system)).toBe(snapshot);
  });

  it("agent 命中 exclude → 原封不动", () => {
    const before = event({ agent: "noisy" });
    const snapshot = JSON.stringify(before.system);
    const outcome = applyContextHook(before, deps({ gate: { enabled: true, includeAgents: "all", excludeAgents: ["noisy"] } }));
    expect(outcome).toEqual({ kind: "gated" });
    expect(JSON.stringify(before.system)).toBe(snapshot);
  });

  it("agent 不在 include 列表 → 原封不动", () => {
    const before = event({ agent: "plan" });
    const snapshot = JSON.stringify(before.system);
    const outcome = applyContextHook(before, deps({ gate: { enabled: true, includeAgents: ["build"], excludeAgents: [] } }));
    expect(outcome).toEqual({ kind: "gated" });
    expect(JSON.stringify(before.system)).toBe(snapshot);
  });

  it("被挡下时**不读文件**（readSources 一次都不该被调用）", () => {
    let calls = 0;
    const d = deps({
      gate: { enabled: false, includeAgents: "all", excludeAgents: [] },
      readSources: () => {
        calls++;
        return ALL_SOURCES;
      },
    });
    applyContextHook(event(), d);
    expect(calls).toBe(0);
  });

  it("被挡下时也不设 temperature", () => {
    const e = event();
    applyContextHook(e, deps({ gate: { enabled: false, includeAgents: "all", excludeAgents: [] } }));
    expect(e.options.temperature).toBeUndefined();
  });
});

describe("空来源 — 三块全缺时一个字都不改", () => {
  it("全 null → system 原封不动（不是替换成空数组！）", () => {
    const before = event();
    const snapshot = JSON.stringify(before.system);
    const outcome = applyContextHook(before, deps({ readSources: () => ({ protocol: null, user: null, memory: null }) }));
    expect(outcome).toEqual({ kind: "empty" });
    expect(JSON.stringify(before.system)).toBe(snapshot);
    expect(before.system).toHaveLength(2);
  });

  it("readSources 抛异常 → 退化成 empty，event 不被改坏，也不把异常抛出去", () => {
    const e = event();
    const snapshot = JSON.stringify(e.system);
    const outcome = applyContextHook(e, deps({ readSources: () => { throw new Error("disk on fire"); } }));
    expect(outcome).toEqual({ kind: "empty" });
    expect(JSON.stringify(e.system)).toBe(snapshot);
  });

  it("全空串 / 全空白 → empty", () => {
    const e = event();
    const outcome = applyContextHook(e, deps({ readSources: () => ({ protocol: "", user: "  ", memory: "\n\n" }) }));
    expect(outcome.kind).toBe("empty");
    expect(e.system).toHaveLength(2);
  });
});

describe("outcome 载荷 — 诊断要用的数字", () => {
  it("injected：带 part 数、总字节、每来源事实、命中 agent", () => {
    const e = event({ agent: "build" });
    const outcome = applyContextHook(e, deps());
    expect(outcome.kind).toBe("injected");
    if (outcome.kind !== "injected") throw new Error("unreachable");
    expect(outcome.parts).toBe(3);
    expect(outcome.agent).toBe("build");
    expect(outcome.totalBytes).toBe(Buffer.byteLength(PROTOCOL) + Buffer.byteLength(USER) + Buffer.byteLength(MEMORY));
    expect(outcome.facts.map((f) => f.id)).toEqual(["protocol", "user", "memory"]);
    expect(outcome.facts.every((f) => !f.truncated)).toBe(true);
  });

  it("超大画像 → injected 且事实里带 truncated=true（诊断能看见截断发生过）", () => {
    const huge = Array.from({ length: 900 }, (_, i) => `entry ${i}`).join("\n");
    const e = event();
    const outcome = applyContextHook(e, deps({ readSources: () => ({ user: huge }) }));
    if (outcome.kind !== "injected") throw new Error("unreachable");
    expect(outcome.facts[0]!.truncated).toBe(true);
    expect(e.system.at(-1)!.text).toContain("[memx: truncated");
  });

  it("agent 缺失（宿主没给）→ 按 include='all' 照常注入，agent 记为 undefined", () => {
    const e = event();
    (e as unknown as { agent: unknown }).agent = undefined;
    const outcome = applyContextHook(e, deps());
    if (outcome.kind !== "injected") throw new Error("unreachable");
    expect(outcome.agent).toBeUndefined();
    expect(e.system).toHaveLength(5);
  });
});

describe("防再注入 — memx 自己注入的内容不会被当成宿主内容重复叠加", () => {
  it("单次调用只追加一份（同一 part 不出现两次）", () => {
    const e = event();
    applyContextHook(e, deps());
    expect(texts(e).filter((t) => t === PROTOCOL)).toHaveLength(1);
    expect(texts(e).filter((t) => t === USER)).toHaveLength(1);
    expect(texts(e).filter((t) => t === MEMORY)).toHaveLength(1);
  });

  it("注入的 part 全是 {type:'text', text}（宿主 SystemPart 契约）", () => {
    const e = event();
    applyContextHook(e, deps());
    for (const part of e.system) {
      expect(part.type).toBe("text");
      expect(typeof part.text).toBe("string");
    }
  });
});