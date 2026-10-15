import { describe, it, expect, vi } from "vitest";
import { createSessionLLMClient, toModelRef } from "../src/hosts/opencode/session-llm.ts";

/** v2 形状的 mock ctx：session.create/prompt/wait/remove/context（messages 经 context 取） */
function createMockCtx(opts: {
  createdId?: string;
  messages?: Array<{ type: string; text?: string; content?: Array<{ type: string; text?: string }> }>;
  promptError?: Error;
  contextShape?: "envelope" | "array";
}) {
  const calls: string[] = [];
  const ctx: any = {
    session: {
      create: vi.fn(async () => {
        calls.push("create");
        return { id: opts.createdId ?? "child-session-123" };
      }),
      prompt: vi.fn(async () => {
        if (opts.promptError) throw opts.promptError;
        calls.push("prompt");
        return { id: "msg-user" };
      }),
      wait: vi.fn(async () => {
        calls.push("wait");
      }),
      remove: vi.fn(async () => {
        calls.push("remove");
      }),
      context: vi.fn(async () => {
        calls.push("context");
        // v2 SDK 返回消息数组本体；"envelope" 仅作旧形状兜底的对照
        return opts.contextShape === "array" ? (opts.messages ?? []) : { messages: opts.messages ?? [] };
      }),
    },
  };
  return { ctx, calls };
}

const REPLY = [
  { type: "assistant", content: [{ type: "text", text: "Hello" }, { type: "text", text: " World" }] },
];

describe("createSessionLLMClient（v2，回复经 session.context）", () => {
  it("创建 → prompt → wait → context 取回复 → remove；model 传 Model.Ref 对象", async () => {
    const { ctx, calls } = createMockCtx({ createdId: "child-1", messages: REPLY });
    const hooks = { onCreated: vi.fn(), onRemoved: vi.fn() };
    const llm = createSessionLLMClient(ctx, "opencode/mimo-v2.6-flash-free", hooks);
    const result = await llm.chat({
      system: "You are helpful",
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(result).toBe("Hello World");
    expect(calls).toEqual(["create", "prompt", "wait", "context", "remove"]);
    // v2 SessionCreateInput.model 是 Model.Ref 对象，传字符串会 SchemaError(Expected Model.Ref)
    expect(ctx.session.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "memx-refinement", model: { providerID: "opencode", id: "mimo-v2.6-flash-free" } }),
    );
    // #82 实测：2.0.26 服务端只收字符串 text，对象形态 400（Expected string at ["text"]）
    expect(ctx.session.prompt).toHaveBeenCalledWith({ sessionID: "child-1", text: "Hi" });
    expect(hooks.onCreated).toHaveBeenCalledWith("child-1", "You are helpful");
    expect(hooks.onRemoved).toHaveBeenCalledWith("child-1");
  });

  it("assistant 只取 content 里的 text（reasoning 不计）", async () => {
    const { ctx } = createMockCtx({
      createdId: "child-2",
      messages: [{ type: "assistant", content: [{ type: "reasoning", text: "thinking" }, { type: "text", text: "ok" }] }],
    });
    const llm = createSessionLLMClient(ctx, undefined, { onCreated: vi.fn(), onRemoved: vi.fn() });
    const result = await llm.chat({ system: "", messages: [{ role: "user", content: "Hi" }] });
    expect(result).toBe("ok");
  });

  it("prompt 失败也要 remove 子会话并移出活跃集合", async () => {
    const { ctx, calls } = createMockCtx({ createdId: "child-err", promptError: new Error("LLM failed") });
    const onRemoved = vi.fn();
    const llm = createSessionLLMClient(ctx, undefined, { onCreated: vi.fn(), onRemoved });
    await expect(llm.chat({ system: "", messages: [{ role: "user", content: "Hi" }] })).rejects.toThrow("LLM failed");
    expect(calls).toContain("remove");
    expect(onRemoved).toHaveBeenCalledWith("child-err");
  });

  it("无 model 时不传 model 字段", async () => {
    const { ctx } = createMockCtx({ createdId: "child-3", messages: REPLY });
    const llm = createSessionLLMClient(ctx, undefined, { onCreated: vi.fn(), onRemoved: vi.fn() });
    await llm.chat({ system: "", messages: [{ role: "user", content: "Hi" }] });
    expect(ctx.session.create.mock.calls[0][0]).not.toHaveProperty("model");
  });

  it("onCreated/onRemoved 构成活跃集合的登记/移除对", async () => {
    const { ctx } = createMockCtx({ createdId: "child-pair", messages: REPLY });
    const events: string[] = [];
    const llm = createSessionLLMClient(ctx, undefined, {
      onCreated: (id) => events.push("+" + id),
      onRemoved: (id) => events.push("-" + id),
    });
    await llm.chat({ system: "", messages: [{ role: "user", content: "Hi" }] });
    expect(events).toEqual(["+child-pair", "-child-pair"]);
  });

  it("context 返回数组本体（v2 真实形状）也能取到回复——#82 Blocker B 回归", async () => {
    const { ctx } = createMockCtx({ createdId: "child-array", messages: REPLY, contextShape: "array" });
    const llm = createSessionLLMClient(ctx, "opencode/mimo-v2.6-flash-free", {
      onCreated: vi.fn(),
      onRemoved: vi.fn(),
    });
    // 旧实现 res?.messages 在数组上恒 undefined → 回复恒空字符串
    const result = await llm.chat({ system: "", messages: [{ role: "user", content: "Hi" }] });
    expect(result).toBe("Hello World");
  });
});

describe("toModelRef（'provider/model' 字符串 → v2 Model.Ref）", () => {
  it("标准形态拆成 providerID + id", () => {
    expect(toModelRef("opencode/mimo-v2.6-flash-free")).toEqual({
      providerID: "opencode",
      id: "mimo-v2.6-flash-free",
    });
  });

  it("只按第一个 / 切分，剩余斜杠留在 id 里", () => {
    expect(toModelRef("vendor/org/model-x")).toEqual({ providerID: "vendor", id: "org/model-x" });
  });

  it("#variant 后缀被剥离且不设 variant", () => {
    expect(toModelRef("opencode/mimo-v2.6-flash-free#high")).toEqual({
      providerID: "opencode",
      id: "mimo-v2.6-flash-free",
    });
  });

  it("undefined / 空串 / 无斜杠 / 斜杠开头 → undefined（调用方省略 model，交宿主默认）", () => {
    for (const raw of [undefined, "", "   ", "bare-model", "/leading", "opencode/", "#v"]) {
      expect(toModelRef(raw)).toBeUndefined();
    }
  });

  it("不可解析的 model 字符串不会让 create 带 model 字段", async () => {
    const { ctx } = createMockCtx({ createdId: "child-badmodel", messages: REPLY });
    const llm = createSessionLLMClient(ctx, "bare-model", { onCreated: vi.fn(), onRemoved: vi.fn() });
    await llm.chat({ system: "", messages: [{ role: "user", content: "Hi" }] });
    expect(ctx.session.create.mock.calls[0][0]).not.toHaveProperty("model");
  });
});
