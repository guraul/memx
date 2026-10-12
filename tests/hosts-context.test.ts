// memx · ctx.session.context 返回形状归一 + 最后一轮提取的纯函数单测（#82 阻塞点）。
// v2 SDK 契约（@opencode/client dist/promise/generated/client.d.ts:60）：
//   context: (input: SessionContextInput, ...) => Promise<SessionMessageInfo[]>
// —— 返回的是消息数组本身，不是 {messages:[...]} 信封。
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync } from "fs";
import { toMessages, extractLastTurn } from "../src/hosts/opencode/context-shape";

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