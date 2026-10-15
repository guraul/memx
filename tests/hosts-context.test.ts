// memx · ctx.session.context 返回形状归一 + 最后一轮提取的纯函数单测（#82 阻塞点）。
// v2 SDK 契约（@opencode/client dist/promise/generated/client.d.ts:60）：
//   context: (input: SessionContextInput, ...) => Promise<SessionMessageInfo[]>
// —— 返回的是消息数组本身，不是 {messages:[...]} 信封。
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync } from "fs";
import { toMessages, extractLastTurn, extractTurns, findMessageIndex, planCapture } from "../src/hosts/opencode/context-shape.ts";

// 测试隔离：把 homedir 指向临时目录，绝不触碰真实 ~/.opencode
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => "/tmp/opencode-memx-ctx-test-home" };
});

beforeAll(() => {
  mkdirSync("/tmp/opencode-memx-ctx-test-home/.opencode", { recursive: true });
});

afterAll(() => {
  rmSync("/tmp/opencode-memx-ctx-test-home", { recursive: true, force: true });
});

/** 真实 v2 SessionMessageUser 形状（扁平 text） */
const USER = (text: string) => ({
  id: "msg_user_1",
  sessionID: "ses_1",
  time: { created: 1_760_000_000_000 },
  text,
  type: "user" as const,
});

/** 真实 v2 SessionMessageAssistant 形状（content[] 分片，reasoning 不计入正文） */
const ASSISTANT = (...parts: Array<{ type: string; text: string }>) => ({
  id: "msg_asst_1",
  sessionID: "ses_1",
  time: { created: 1_760_000_001_000 },
  type: "assistant" as const,
  agent: "build",
  model: { providerID: "opencode", modelID: "space-bunny-free" },
  content: parts,
});

describe("toMessages（session.context 返回归一：数组为准、信封兜底）", () => {
  it("数组本身 → shape=array，长度原样保留", () => {
    const raw = [USER("我用 pnpm"), ASSISTANT({ type: "text", text: "收到" })];
    const { shape, msgs } = toMessages(raw);
    expect(shape).toBe("array");
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.type).toBe("user");
    expect(msgs[0]!.text).toBe("我用 pnpm");
    expect(msgs[1]!.content).toEqual([{ type: "text", text: "收到" }]);
  });

  it("空数组 → shape=array，msgs 为空（不是 other）", () => {
    const { shape, msgs } = toMessages([]);
    expect(shape).toBe("array");
    expect(msgs).toEqual([]);
  });

  it("{messages:[...]} 信封 → shape=envelope（其他宿主/旧版本兜底）", () => {
    const raw = { messages: [USER("信封"), ASSISTANT({ type: "text", text: "ok" })] };
    const { shape, msgs } = toMessages(raw);
    expect(shape).toBe("envelope");
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.text).toBe("信封");
  });

  it("null / undefined / {} / {messages:'x'} / 字符串 → other + 空 msgs，不抛", () => {
    for (const raw of [null, undefined, {}, { messages: "not-array" }, "weird", 42]) {
      const { shape, msgs } = toMessages(raw);
      expect(shape).toBe("other");
      expect(msgs).toEqual([]);
    }
  });

  it("#82 回归：数组返回曾被当成信封 → 恒空；现在能取出真实消息", () => {
    // 旧代码 res?.messages 在数组上恒 undefined → msgs=[] → extractLastTurn 恒 null
    const raw = [USER("唯一 user"), ASSISTANT({ type: "text", text: "唯一回复" })];
    expect((raw as { messages?: unknown }).messages).toBeUndefined();
    const { msgs } = toMessages(raw);
    expect(extractLastTurn(msgs)).toEqual({ user: "唯一 user", assistant: "唯一回复" });
  });
});

