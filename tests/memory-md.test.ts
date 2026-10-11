import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import {
  getMemoryIndexPath,
  getMemoryDir,
  getMemoryFilePath,
  parseMemoryIndex,
  serializeMemoryIndex,
  writeMemoryFile,
  readMemoryFile,
  applyMemoryProposal,
} from "../src/core/store/memory-md";
import type { MemoryProposal } from "../src/core/memory-types";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => "/tmp/opencode-memx-test-home" };
});

const TEST_SLUG = "root-project-test";

beforeAll(() => {
  mkdirSync("/tmp/opencode-memx-test-home/.opencode", { recursive: true });
  mkdirSync(`/tmp/opencode-memx-test-home/.opencode/projects/${TEST_SLUG}/.mem`, { recursive: true });
});

afterAll(() => {
  rmSync("/tmp/opencode-memx-test-home", { recursive: true, force: true });
});

describe("path resolution", () => {
  it("getMemoryIndexPath returns ~/.opencode/MEMORY.md", () => {
    expect(getMemoryIndexPath()).toBe("/tmp/opencode-memx-test-home/.opencode/MEMORY.md");
  });

  it("getMemoryDir returns ~/.opencode/projects/<slug>/.mem", () => {
    expect(getMemoryDir(TEST_SLUG)).toBe("/tmp/opencode-memx-test-home/.opencode/projects/root-project-test/.mem");
  });

  it("getMemoryFilePath joins dir + filename", () => {
    expect(getMemoryFilePath(TEST_SLUG, "project_auth.md")).toBe(
      "/tmp/opencode-memx-test-home/.opencode/projects/root-project-test/.mem/project_auth.md",
    );
  });
});

describe("parseMemoryIndex / serializeMemoryIndex", () => {
  it("parses empty content into empty array", () => {
    const sections = parseMemoryIndex("");
    expect(sections).toHaveLength(0);
  });

  it("parses index with one project section", () => {
    const content = `## root-project-test\n- [auth rewrite](~/.opencode/projects/root-project-test/.mem/project_auth.md) - auth rewrite driven by compliance\n`;
    const sections = parseMemoryIndex(content);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.slug).toBe("root-project-test");
    expect(sections[0]!.entries).toHaveLength(1);
    expect(sections[0]!.entries[0]!.title).toBe("auth rewrite");
  });

  it("parses multiple sections", () => {
    const content = `## root-project-a\n- [item a](~/.opencode/projects/root-project-a/.mem/a.md) - desc a\n\n## root-project-b\n- [item b](~/.opencode/projects/root-project-b/.mem/b.md) - desc b\n`;
    const sections = parseMemoryIndex(content);
    expect(sections).toHaveLength(2);
    expect(sections[0]!.slug).toBe("root-project-a");
    expect(sections[1]!.slug).toBe("root-project-b");
  });

  it("serializes sections back to markdown", () => {
    const sections = [
      {
        slug: "root-project-test",
        entries: [
          { title: "auth rewrite", filePath: "~/.opencode/projects/root-project-test/.mem/project_auth.md", hook: "auth rewrite driven by compliance", raw: "- [auth rewrite](~/.opencode/projects/root-project-test/.mem/project_auth.md) - auth rewrite driven by compliance" },
        ],
      },
    ];
    const result = serializeMemoryIndex(sections);
    expect(result).toContain("## root-project-test");
    expect(result).toContain("- [auth rewrite](~/.opencode/projects/root-project-test/.mem/project_auth.md) - auth rewrite driven by compliance");
  });
});

