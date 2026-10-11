import { describe, it, expect } from "vitest";
import { extractLastTurn } from "../src/hosts/opencode/index";

/** v2 message.list 形状（user 扁平 {text}；assistant {content:[{type,text}]}） */
describe("extractLastTurn（v2 消息形状）", () => {
  it("returns null when no user message exists", () => {
    const msgs = [{ type: "assistant", content: [{ type: "text", text: "hi" }] }];
    expect(extractLastTurn(msgs)).toBeNull();
  });

  it("returns user text and empty assistant when no assistant follows", () => {
    const msgs = [{ type: "user", text: "hello" }];
    expect(extractLastTurn(msgs)).toEqual({ user: "hello", assistant: "" });
  });

  it("extracts last user message and first assistant after it", () => {
    const msgs = [
      { type: "user", text: "first" },
      { type: "assistant", content: [{ type: "text", text: "reply1" }] },
      { type: "user", text: "second" },
      { type: "assistant", content: [{ type: "text", text: "reply2" }] },
    ];
    expect(extractLastTurn(msgs)).toEqual({ user: "second", assistant: "reply2" });
  });

  it("assistant 只取 content 里的 text（reasoning/tool 不计）", () => {
    const msgs = [
      { type: "user", text: "q" },
      { type: "assistant", content: [{ type: "reasoning", text: "ignore" }, { type: "text", text: "a" }] },
    ];
    expect(extractLastTurn(msgs)).toEqual({ user: "q", assistant: "a" });
  });
});
