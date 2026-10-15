import { describe, it, expect } from "vitest";
import { captureSignals, SignalBuffer } from "../src/core/signals/signal-capture.ts";
import type { StyleSignal } from "../src/core/types.ts";

describe("captureSignals", () => {
  it("parses valid STYLE_SIGNAL comment from AI message", () => {
    const user = "refactor this";
    const ai = "Here is the code.\n<!-- STYLE_SIGNAL: {\"category\": \"architecture\", \"content\": \"prefers Composition API\", \"evidence\": \"user asked for refactor\", \"confidence\": \"high\", \"source\": \"explicit\"} -->";
    const result = captureSignals(user, ai);
    expect(result).toHaveLength(1);
    expect(result[0]!.category).toBe("architecture");
    expect(result[0]!.content).toBe("prefers Composition API");
    expect(result[0]!.confidence).toBe("high");
  });

  it("ignores malformed JSON in STYLE_SIGNAL comment", () => {
    const user = "";
    const ai = "<!-- STYLE_SIGNAL: {invalid json} -->";
    const result = captureSignals(user, ai);
    expect(result).toHaveLength(0);
  });

  it("ignores STYLE_SIGNAL with invalid schema", () => {
    const user = "";
    const ai = "<!-- STYLE_SIGNAL: {\"category\": \"invalid\", \"content\": \"test\"} -->";
    const result = captureSignals(user, ai);
    expect(result).toHaveLength(0);
  });

  it("parses multiple STYLE_SIGNAL comments", () => {
    const user = "";
    const ai = `First comment: <!-- STYLE_SIGNAL: {"category": "communication", "content": "prefers concise", "evidence": "said keep it short", "confidence": "high", "source": "explicit"} -->
Second comment: <!-- STYLE_SIGNAL: {"category": "toolchain", "content": "prefers pnpm", "evidence": "uses pnpm", "confidence": "medium", "source": "implicit_correction"} -->`;
    const result = captureSignals(user, ai);
    expect(result).toHaveLength(2);
    expect(result[0]!.category).toBe("communication");
    expect(result[1]!.category).toBe("toolchain");
  });

  it("returns empty array when no signals present", () => {
    const user = "hello";
    const ai = "hi there, how can I help?";
    const result = captureSignals(user, ai);
    expect(result).toHaveLength(0);
  });

  it("parses confirmation source signal", () => {
    const user = "yes exactly, keep doing that";
    const ai = '<!-- STYLE_SIGNAL: {"category": "communication", "content": "terse responses with no trailing summaries", "evidence": "user confirmed terse style", "confidence": "high", "source": "confirmation"} -->';
    const result = captureSignals(user, ai);
    expect(result).toHaveLength(1);
    expect(result[0]!.source).toBe("confirmation");
  });

  it("ignores user message content - only parses AI message signals", () => {
    const user = "以后都用 pnpm 记住 我喜欢 别废话";
    const ai = "ok";
    const result = captureSignals(user, ai);
    expect(result).toHaveLength(0);
  });

  it("parses depth_signal source signal", () => {
    const ai = '<!-- STYLE_SIGNAL: {"category": "toolchain", "content": "always uses pnpm", "evidence": "user picked pnpm in 3 consecutive sessions", "confidence": "medium", "source": "depth_signal"} -->';
    const result = captureSignals("", ai);
    expect(result).toHaveLength(1);
    expect(result[0]!.source).toBe("depth_signal");
  });

  it("parses format_feedback source signal", () => {
    const ai = '<!-- STYLE_SIGNAL: {"category": "communication", "content": "no tables, use lists", "evidence": "user said 不要表格用列表", "confidence": "high", "source": "format_feedback"} -->';
    const result = captureSignals("", ai);
    expect(result).toHaveLength(1);
    expect(result[0]!.source).toBe("format_feedback");
  });

  it("ignores signals with extra unknown fields gracefully (Zod strips)", () => {
    const ai = '<!-- STYLE_SIGNAL: {"category": "communication", "content": "concise", "evidence": "said so", "confidence": "high", "source": "explicit", "extra": "ignored"} -->';
    const result = captureSignals("", ai);
    expect(result).toHaveLength(1);
  });
});

describe("SignalBuffer", () => {
  it("starts empty", () => {
    const buf = new SignalBuffer();
    expect(buf.length).toBe(0);
    expect(buf.getAll()).toEqual([]);
  });

  it("adds signals", () => {
    const buf = new SignalBuffer();
    const signal: StyleSignal = {
      category: "communication",
      content: "prefers concise",
      evidence: "said so",
      confidence: "high",
      source: "explicit",
    };
    buf.push(signal);
    expect(buf.length).toBe(1);
    expect(buf.getAll()).toEqual([signal]);
  });

  it("drops oldest when over max (20)", () => {
    const buf = new SignalBuffer();
    for (let i = 0; i < 25; i++) {
      buf.push({
        category: "communication",
        content: `signal ${i}`,
        evidence: `test ${i}`,
        confidence: "medium",
        source: "explicit",
      });
    }
    expect(buf.length).toBe(20);
    const signals = buf.getAll();
    expect(signals[0]!.content).toBe("signal 5");
    expect(signals[19]!.content).toBe("signal 24");
  });

  it("clears all signals", () => {
    const buf = new SignalBuffer();
    buf.push({
      category: "communication",
      content: "test",
      evidence: "test",
      confidence: "medium",
      source: "explicit",
    });
    buf.clear();
    expect(buf.length).toBe(0);
    expect(buf.getAll()).toEqual([]);
  });

  it("pushAll adds multiple signals", () => {
    const buf = new SignalBuffer();
    const signals: StyleSignal[] = [
      {
        category: "communication",
        content: "a",
        evidence: "evidence a",
        confidence: "high",
        source: "explicit",
      },
      {
        category: "toolchain",
        content: "b",
        evidence: "evidence b",
        confidence: "medium",
        source: "confirmation",
      },
    ];
    buf.pushAll(signals);
    expect(buf.length).toBe(2);
  });

  it("dedups signals with same evidence", () => {
    const buf = new SignalBuffer();
    const signal: StyleSignal = {
      category: "communication",
      content: "a",
      evidence: "same",
      confidence: "high",
      source: "explicit",
    };
    buf.push(signal);
    buf.push({ ...signal, content: "b" });
    expect(buf.length).toBe(1);
    expect(buf.getAll()[0]!.content).toBe("a");
  });
});