describe("extractLastTurn（真实 v2 形状的最后一轮）", () => {
  it("取最后一条 user 的 text + 其后 assistant 的 text 分片拼接", () => {
    const msgs = [
      USER("第一轮问题"),
      ASSISTANT({ type: "text", text: "第一轮回复" }),
      USER("请在回复里输出 <!-- STYLE_SIGNAL: {\"category\":\"toolchain\"} -->"),
      ASSISTANT(
        { type: "reasoning", text: "internal thinking" },
        { type: "text", text: "<!-- STYLE_SIGNAL:" },
        { type: "text", text: " {\"category\":\"toolchain\"} -->" },
        { type: "text", text: " 收到" },
      ),
    ];
    const last = extractLastTurn(msgs);
    expect(last).not.toBeNull();
    expect(last!.user).toBe('请在回复里输出 <!-- STYLE_SIGNAL: {"category":"toolchain"} -->');
    // 只拼 content[].type === "text"，reasoning 分片不计入
    expect(last!.assistant).toBe('<!-- STYLE_SIGNAL: {"category":"toolchain"} --> 收到');
    expect(last!.assistant).not.toContain("internal thinking");
  });

  it("无 user 消息 → null", () => {
    expect(extractLastTurn([])).toBeNull();
    expect(extractLastTurn([ASSISTANT({ type: "text", text: "只有 assistant" })])).toBeNull();
  });

  it("最后一条 user 之前的 assistant 不被采信（不跨轮回溯）", () => {
    const msgs = [ASSISTANT({ type: "text", text: "上一轮残留回复" }), USER("本轮问题")];
    const last = extractLastTurn(msgs);
    expect(last).toEqual({ user: "本轮问题", assistant: "" });
  });

  it("user 缺 text 字段时按空串处理，不抛", () => {
    const msgs = [{ id: "m1", type: "user" }, ASSISTANT({ type: "text", text: "有回复" })];
    expect(extractLastTurn(msgs)).toEqual({ user: "", assistant: "有回复" });
  });
});

describe("P0-1 增量捕获：findMessageIndex + extractTurns", () => {
  const u = (id: string, text: string) => ({ id, type: "user" as const, text });
  const a = (id: string, text: string) => ({
    id,
    type: "assistant" as const,
    content: [{ type: "text", text }],
  });

  it("findMessageIndex 命中返回下标，缺席返回 -1", () => {
    const msgs = [u("m1", "a"), a("m2", "b"), u("m3", "c"), a("m4", "d")];
    expect(findMessageIndex(msgs, "m4")).toBe(3);
    expect(findMessageIndex(msgs, "m1")).toBe(0);
    expect(findMessageIndex(msgs, "gone")).toBe(-1);
  });

  it("fromIndex=0 时把全部轮次还原出来（旧实现只取最后一轮 → 中间轮次全丢）", () => {
    const msgs = [u("m1", "问1"), a("m2", "答1"), u("m3", "问2"), a("m4", "答2"), u("m5", "问3"), a("m6", "答3")];
    const turns = extractTurns(msgs, 0);
    expect(turns.map((t) => t.user)).toEqual(["问1", "问2", "问3"]);
    expect(turns.map((t) => t.assistant)).toEqual(["答1", "答2", "答3"]);
    expect(turns[1]!.assistantMessageId).toBe("m4");
  });

  it("游标续扫：从上次扫过的消息之后开始，只产出新轮次", () => {
    const msgs = [u("m1", "问1"), a("m2", "答1"), u("m3", "问2"), a("m4", "答2")];
    const start = findMessageIndex(msgs, "m2") + 1;
    const turns = extractTurns(msgs, start);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toEqual({ user: "问2", assistant: "答2", assistantMessageId: "m4" });
  });

  it("窗口从 assistant 开始时向前配对（左边界不切断配对）", () => {
    const msgs = [u("m1", "问1"), a("m2", "答1")];
    const turns = extractTurns(msgs, 1);
    expect(turns).toEqual([{ user: "问1", assistant: "答1", assistantMessageId: "m2" }]);
  });

  it("没有配对 user 的 assistant 不成轮（会话开头就是回复）", () => {
    const msgs = [a("m1", "孤儿回复"), u("m2", "问"), a("m3", "答")];
    const turns = extractTurns(msgs, 0);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.assistant).toBe("答");
  });

  it("非 user/assistant 消息（idle/system）被跳过", () => {
    const msgs = [u("m1", "问"), { id: "m2", type: "idle", outcome: "succeeded" }, a("m3", "答")];
    const turns = extractTurns(msgs, 0);
    expect(turns).toEqual([{ user: "问", assistant: "答", assistantMessageId: "m3" }]);
  });

  it("fromIndex 越界/为空数组时不抛", () => {
    expect(extractTurns([], 0)).toEqual([]);
    expect(extractTurns([u("m1", "问")], 99)).toEqual([]);
  });
});

