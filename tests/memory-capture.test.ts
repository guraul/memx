import { describe, it, expect } from "vitest";
import { captureMemorySignals, MemorySignalBuffer } from "../src/core/signals/memory-capture";
import type { MemorySignal } from "../src/core/memory-types";

describe("captureMemorySignals", () => {
  it("parses valid MEMORY_SIGNAL comment from AI message", () => {
    const ai = `Here is my reply.
<!-- MEMORY_SIGNAL: {"type":"project","name":"auth rewrite","description":"auth middleware rewrite driven by compliance","content":"Rewriting auth middleware for compliance.","why":"Legal flagged token storage","how_to_apply":"Favor compliance over ergonomics","evidence":"user said legal flagged it","confidence":"high","source":"explicit"} -->`;
    const result = captureMemorySignals(ai);
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("project");
    expect(result[0]!.name).toBe("auth rewrite");
  });

  it("ignores malformed JSON", () => {
    const ai = "<!-- MEMORY_SIGNAL: {invalid} -->";
    const result = captureMemorySignals(ai);
    expect(result).toHaveLength(0);
  });

  it("ignores invalid schema (missing required why for project type)", () => {
    const ai = '<!-- MEMORY_SIGNAL: {"type":"project","name":"test","description":"d","content":"c","evidence":"e","confidence":"high","source":"explicit"} -->';
    const result = captureMemorySignals(ai);
    expect(result).toHaveLength(0);
  });

  it("parses multiple signals", () => {
    const ai = `First: <!-- MEMORY_SIGNAL: {"type":"reference","name":"grafana","description":"grafana dashboard","content":"grafana.internal","evidence":"user mentioned","confidence":"high","source":"explicit"} -->
Second: <!-- MEMORY_SIGNAL: {"type":"user","name":"role","description":"data scientist","content":"User is a data scientist.","evidence":"user said","confidence":"high","source":"explicit"} -->`;
    const result = captureMemorySignals(ai);
    expect(result).toHaveLength(2);
    expect(result[0]!.type).toBe("reference");
    expect(result[1]!.type).toBe("user");
  });

  it("returns empty when no signals", () => {
    const ai = "just a normal reply";
    const result = captureMemorySignals(ai);
    expect(result).toHaveLength(0);
  });

  it("does not parse STYLE_SIGNAL comments (separate channel)", () => {
    const ai = '<!-- STYLE_SIGNAL: {"category":"communication","content":"test","evidence":"e","confidence":"high","source":"explicit"} -->';
    const result = captureMemorySignals(ai);
    expect(result).toHaveLength(0);
  });
});

describe("MemorySignalBuffer", () => {
  it("starts empty", () => {
    const buf = new MemorySignalBuffer();
    expect(buf.length).toBe(0);
  });

  it("adds signals", () => {
    const buf = new MemorySignalBuffer();
    const signal: MemorySignal = {
      type: "project",
      name: "auth rewrite",
      description: "desc",
      content: "content",
      why: "compliance",
      how_to_apply: "favor compliance",
      evidence: "evidence",
      confidence: "high",
      source: "explicit",
    };
    buf.push(signal);
    expect(buf.length).toBe(1);
  });

  it("dedups by evidence", () => {
    const buf = new MemorySignalBuffer();
    const signal: MemorySignal = {
      type: "project",
      name: "auth rewrite",
      description: "desc",
      content: "content",
      why: "compliance",
      how_to_apply: "favor compliance",
      evidence: "same evidence",
      confidence: "high",
      source: "explicit",
    };
    buf.push(signal);
    buf.push({ ...signal, name: "different name" });
    expect(buf.length).toBe(1);
  });

  it("drops oldest at max 20", () => {
    const buf = new MemorySignalBuffer();
    for (let i = 0; i < 25; i++) {
      buf.push({
        type: "user",
        name: `role ${i}`,
        description: `desc ${i}`,
        content: `content ${i}`,
        evidence: `evidence ${i}`,
        confidence: "medium",
        source: "explicit",
      });
    }
    expect(buf.length).toBe(20);
  });

  it("clears all", () => {
    const buf = new MemorySignalBuffer();
    buf.push({
      type: "user",
      name: "role",
      description: "desc",
      content: "content",
      evidence: "evidence",
      confidence: "high",
      source: "explicit",
    });
    buf.clear();
    expect(buf.length).toBe(0);
  });
});
