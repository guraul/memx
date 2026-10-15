import { describe, it, expect } from "vitest";
import { refineMemory } from "../src/core/refine/memory-refinement.ts";
import type { LLMClient } from "../src/core/refine/refinement.ts";
import type { MemorySignal } from "../src/core/memory-types.ts";
import { proposalsOf } from "../src/core/refine/refine-outcome.ts";

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
  it("adjudicates empty when no signals", async () => {
    const llm = createMockLLM("[]");
    const result = await refineMemory([], llm, "");
    expect(result).toEqual({ kind: "adjudicated-empty", reason: "no-signals" });
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
    const proposals = proposalsOf(result);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.target_file).toBe("project_auth_rewrite.md");
  });

  it("reports invalid-output when LLM returns invalid JSON", async () => {
    const llm = createMockLLM("not json");
    const result = await refineMemory(sampleSignals, llm, "");
    expect(result.kind).toBe("invalid-output");
    if (result.kind === "invalid-output") expect(result.error).toMatch(/json-parse/);
  });

  it("reports invalid-output when schema validation fails", async () => {
    const llm = createMockLLM(JSON.stringify([{ action: "invalid" }]));
    const result = await refineMemory(sampleSignals, llm, "");
    expect(result.kind).toBe("invalid-output");
    if (result.kind === "invalid-output") expect(result.error).toMatch(/schema/);
  });

  it("adjudicates empty (llm-empty) for a valid empty array", async () => {
    const llm = createMockLLM("[]");
    const result = await refineMemory(sampleSignals, llm, "");
    expect(result).toEqual({ kind: "adjudicated-empty", reason: "llm-empty" });
  });

  it("filters out empty content proposals", async () => {
    const llm = createMockLLM(
      JSON.stringify([
        { action: "append", type: "project", name: "a", description: "d", content: "", target_file: "a.md", reason: "r" },
        { action: "append", type: "project", name: "b", description: "d", content: "valid", target_file: "b.md", reason: "r" },
      ]),
    );
    const result = await refineMemory(sampleSignals, llm, "");
    const proposals = proposalsOf(result);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.content).toBe("valid");
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
