import { describe, it, expect } from "vitest";
import { deriveSlug, MemorySignalSchema, MemoryProposalSchema, MemoryProposalArraySchema } from "../src/core/memory-types.ts";

describe("deriveSlug", () => {
  it("converts /root/project/foo to root-project-foo", () => {
    expect(deriveSlug("/root/project/foo")).toBe("root-project-foo");
  });

  it("handles single-level path /foo", () => {
    expect(deriveSlug("/foo")).toBe("foo");
  });

  it("handles trailing slash", () => {
    expect(deriveSlug("/root/project/foo/")).toBe("root-project-foo");
  });

  it("#36 根目录 → root，但取不到目录（空/全空白）仍是空串", () => {
    expect(deriveSlug("/")).toBe("root");
    expect(deriveSlug("///")).toBe("root");
    // DSH 拿空串当"未知"哨兵（memory_write 失败 / memory_search 全库），不能被吞成 root
    expect(deriveSlug("")).toBe("");
    expect(deriveSlug("   ")).toBe("");
  });
});

describe("MemorySignalSchema", () => {
  const validSignal = {
    type: "project",
    name: "auth rewrite",
    description: "auth middleware rewrite driven by legal/compliance",
    content: "Rewriting auth middleware because legal flagged session token storage.",
    why: "Compliance requirements, not tech debt",
    how_to_apply: "Scope decisions favor compliance over ergonomics",
    evidence: "user said legal flagged it",
    confidence: "high",
    source: "explicit",
  };

  it("accepts a valid project signal with why and how_to_apply", () => {
    const result = MemorySignalSchema.safeParse(validSignal);
    expect(result.success).toBe(true);
  });

  it("rejects project signal without why", () => {
    const { why, ...withoutWhy } = validSignal;
    const result = MemorySignalSchema.safeParse(withoutWhy);
    expect(result.success).toBe(false);
  });

  it("accepts user signal without why or how_to_apply", () => {
    const result = MemorySignalSchema.safeParse({
      type: "user",
      name: "user role",
      description: "data scientist focused on observability",
      content: "User is a data scientist.",
      evidence: "user said so",
      confidence: "high",
      source: "explicit",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid type", () => {
    const result = MemorySignalSchema.safeParse({ ...validSignal, type: "invalid" });
    expect(result.success).toBe(false);
  });

  it("strips unknown fields (Zod default behavior)", () => {
    const result = MemorySignalSchema.safeParse({ ...validSignal, extra: "ignored" });
    expect(result.success).toBe(true);
  });
});

describe("MemoryProposalSchema", () => {
  it("accepts valid append proposal", () => {
    const result = MemoryProposalSchema.safeParse({
      action: "append",
      type: "project",
      name: "auth rewrite",
      description: "auth middleware rewrite",
      content: "Rewriting auth middleware.",
      why: "Compliance",
      how_to_apply: "Favor compliance",
      target_file: "project_auth_rewrite.md",
      reason: "new project context",
    });
    expect(result.success).toBe(true);
  });

  it("accepts proposal with supersedes field", () => {
    const result = MemoryProposalSchema.safeParse({
      action: "append",
      type: "feedback",
      name: "real DB required",
      description: "integration tests must hit real DB",
      content: "Use real DB not mocks.",
      why: "Mock prod divergence",
      how_to_apply: "All integration tests",
      target_file: "feedback_real_db.md",
      supersedes: "feedback_mock_db.md",
      reason: "reverses previous guidance",
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.supersedes).toBe("feedback_mock_db.md");
  });

  it("accepts proposal without supersedes (omitted)", () => {
    const result = MemoryProposalSchema.safeParse({
      action: "append",
      type: "project",
      name: "auth rewrite",
      description: "desc",
      content: "content",
      target_file: "project_auth.md",
      reason: "r",
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.supersedes).toBeUndefined();
  });

  it("accepts proposal with null why/how_to_apply (user/reference types)", () => {
    const result = MemoryProposalSchema.safeParse({
      action: "append",
      type: "reference",
      name: "grafana dashboard",
      description: "grafana dashboard url",
      content: "grafana.internal/d/api-latency",
      why: null,
      how_to_apply: null,
      target_file: "reference_grafana.md",
      reason: "new external resource",
    });
    expect(result.success).toBe(true);
  });

  it("rejects proposal missing target_file", () => {
    const result = MemoryProposalSchema.safeParse({
      action: "append",
      type: "project",
      name: "auth",
      description: "desc",
      content: "content",
      reason: "r",
    });
    expect(result.success).toBe(false);
  });

  it("rejects proposal missing reason", () => {
    const result = MemoryProposalSchema.safeParse({
      action: "append",
      type: "project",
      name: "auth",
      description: "desc",
      content: "content",
      target_file: "project_auth.md",
    });
    expect(result.success).toBe(false);
  });
});

describe("MemoryProposalArraySchema", () => {
  it("accepts array of proposals", () => {
    const result = MemoryProposalArraySchema.safeParse([
      {
        action: "append",
        type: "project",
        name: "auth rewrite",
        description: "desc",
        content: "content",
        why: "compliance",
        how_to_apply: "favor compliance",
        target_file: "project_auth_rewrite.md",
        reason: "new context",
      },
    ]);
    expect(result.success).toBe(true);
  });

  it("accepts empty array", () => {
    const result = MemoryProposalArraySchema.safeParse([]);
    expect(result.success).toBe(true);
  });
});
