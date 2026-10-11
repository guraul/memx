import { describe, it, expect, vi } from "vitest";
import { createSessionLLMClient } from "../src/hosts/opencode/session-llm";

/** v2 形状的 mock ctx：session.create/prompt/wait/remove/context（messages 经 context 取） */
function createMockCtx(opts: {
  createdId?: string;
  messages?: Array<{ type: string; text?: string; content?: Array<{ type: string; text?: string }> }>;
  promptError?: Error;
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
        return { messages: opts.messages ?? [] };
      }),
    },
  };
  return { ctx, calls };
}

const REPLY = [
  { type: "assistant", content: [{ type: "text", text: "Hello" }, { type: "text", text: " World" }] },
];

describe("createSessionLLMClient（v2，回复经 session.context）", () => {
  it("创建 → prompt → wait → context 取回复 → remove；model 透传", async () => {
    const { ctx, calls } = createMockCtx({ createdId: "child-1", messages: REPLY });
    const hooks = { onCreated: vi.fn(), onRemoved: vi.fn() };
    const llm = createSessionLLMClient(ctx, "opencode/mimo-v2.6-flash-free", hooks);
    const result = await llm.chat({
      system: "You are helpful",
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(result).toBe("Hello World");
    expect(calls).toEqual(["create", "prompt", "wait", "context", "remove"]);
    expect(ctx.session.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "memx-refinement", model: "opencode/mimo-v2.6-flash-free" }),
    );
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
});
