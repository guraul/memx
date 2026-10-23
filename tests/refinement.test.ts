import { describe, it, expect } from "vitest";
import { refine } from "../src/core/refine/refinement.ts";
import type { LLMClient } from "../src/core/refine/refinement.ts";
import type { StyleSignal } from "../src/core/types.ts";
import { proposalsOf } from "../src/core/refine/refine-outcome.ts";

function createMockLLM(response: string): LLMClient {
  return {
    chat: async () => response,
  };
}

const sampleSignals: StyleSignal[] = [
  {
    category: "communication",
    content: "偏好直接给出完整代码",
    evidence: "用户说'直接给完整的代码就行'",
    confidence: "high",
    source: "explicit",
  },
  {
    category: "toolchain",
    content: "使用 pnpm 而非 npm",
    evidence: "用户说'以后都用 pnpm'",
    confidence: "high",
    source: "explicit",
  },
];

describe("refine", () => {
  it("adjudicates empty when no signals provided", async () => {
    const llm = createMockLLM("[]");
    const result = await refine([], llm, "");
    expect(result).toEqual({ kind: "adjudicated-empty", reason: "no-signals" });
  });

  it("parses valid LLM response into StyleProposal array", async () => {
    const llm = createMockLLM(
      JSON.stringify([
        {
          action: "append",
          category: "communication",
          content: "偏好直接给出完整代码",
          reason: "用户明确要求",
        },
      ]),
    );
    const result = await refine(sampleSignals, llm, "# User Profile & Style\n\n\n");
    expect(result.kind).toBe("proposals");
    const proposals = proposalsOf(result);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.action).toBe("append");
    expect(proposals[0]!.category).toBe("communication");
  });

  it("reports invalid-output (not empty) when LLM returns invalid JSON", async () => {
    const llm = createMockLLM("not json at all");
    const result = await refine(sampleSignals, llm, "");
    expect(result.kind).toBe("invalid-output");
    if (result.kind === "invalid-output") {
      expect(result.error).toMatch(/json-parse/);
      expect(result.rawSnippet).toContain("not json");
    }
  });

  it("reports invalid-output (not empty) when LLM returns invalid schema", async () => {
    const llm = createMockLLM(
      JSON.stringify([{ action: "invalid_action", category: "unknown" }]),
    );
    const result = await refine(sampleSignals, llm, "");
    expect(result.kind).toBe("invalid-output");
    if (result.kind === "invalid-output") expect(result.error).toMatch(/schema/);
  });

  it("adjudicates empty (llm-empty) when LLM returns empty array", async () => {
    const llm = createMockLLM("[]");
    const result = await refine(sampleSignals, llm, "");
    expect(result).toEqual({ kind: "adjudicated-empty", reason: "llm-empty" });
  });

  it("rejects an empty-content append at schema level (invalid-output)", async () => {
    const llm = createMockLLM(
      JSON.stringify([{ action: "append", category: "communication", content: "", reason: "empty" }]),
    );
    const result = await refine(sampleSignals, llm, "");
    expect(result.kind).toBe("invalid-output");
    if (result.kind === "invalid-output") {
      expect(result.error).toMatch(/schema/);
      expect(result.error).toMatch(/append requires non-empty content/);
    }
  });

  it("rejects an empty-content update at schema level (invalid-output)", async () => {
    const llm = createMockLLM(
      JSON.stringify([
        { action: "update", category: "communication", content: "", target_text: "先给结论", reason: "empty" },
      ]),
    );
    const result = await refine(sampleSignals, llm, "");
    expect(result.kind).toBe("invalid-output");
    if (result.kind === "invalid-output") {
      expect(result.error).toMatch(/update requires non-empty content/);
    }
  });

  it("drops only the bad proposal in a batch (one bad does not sink the batch) (#9)", async () => {
    const llm = createMockLLM(
      JSON.stringify([
        { action: "append", category: "communication", content: "", reason: "empty" },
        { action: "append", category: "toolchain", content: "项目内跑测试一律用 pnpm", reason: "valid" },
      ]),
    );
    const result = await refine(sampleSignals, llm, "");
    expect(result.kind).toBe("proposals");
    const proposals = proposalsOf(result);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.content).toBe("项目内跑测试一律用 pnpm");
    if (result.kind === "proposals") {
      expect(result.dropped).toBe(1);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings![0]).toMatch(/proposal\[0\] dropped/);
      expect(result.warnings![0]).toMatch(/append requires non-empty content/);
    }
  });

  it("reports invalid-output when every proposal in the batch is invalid (#9)", async () => {
    const llm = createMockLLM(
      JSON.stringify([
        { action: "append", category: "communication", content: "", reason: "empty" },
        { action: "update", category: "toolchain", content: "", reason: "empty" },
      ]),
    );
    const result = await refine(sampleSignals, llm, "");
    expect(result.kind).toBe("invalid-output");
    if (result.kind === "invalid-output") {
      expect(result.error).toMatch(/schema/);
      expect(result.error).toMatch(/proposal\[0\]/);
      expect(result.error).toMatch(/proposal\[1\]/);
    }
  });

  it("reports invalid-output when the payload is not an array (#9)", async () => {
    const llm = createMockLLM(JSON.stringify({ action: "append", content: "x" }));
    const result = await refine(sampleSignals, llm, "");
    expect(result.kind).toBe("invalid-output");
    if (result.kind === "invalid-output") expect(result.error).toMatch(/expected array/);
  });

  it("keeps a deprecate proposal whose content is empty (#9)", async () => {
    const llm = createMockLLM(
      JSON.stringify([
        {
          action: "deprecate",
          category: "toolchain",
          content: "",
          target_text: "项目内跑测试一律用 npm",
          target_line: 6,
          reason: "被新信号 pnpm 取代",
        },
        {
          action: "append",
          category: "toolchain",
          content: "项目内跑测试一律用 pnpm",
          reason: "新信号",
        },
      ]),
    );
    const result = await refine(sampleSignals, llm, "");
    const proposals = proposalsOf(result);
    expect(proposals).toHaveLength(2);
    expect(proposals[0]!.action).toBe("deprecate");
    expect(proposals[0]!.content).toBe("");
    expect(proposals[0]!.target_text).toBe("项目内跑测试一律用 npm");
  });

  it("keeps a deprecate proposal whose content field is omitted (#9)", async () => {
    const llm = createMockLLM(
      JSON.stringify([
        {
          action: "deprecate",
          category: "toolchain",
          target_text: "项目内跑测试一律用 npm",
          reason: "被新信号 pnpm 取代",
        },
      ]),
    );
    const result = await refine(sampleSignals, llm, "");
    const proposals = proposalsOf(result);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.action).toBe("deprecate");
    expect(proposals[0]!.content).toBe("");
  });

  it("keeps a deprecate proposal with content (unchanged behavior)", async () => {
    const llm = createMockLLM(
      JSON.stringify([
        {
          action: "deprecate",
          category: "toolchain",
          content: "已改用 pnpm",
          target_text: "项目内跑测试一律用 npm",
          reason: "被新信号取代",
        },
      ]),
    );
    const result = await refine(sampleSignals, llm, "");
    const proposals = proposalsOf(result);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.content).toBe("已改用 pnpm");
  });

  it("works with non-empty USER.md content", async () => {
    const existingMd = `# User Profile & Style

> Auto-generated by opencode-memx. Last updated: 2026-07-29

## 沟通与交互风格
- [2026-07-28] 回答技术问题时先给结论，再展开推导过程
`;

    const llm = createMockLLM(
      JSON.stringify([
        {
          action: "update",
          category: "communication",
          content: "偏好直接给出完整代码而非分步骤解释",
          target_line: 6,
          target_text: "回答技术问题时先给结论，再展开推导过程",
          reason: "用户新偏好",
        },
      ]),
    );
    const result = await refine(sampleSignals, llm, existingMd);
    const proposals = proposalsOf(result);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.action).toBe("update");
    expect(proposals[0]!.target_line).toBe(6);
    expect(proposals[0]!.target_text).toBe("回答技术问题时先给结论，再展开推导过程");
  });

  it("numbers the existing USER.md lines in the LLM request (P0-3 fallback)", async () => {
    let captured = "";
    const llm: LLMClient = {
      chat: async (params) => {
        captured = params.messages[0]?.content ?? "";
        return "[]";
      },
    };
    await refine(sampleSignals, llm, "# User Profile & Style\n\n## 沟通与交互风格\n- [2026-07-28] 先给结论\n");
    expect(captured).toContain("1| # User Profile & Style");
    expect(captured).toContain("4| - [2026-07-28] 先给结论");
  });
});
