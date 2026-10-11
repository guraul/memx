import { describe, it, expect } from "vitest";
import { extractLastTurn } from "../src/hosts/opencode/index";

describe("extractLastTurn", () => {
  it("returns null when no user message exists", () => {
    const msgs = [{ info: { role: "assistant" }, parts: [{ type: "text", text: "hi" }] }];
    expect(extractLastTurn(msgs as any)).toBeNull();
  });

  it("returns user text and empty assistant when no assistant follows", () => {
    const msgs = [{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] }];
    const result = extractLastTurn(msgs as any);
    expect(result).toEqual({ user: "hello", assistant: "" });
  });

  it("extracts last user message and first assistant after it", () => {
    const msgs = [
      { info: { role: "user" }, parts: [{ type: "text", text: "first" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "reply1" }] },
      { info: { role: "user" }, parts: [{ type: "text", text: "second" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "reply2" }] },
    ];
    const result = extractLastTurn(msgs as any);
    expect(result).toEqual({ user: "second", assistant: "reply2" });
  });

  it("filters non-text parts", () => {
    const msgs = [
      { info: { role: "user" }, parts: [{ type: "text", text: "q" }, { type: "reasoning", text: "ignore" }] },
      { info: { role: "assistant" }, parts: [{ type: "tool", text: "ignore" }, { type: "text", text: "a" }] },
    ];
    const result = extractLastTurn(msgs as any);
    expect(result).toEqual({ user: "q", assistant: "a" });
  });
});
