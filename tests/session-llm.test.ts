import { describe, it, expect, vi } from "vitest";
import { createSessionLLMClient } from "../src/hosts/opencode/session-llm";

/** v2 形状的 mock ctx：session.create/prompt/wait/remove；回复经 getReply 缓存钩子 */
function createMockCtx(opts: { createdId?: string; reply?: string; promptError?: Error; removeError?: Error }) {
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
        if (opts.removeError) throw opts.removeError;
      }),
    },
  };
  return { ctx, calls };
}

describe("createSessionLLMClient（v2，事件缓存取回复）", () => {
  it("创建 → prompt → wait → getReply 取缓存 → remove；model 透传给 create", async () => {
    const { ctx, calls } = createMockCtx({ createdId: "child-1", reply: "Hello World" });
    const hooks = { onCreated: vi.fn(), onRemoved: vi.fn(), getReply: vi.fn(() => "Hello World") };
    const llm = createSessionLLMClient(ctx, "opencode/mimo-v2.6-flash-free", hooks);
    const result = await llm.chat({
      system: "You are helpful",
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(result).toBe("Hello World");
    expect(calls).toEqual(["create", "prompt", "wait", "remove"]);
    expect(ctx.session.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "memx-refinement", model: "opencode/mimo-v2.6-flash-free" }),
    );
    expect(ctx.session.prompt).toHaveBeenCalledWith({ sessionID: "child-1", text: "Hi" });
    expect(hooks.getReply).toHaveBeenCalledWith("child-1");
    expect(hooks.onCreated).toHaveBeenCalledWith("child-1", "You are helpful");
    expect(hooks.onRemoved).toHaveBeenCalledWith("child-1");
  });

  it("缓存未命中（getReply 空）返回空字符串，不抛错", async () => {
    const { ctx } = createMockCtx({ createdId: "child-2", reply: "" });
    const llm = createSessionLLMClient(ctx, undefined, { onCreated: vi.fn(), onRemoved: vi.fn(), getReply: () => "" });
    const result = await llm.chat({ system: "", messages: [{ role: "user", content: "Hi" }] });
    expect(result).toBe("");
  });

  it("prompt 失败也要 remove 子会话并移出活跃集合", async () => {
    const { ctx, calls } = createMockCtx({ createdId: "child-err", promptError: new Error("LLM failed") });
    const onRemoved = vi.fn();
    const llm = createSessionLLMClient(ctx, undefined, { onCreated: vi.fn(), onRemoved, getReply: () => "" });
    await expect(llm.chat({ system: "", messages: [{ role: "user", content: "Hi" }] })).rejects.toThrow("LLM failed");
    expect(calls).toContain("remove");
    expect(onRemoved).toHaveBeenCalledWith("child-err");
  });

  it("无 model 时不传 model 字段", async () => {
    const { ctx } = createMockCtx({ createdId: "child-3", reply: "ok" });
    const llm = createSessionLLMClient(ctx, undefined, { onCreated: vi.fn(), onRemoved: vi.fn(), getReply: () => "ok" });
    await llm.chat({ system: "", messages: [{ role: "user", content: "Hi" }] });
    expect(ctx.session.create.mock.calls[0][0]).not.toHaveProperty("model");
  });

  it("onCreated/onRemoved 构成活跃集合的登记/移除对", async () => {
    const { ctx } = createMockCtx({ createdId: "child-pair", reply: "ok" });
    const events: string[] = [];
    const llm = createSessionLLMClient(ctx, undefined, {
      onCreated: (id) => events.push("+" + id),
      onRemoved: (id) => events.push("-" + id),
      getReply: () => "ok",
    });
    await llm.chat({ system: "", messages: [{ role: "user", content: "Hi" }] });
    expect(events).toEqual(["+child-pair", "-child-pair"]);
  });
});
