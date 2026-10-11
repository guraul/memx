import { describe, it, expect } from "vitest";
import { refineMemory } from "../src/core/refine/memory-refinement";
import type { LLMClient } from "../src/core/refine/refinement";
import type { MemorySignal } from "../src/core/memory-types";

function createMockLLM(response: string): LLMClient {
  return { chat: async () => response };
}

const sampleSignals: MemorySignal[] = [
  {
    type: "project",
    name: "auth rewrite",
    description: "auth middleware rewrite driven by compliance",
    content: "Rewriting auth middleware because legal flagged token storage.",
    why: "Compliance requirements",
    how_to_apply: "Favor compliance over ergonomics",
    evidence: "user said legal flagged it",
    confidence: "high",
    source: "explicit",
  },
];

describe("refineMemory", () => {
  it("returns empty array when no signals", async () => {
    const llm = createMockLLM("[]");
    const result = await refineMemory([], llm, "");
    expect(result).toEqual([]);
  });

  it("parses valid LLM response", async () => {
    const llm = createMockLLM(
      JSON.stringify([
        {
          action: "append",
          type: "project",
          name: "auth rewrite",
          description: "auth middleware rewrite",
          content: "Rewriting auth for compliance.",
          why: "Compliance",
          how_to_apply: "Favor compliance",
          target_file: "project_auth_rewrite.md",
          reason: "new project context",
        },
      ]),
    );
    const result = await refineMemory(sampleSignals, llm, "");
    expect(result).toHaveLength(1);
    expect(result[0]!.target_file).toBe("project_auth_rewrite.md");
  });

  it("returns empty when LLM returns invalid JSON", async () => {
    const llm = createMockLLM("not json");
    const result = await refineMemory(sampleSignals, llm, "");
    expect(result).toEqual([]);
  });

  it("returns empty when schema validation fails", async () => {
    const llm = createMockLLM(JSON.stringify([{ action: "invalid" }]));
    const result = await refineMemory(sampleSignals, llm, "");
    expect(result).toEqual([]);
  });

  it("filters out empty content proposals", async () => {
    const llm = createMockLLM(
      JSON.stringify([
        { action: "append", type: "project", name: "a", description: "d", content: "", target_file: "a.md", reason: "r" },
        { action: "append", type: "project", name: "b", description: "d", content: "valid", target_file: "b.md", reason: "r" },
      ]),
    );
    const result = await refineMemory(sampleSignals, llm, "");
    expect(result).toHaveLength(1);
    expect(result[0]!.content).toBe("valid");
  });

  it("passes model param to LLM client", async () => {
    let capturedModel: string | undefined;
    const llm: LLMClient = {
      chat: async (params) => {
        capturedModel = params.model;
        return "[]";
      },
    };
    await refineMemory(sampleSignals, llm, "", "opencode/mimo-v2.6-flash-free");
    expect(capturedModel).toBe("opencode/mimo-v2.6-flash-free");
  });
});
