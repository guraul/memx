import { describe, it, expect, vi } from "vitest";
import { createSessionLLMClient } from "../src/hosts/opencode/session-llm";

function createMockClient(opts: {
  createdId?: string;
  promptParts?: Array<{ type: string; text?: string }>;
  promptError?: Error;
  deleteError?: Error;
}) {
  const calls: any[] = [];
  const client: any = {
    session: {
      create: vi.fn(async () => {
        calls.push({ method: "create" });
        return { data: { id: opts.createdId ?? "child-session-123" } };
      }),
      prompt: vi.fn(async () => {
        if (opts.promptError) throw opts.promptError;
        calls.push({ method: "prompt" });
        return { data: { parts: opts.promptParts ?? [] } };
      }),
      delete: vi.fn(async () => {
        calls.push({ method: "delete" });
        if (opts.deleteError) throw opts.deleteError;
        return { data: true };
      }),
    },
  };
  return { client, calls };
}

describe("createSessionLLMClient", () => {
  it("creates child session, prompts, returns text, deletes child", async () => {
    const { client, calls } = createMockClient({
      createdId: "child-1",
      promptParts: [
        { type: "text", text: "Hello" },
        { type: "text", text: " World" },
      ],
    });
    const llm = createSessionLLMClient(client, "deepseek/deepseek-chat-v4-flash");
    const result = await llm.chat({
      system: "You are helpful",
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(result).toBe("Hello World");
    expect(calls.map((c) => c.method)).toEqual(["create", "prompt", "delete"]);
    expect(client.session.prompt).toHaveBeenCalledWith({
      path: { id: "child-1" },
      body: expect.objectContaining({
        system: "You are helpful",
        parts: [{ type: "text", text: "Hi" }],
        model: { providerID: "deepseek", modelID: "deepseek-chat-v4-flash" },
      }),
    });
  });

  it("returns empty string when no text parts", async () => {
    const { client } = createMockClient({
      promptParts: [{ type: "reasoning", text: "..." }],
    });
    const llm = createSessionLLMClient(client);
    const result = await llm.chat({
      system: "",
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(result).toBe("");
  });

  it("deletes child session even on prompt error", async () => {
    const { client, calls } = createMockClient({
      createdId: "child-err",
      promptError: new Error("LLM failed"),
    });
    const llm = createSessionLLMClient(client);
    await expect(
      llm.chat({ system: "", messages: [{ role: "user", content: "Hi" }] }),
    ).rejects.toThrow("LLM failed");
    expect(calls.map((c) => c.method)).toEqual(["create", "delete"]);
  });

  it("does not pass model when undefined", async () => {
    const { client } = createMockClient({
      promptParts: [{ type: "text", text: "ok" }],
    });
    const llm = createSessionLLMClient(client);
    await llm.chat({ system: "", messages: [{ role: "user", content: "Hi" }] });
    const promptCall = client.session.prompt.mock.calls[0][0];
    expect(promptCall.body).not.toHaveProperty("model");
  });

  it("calls onCreated with the child session id", async () => {
    const { client } = createMockClient({
      createdId: "child-cb",
      promptParts: [{ type: "text", text: "ok" }],
    });
    const onCreated = vi.fn();
    const llm = createSessionLLMClient(client, undefined, onCreated);
    await llm.chat({ system: "", messages: [{ role: "user", content: "Hi" }] });
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledWith("child-cb");
  });
});
