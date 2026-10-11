import { describe, it, expect, vi } from "vitest";
import { createSessionLLMClient } from "../src/hosts/opencode/session-llm";

/** v2 形状的 mock ctx：session.create/prompt/wait/remove + rpc.call(message.list) */
function createMockCtx(opts: {
  createdId?: string;
  messages?: Array<{ type: string; text?: string; content?: Array<{ type: string; text?: string }> }>;
  promptError?: Error;
  removeError?: Error;
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
        if (opts.removeError) throw opts.removeError;
      }),
    },
    rpc: {
      call: vi.fn(async (_method: string, input: any) => {
        calls.push(`message.list:${input.sessionID}`);
        return { data: opts.messages ?? [] };
      }),
    },
  };
  return { ctx, calls };
}

const REPLY = [
  { type: "assistant", content: [{ type: "text", text: "Hello" }, { type: "text", text: " World" }] },
];

describe("createSessionLLMClient（v2）", () => {
  it("创建子会话 → prompt → wait → rpc 取回复 → remove，返回 assistant text", async () => {
    const { ctx, calls } = createMockCtx({ createdId: "child-1", messages: REPLY });
    const hooks = { onCreated: vi.fn(), onRemoved: vi.fn() };
    const llm = createSessionLLMClient(ctx, "opencode/mimo-v2.6-flash-free", hooks);
    const result = await llm.chat({
      system: "You are helpful",
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(result).toBe("Hello World");
    expect(calls[0]).toBe("create");
    expect(calls).toContain("prompt");
    expect(calls).toContain("wait");
    expect(calls[calls.length - 1]).toBe("remove");
    expect(ctx.session.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "memx-refinement", model: "opencode/mimo-v2.6-flash-free" }),
    );
    expect(ctx.session.prompt).toHaveBeenCalledWith({ sessionID: "child-1", text: "Hi" });
    expect(hooks.onCreated).toHaveBeenCalledWith("child-1", "You are helpful");
    expect(hooks.onRemoved).toHaveBeenCalledWith("child-1");
  });

  it("assistant 的 reasoning content 不计入文本（只取 type=text）", async () => {
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
