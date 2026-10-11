import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync } from "fs";
import { runHealthCheck, autoFix, formatHealthLog, rebuildIndex } from "../src/core/health/memory-health";
import { applyMemoryProposal } from "../src/core/store/memory-md";
import type { MemoryProposal } from "../src/core/memory-types";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => "/tmp/opencode-memx-test-home" };
});

const TEST_SLUG = "root-project-test";

beforeAll(() => {
  mkdirSync(`/tmp/opencode-memx-test-home/.opencode/projects/${TEST_SLUG}/.mem`, { recursive: true });
});

afterAll(() => {
  rmSync("/tmp/opencode-memx-test-home", { recursive: true, force: true });
});

function makeProposal(targetFile: string, name: string, desc: string): MemoryProposal {
  return {
    action: "append",
    type: "project",
    name,
    description: desc,
    content: `Content for ${name}.`,
    why: "test reason",
    how_to_apply: "test scope",
    target_file: targetFile,
    reason: "test",
  };
}

describe("runHealthCheck", () => {
  it("reports no issues on clean index", () => {
    const proposal = makeProposal("project_clean.md", "clean", "clean project context");
    const index = applyMemoryProposal(proposal, "", TEST_SLUG);
    const report = runHealthCheck(index, TEST_SLUG);
    expect(report.deadLinks).toHaveLength(0);
    expect(report.orphanFiles).toHaveLength(0);
    expect(report.autoFixed).toHaveLength(0);
  });

  it("detects dead links (index points to non-existent file)", () => {
    const index = `## ${TEST_SLUG}\n- [ghost](~/.opencode/projects/${TEST_SLUG}/.mem/project_ghost.md) - ghost memory\n`;
    const report = runHealthCheck(index, TEST_SLUG);
    expect(report.deadLinks).toHaveLength(1);
    expect(report.deadLinks[0]!.title).toBe("ghost");
  });

  it("detects orphan files (.mem/*.md not in index)", () => {
    const proposal = makeProposal("project_orphan.md", "orphan", "orphan project context");
    applyMemoryProposal(proposal, "", TEST_SLUG);
    const index = `## ${TEST_SLUG}\n- [other](~/.opencode/projects/${TEST_SLUG}/.mem/project_other.md) - other context\n`;
    const report = runHealthCheck(index, TEST_SLUG);
    expect(report.orphanFiles.length).toBeGreaterThanOrEqual(1);
    const orphan = report.orphanFiles.find((o) => o.filename === "project_orphan.md");
    expect(orphan).toBeDefined();
    expect(orphan!.name).toBe("orphan");
  });

  it("counts index lines", () => {
    const index = `## ${TEST_SLUG}\n- [a](~/.opencode/projects/${TEST_SLUG}/.mem/a.md) - desc a\n- [b](~/.opencode/projects/${TEST_SLUG}/.mem/b.md) - desc b\n`;
    const report = runHealthCheck(index, TEST_SLUG);
    expect(report.indexLineCount).toBe(2);
  });

  it("flags index bloat at 200+ lines", () => {
    const lines: string[] = [`## ${TEST_SLUG}`];
    for (let i = 0; i < 205; i++) {
      lines.push(`- [item ${i}](~/.opencode/projects/${TEST_SLUG}/.mem/item${i}.md) - desc ${i}`);
    }
    const index = lines.join("\n");
    const report = runHealthCheck(index, TEST_SLUG);
    expect(report.escalated.length).toBeGreaterThan(0);
    expect(report.escalated[0]).toContain("manual merge");
  });
});