describe("writeMemoryFile / readMemoryFile", () => {
  it("writes and reads a memory file with frontmatter", () => {
    const proposal: MemoryProposal = {
      action: "append",
      type: "project",
      name: "auth rewrite",
      description: "auth middleware rewrite",
      content: "Rewriting auth middleware for compliance.",
      why: "Legal flagged token storage",
      how_to_apply: "Favor compliance over ergonomics",
      target_file: "project_auth_rewrite.md",
      reason: "new context",
    };
    writeMemoryFile(TEST_SLUG, proposal);
    const content = readMemoryFile(TEST_SLUG, "project_auth_rewrite.md");
    expect(content).toContain("---");
    expect(content).toContain("name: auth rewrite");
    expect(content).toContain("type: project");
    expect(content).toContain("Rewriting auth middleware for compliance.");
    expect(content).toContain("**Why:**");
    expect(content).toContain("**How to apply:**");
  });

  it("writes user/reference without Why/How to apply", () => {
    const proposal: MemoryProposal = {
      action: "append",
      type: "reference",
      name: "grafana dashboard",
      description: "grafana dashboard url",
      content: "grafana.internal/d/api-latency",
      why: null,
      how_to_apply: null,
      target_file: "reference_grafana.md",
      reason: "new resource",
    };
    writeMemoryFile(TEST_SLUG, proposal);
    const content = readMemoryFile(TEST_SLUG, "reference_grafana.md");
    expect(content).not.toContain("**Why:**");
    expect(content).not.toContain("**How to apply:**");
  });
});

describe("applyMemoryProposal", () => {
  it("append creates new memory file and adds index entry", () => {
    const existingIndex = "";
    const proposal: MemoryProposal = {
      action: "append",
      type: "project",
      name: "merge freeze",
      description: "merge freeze begins 2026-03-05",
      content: "Merge freeze after 2026-03-05 for mobile release.",
      why: "Mobile team cutting release branch",
      how_to_apply: "Flag non-critical PRs after that date",
      target_file: "project_merge_freeze.md",
      reason: "new project context",
    };
    const newIndex = applyMemoryProposal(proposal, existingIndex, TEST_SLUG);
    expect(newIndex).toContain("## root-project-test");
    expect(newIndex).toContain("project_merge_freeze.md");
    expect(existsSync(getMemoryFilePath(TEST_SLUG, "project_merge_freeze.md"))).toBe(true);
  });
});

describe("Supersedes and .trash", () => {
  it("writes Supersedes line when proposal has supersedes field", () => {
    const proposal: MemoryProposal = {
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
    };
    writeMemoryFile(TEST_SLUG, proposal);
    const content = readMemoryFile(TEST_SLUG, "feedback_real_db.md");
    expect(content).toContain("**Supersedes:** feedback_mock_db.md");
  });

  it("does not write Supersedes line when supersedes is null", () => {
    const proposal: MemoryProposal = {
      action: "append",
      type: "project",
      name: "auth rewrite",
      description: "desc",
      content: "content",
      why: "compliance",
      how_to_apply: "favor compliance",
      target_file: "project_no_super.md",
      reason: "r",
    };
    writeMemoryFile(TEST_SLUG, proposal);
    const content = readMemoryFile(TEST_SLUG, "project_no_super.md");
    expect(content).not.toContain("**Supersedes:**");
  });

  it("deprecate moves file to .trash and removes index entry", () => {
    const appendProposal: MemoryProposal = {
      action: "append",
      type: "project",
      name: "old context",
      description: "old project context",
      content: "This is old.",
      why: "old reason",
      how_to_apply: "old scope",
      target_file: "project_old.md",
      reason: "initial",
    };
    let index = applyMemoryProposal(appendProposal, "", TEST_SLUG);
    expect(index).toContain("project_old.md");
    expect(existsSync(getMemoryFilePath(TEST_SLUG, "project_old.md"))).toBe(true);

    const deprecateProposal: MemoryProposal = {
      action: "deprecate",
      type: "project",
      name: "old context",
      description: "old project context",
      content: "This is old.",
      target_file: "project_old.md",
      reason: "superseded by new context",
    };
    index = applyMemoryProposal(deprecateProposal, index, TEST_SLUG);
    expect(index).not.toContain("project_old.md");
    expect(existsSync(getMemoryFilePath(TEST_SLUG, "project_old.md"))).toBe(false);

    const trashDir = `/tmp/opencode-memx-test-home/.opencode/projects/${TEST_SLUG}/.mem/.trash`;
    const trashedFiles = readdirSync(trashDir);
    expect(trashedFiles.some((f) => f.startsWith("project_old.md."))).toBe(true);
  });
});