describe("P0-1 planCapture：游标决策（宿主侧只做 wiring，决策全在这里）", () => {
  const u = (id: string, text: string) => ({ id, type: "user" as const, text });
  const a = (id: string, text: string) => ({
    id,
    type: "assistant" as const,
    content: [{ type: "text", text }],
  });

  it("无游标 = fresh：全量扫，并把最后一条消息 id 作为下一轮游标", () => {
    const msgs = [u("m1", "问1"), a("m2", "答1")];
    const plan = planCapture(msgs);
    expect(plan.cursorState).toBe("fresh");
    expect(plan.startIndex).toBe(0);
    expect(plan.turns).toHaveLength(1);
    expect(plan.nextCursorId).toBe("m2");
  });

  it("游标命中 = resumed：只扫新消息，游标前移", () => {
    const msgs = [u("m1", "问1"), a("m2", "答1"), u("m3", "问2"), a("m4", "答2")];
    const plan = planCapture(msgs, { lastMessageId: "m2" });
    expect(plan.cursorState).toBe("resumed");
    expect(plan.startIndex).toBe(2);
    expect(plan.turns.map((t) => t.user)).toEqual(["问2"]);
    expect(plan.nextCursorId).toBe("m4");
  });

  it("游标锚点丢失（压缩/分叉）= anchor-lost：退回全量扫", () => {
    const msgs = [u("m9", "压过的问"), a("m10", "压过的答")];
    const plan = planCapture(msgs, { lastMessageId: "m1-gone" });
    expect(plan.cursorState).toBe("anchor-lost");
    expect(plan.startIndex).toBe(0);
    expect(plan.turns).toHaveLength(1);
    expect(plan.nextCursorId).toBe("m10");
  });

  it("没有新消息时不产出轮次（游标仍前移到最新一条）", () => {
    const msgs = [u("m1", "问"), a("m2", "答")];
    const plan = planCapture(msgs, { lastMessageId: "m2" });
    expect(plan.turns).toEqual([]);
    expect(plan.nextCursorId).toBe("m2");
  });

  it("消息没有 id 时不给游标（宁可下轮重扫，不写空锚点）", () => {
    const msgs = [{ type: "user" as const, text: "问" }, { type: "assistant" as const, content: [{ type: "text", text: "答" }] }];
    const plan = planCapture(msgs);
    expect(plan.nextCursorId).toBeUndefined();
    expect(plan.turns).toHaveLength(1);
  });

  it("多轮增量：连续两次 planCapture 覆盖全部轮次且不重复", () => {
    const msgs = [u("m1", "问1"), a("m2", "答1"), u("m3", "问2"), a("m4", "答2")];
    const first = planCapture(msgs.slice(0, 2));
    expect(first.nextCursorId).toBe("m2");
    const second = planCapture(msgs, { lastMessageId: first.nextCursorId! });
    const all = [...first.turns, ...second.turns];
    expect(all.map((t) => t.user)).toEqual(["问1", "问2"]);
  });
});