describe("autoFix", () => {
  it("removes dead links from index", () => {
    const index = `## ${TEST_SLUG}\n- [ghost](~/.opencode/projects/${TEST_SLUG}/.mem/project_ghost_dead.md) - ghost\n`;
    const report = runHealthCheck(index, TEST_SLUG);
    const { newIndex, logs } = autoFix(report, index, TEST_SLUG);
    expect(logs.some((l) => l.action === "removed-dead-pointer")).toBe(true);
    expect(newIndex).not.toContain("project_ghost_dead.md");
  });

  it("adds pointer for orphan files", () => {
    const proposal = makeProposal("project_orphan_fix.md", "orphan fix", "orphan to be fixed");
    applyMemoryProposal(proposal, "", TEST_SLUG);
    const index = `## ${TEST_SLUG}\n`;
    const report = runHealthCheck(index, TEST_SLUG);
    const { newIndex, logs } = autoFix(report, index, TEST_SLUG);
    expect(logs.some((l) => l.action === "added-pointer")).toBe(true);
    expect(newIndex).toContain("project_orphan_fix.md");
  });

  it("respects max auto-fixes limit (3)", () => {
    const lines: string[] = [`## ${TEST_SLUG}`];
    for (let i = 0; i < 5; i++) {
      lines.push(`- [dead ${i}](~/.opencode/projects/${TEST_SLUG}/.mem/dead${i}.md) - dead ${i}`);
    }
    const index = lines.join("\n");
    const report = runHealthCheck(index, TEST_SLUG);
    const { logs } = autoFix(report, index, TEST_SLUG);
    const fixes = logs.filter((l) => l.action === "removed-dead-pointer");
    const escalated = logs.filter((l) => l.action === "escalated-manual");
    expect(fixes.length).toBe(3);
    expect(escalated.length).toBeGreaterThanOrEqual(2);
  });
});

describe("formatHealthLog", () => {
  it("formats logs as HTML comments", () => {
    const logs = [
      { action: "removed-dead-pointer" as const, target: "ghost.md", reason: "file not found" },
      { action: "added-pointer" as const, target: "orphan.md", reason: "orphan file" },
    ];
    const result = formatHealthLog(logs);
    expect(result).toContain("<!--");
    expect(result).toContain("auto-fix:");
    expect(result).toContain("removed-dead-pointer");
    expect(result).toContain("added-pointer");
  });

  it("returns empty string for no logs", () => {
    expect(formatHealthLog([])).toBe("");
  });
});

describe("rebuildIndex", () => {
  it("rebuilds index from .mem frontmatter", () => {
    const p1 = makeProposal("project_r1.md", "r1", "project r1 context");
    const p2 = makeProposal("reference_r2.md", "r2", "reference r2 context");
    const p3 = makeProposal("user_r3.md", "r3", "user r3 context");
    applyMemoryProposal(p1, "", TEST_SLUG);
    applyMemoryProposal(p2, "", TEST_SLUG);
    applyMemoryProposal(p3, "", TEST_SLUG);

    const rebuilt = rebuildIndex(TEST_SLUG);
    expect(rebuilt).toContain(`## ${TEST_SLUG}`);
    expect(rebuilt).toContain("project_r1.md");
    expect(rebuilt).toContain("reference_r2.md");
    expect(rebuilt).toContain("user_r3.md");
  });

  it("sorts by type order (user -> feedback -> project -> reference)", () => {
    const p1 = makeProposal("project_sort.md", "p1", "project desc");
    applyMemoryProposal(p1, "", TEST_SLUG);
    const p2: MemoryProposal = {
      action: "append",
      type: "user",
      name: "u1",
      description: "user desc",
      content: "user content",
      target_file: "user_sort.md",
      reason: "test",
    };
    applyMemoryProposal(p2, "", TEST_SLUG);

    const rebuilt = rebuildIndex(TEST_SLUG);
    const userIdx = rebuilt.indexOf("user_sort.md");
    const projectIdx = rebuilt.indexOf("project_sort.md");
    expect(userIdx).toBeLessThan(projectIdx);
  });

  it("returns empty string when .mem dir does not exist", () => {
    expect(rebuildIndex("nonexistent-slug")).toBe("");
  });

  it("skips .trash files", () => {
    const p = makeProposal("project_skip.md", "skip", "skip desc");
    applyMemoryProposal(p, "", TEST_SLUG);
    const rebuilt = rebuildIndex(TEST_SLUG);
    expect(rebuilt).not.toContain(".trash");
  });
});
