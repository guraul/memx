import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync, chmodSync } from "fs";
import {
  getMemoryIndexPath,
  getMemoryDir,
  getMemoryFilePath,
  parseMemoryIndex,
  serializeMemoryIndex,
  writeMemoryFile,
  readMemoryFile,
  applyMemoryProposal,
  applyMemoryProposals,
} from "../src/core/store/memory-md.ts";
import type { MemoryProposal } from "../src/core/memory-types.ts";

const TEST_HOME = vi.hoisted(() => `/tmp/opencode-memx-test-home-md-${process.pid}`);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => TEST_HOME };
});

const TEST_SLUG = "root-project-test";

beforeAll(() => {
  mkdirSync(`${TEST_HOME}/.opencode`, { recursive: true });
  mkdirSync(`${TEST_HOME}/.opencode/projects/${TEST_SLUG}/.mem`, { recursive: true });
});

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("path resolution", () => {
  it("getMemoryIndexPath returns ~/.opencode/MEMORY.md", () => {
    expect(getMemoryIndexPath()).toBe(`${TEST_HOME}/.opencode/MEMORY.md`);
  });

  it("getMemoryDir returns ~/.opencode/projects/<slug>/.mem", () => {
    expect(getMemoryDir(TEST_SLUG)).toBe(`${TEST_HOME}/.opencode/projects/root-project-test/.mem`);
  });

  it("getMemoryFilePath joins dir + filename", () => {
    expect(getMemoryFilePath(TEST_SLUG, "project_auth.md")).toBe(
      `${TEST_HOME}/.opencode/projects/root-project-test/.mem/project_auth.md`,
    );
  });
});

describe("parseMemoryIndex / serializeMemoryIndex", () => {
  it("parses empty content into empty doc", () => {
    const doc = parseMemoryIndex("");
    expect(doc.sections).toHaveLength(0);
    expect(doc.preamble).toHaveLength(0);
  });

  it("parses index with one project section", () => {
    const content = `## root-project-test\n- [auth rewrite](~/.opencode/projects/root-project-test/.mem/project_auth.md) - auth rewrite driven by compliance\n`;
    const doc = parseMemoryIndex(content);
    expect(doc.sections).toHaveLength(1);
    expect(doc.sections[0]!.slug).toBe("root-project-test");
    expect(doc.sections[0]!.entries).toHaveLength(1);
    expect(doc.sections[0]!.entries[0]!.title).toBe("auth rewrite");
  });

  it("parses multiple sections", () => {
    const content = `## root-project-a\n- [item a](~/.opencode/projects/root-project-a/.mem/a.md) - desc a\n\n## root-project-b\n- [item b](~/.opencode/projects/root-project-b/.mem/b.md) - desc b\n`;
    const doc = parseMemoryIndex(content);
    expect(doc.sections).toHaveLength(2);
    expect(doc.sections[0]!.slug).toBe("root-project-a");
    expect(doc.sections[1]!.slug).toBe("root-project-b");
  });

  it("keeps health-log comments and prose across parse/serialize", () => {
    // auto-fix 追加的 HTML 注释是追加在序列化结果之后的，非受管 → 必须能带回去
    const content = `# MEMORY

一些说明文字

## root-project-test
- [item a](~/.opencode/projects/root-project-test/.mem/a.md) - desc a

<!-- 2026-10-12 auto-fix: removed-dead-pointer ~/.opencode/projects/root-project-test/.mem/gone.md - file not found in .mem/ -->
`;
    const serialized = serializeMemoryIndex(parseMemoryIndex(content));
    expect(serialized).toContain("# MEMORY");
    expect(serialized).toContain("一些说明文字");
    expect(serialized).toContain("auto-fix: removed-dead-pointer");
    expect(serialized).toContain("- [item a](~/.opencode/projects/root-project-test/.mem/a.md) - desc a");
  });

  it("serializeMemoryIndex(parseMemoryIndex(x)) is idempotent", () => {
    const content = `# MEMORY\n\n## root-project-a\n- [item a](~/.opencode/projects/root-project-a/.mem/a.md) - desc a\n\n<!-- health log -->\n`;
    const first = serializeMemoryIndex(parseMemoryIndex(content));
    const second = serializeMemoryIndex(parseMemoryIndex(first));
    expect(second).toBe(first);
    expect(first.match(/## root-project-a/g)).toHaveLength(1);
    expect(first.match(/health log/g)).toHaveLength(1);
  });

  it("serializes sections back to markdown", () => {
    const doc = {
      preamble: [],
      sections: [
        {
          slug: "root-project-test",
          entries: [
            { title: "auth rewrite", filePath: "~/.opencode/projects/root-project-test/.mem/project_auth.md", hook: "auth rewrite driven by compliance", raw: "- [auth rewrite](~/.opencode/projects/root-project-test/.mem/project_auth.md) - auth rewrite driven by compliance" },
          ],
        },
      ],
    };
    const result = serializeMemoryIndex(doc);
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

describe("applyMemoryProposal keeps unmanaged index content", () => {
  const BASE_INDEX = `# MEMORY

手写说明

## root-project-test
- [old thing](~/.opencode/projects/root-project-test/.mem/project_old.md) - old project context

<!-- 2026-10-12 auto-fix: removed-dead-pointer ~/.opencode/projects/root-project-test/.mem/gone.md - file not found -->
`;

  it("append preserves health logs and prose", () => {
    const proposal: MemoryProposal = {
      action: "append",
      type: "project",
      name: "merge freeze",
      description: "merge freeze begins 2026-03-05",
      content: "Merge freeze after 2026-03-05.",
      why: "Mobile team cutting release branch",
      how_to_apply: "Flag non-critical PRs",
      target_file: "project_merge_freeze.md",
      reason: "new project context",
    };
    const newIndex = applyMemoryProposal(proposal, BASE_INDEX, TEST_SLUG);
    expect(newIndex).toContain("# MEMORY");
    expect(newIndex).toContain("手写说明");
    expect(newIndex).toContain("auto-fix: removed-dead-pointer");
    expect(newIndex).toContain("project_merge_freeze.md");
    expect(newIndex).toContain("old thing");
  });

  it("deprecate preserves health logs and prose", () => {
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
    index += "\n<!-- 2026-10-12 auto-fix: added-pointer orphan.md - orphan file detected -->\n";
    expect(index).toContain("added-pointer");

    const deprecateProposal: MemoryProposal = {
      action: "deprecate",
      type: "project",
      name: "old context",
      description: "old project context",
      content: "This is old.",
      target_file: "project_old.md",
      reason: "superseded",
    };
    index = applyMemoryProposal(deprecateProposal, index, TEST_SLUG);
    expect(index).not.toContain("project_old.md");
    expect(index).toContain("added-pointer");
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

  it("deprecate with empty content still trashes file and removes index entry (#9)", () => {
    const appendProposal: MemoryProposal = {
      action: "append",
      type: "project",
      name: "stale context",
      description: "stale project context",
      content: "This is stale.",
      why: "stale reason",
      how_to_apply: "stale scope",
      target_file: "project_stale.md",
      reason: "initial",
    };
    let index = applyMemoryProposal(appendProposal, "", TEST_SLUG);
    expect(existsSync(getMemoryFilePath(TEST_SLUG, "project_stale.md"))).toBe(true);

    // deprecate 只按 target_file 定位，content 为空也必须生效
    const deprecateProposal: MemoryProposal = {
      action: "deprecate",
      type: "project",
      name: "stale context",
      description: "stale project context",
      content: "",
      target_file: "project_stale.md",
      reason: "superseded",
    };
    index = applyMemoryProposal(deprecateProposal, index, TEST_SLUG);
    expect(index).not.toContain("project_stale.md");
    expect(existsSync(getMemoryFilePath(TEST_SLUG, "project_stale.md"))).toBe(false);
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

    const trashDir = `${TEST_HOME}/.opencode/projects/${TEST_SLUG}/.mem/.trash`;
    const trashedFiles = readdirSync(trashDir);
    expect(trashedFiles.some((f) => f.startsWith("project_old.md."))).toBe(true);
  });
});

// ---- 写卡三件套 + created/updated（tmp → 旧卡进 .trash → rename 到位）----

const TODAY = new Date().toISOString().slice(0, 10);

function memoryProposal(
  filename: string,
  action: "append" | "update" | "deprecate",
  content: string,
): MemoryProposal {
  return {
    action,
    type: "project",
    name: filename.replace(/\.md$/, ""),
    description: `desc of ${filename}`,
    content,
    why: "test reason",
    how_to_apply: "test guidance",
    target_file: filename,
    reason: "test",
  };
}

function trashDirPath(): string {
  return `${getMemoryDir(TEST_SLUG)}/.trash`;
}

function trashEntriesFor(filename: string): string[] {
  const dir = trashDirPath();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.startsWith(`${filename}.`));
}

function trashFileCount(): number {
  const dir = trashDirPath();
  return existsSync(dir) ? readdirSync(dir).length : 0;
}

function tmpLeftovers(): string[] {
  return readdirSync(getMemoryDir(TEST_SLUG)).filter((f) => f.includes(".tmp."));
}

describe("writeMemoryFile 写卡三件套", () => {
  it("update 把更新前原卡按字节原样移入 .trash", () => {
    const file = "project_atomic.md";
    const path = getMemoryFilePath(TEST_SLUG, file);
    writeMemoryFile(TEST_SLUG, memoryProposal(file, "append", "version one"));
    const before = readFileSync(path);

    writeMemoryFile(TEST_SLUG, memoryProposal(file, "update", "version two"));

    expect(readFileSync(path, "utf-8")).toContain("version two");
    const trashed = trashEntriesFor(file);
    expect(trashed).toHaveLength(1);
    expect(readFileSync(`${trashDirPath()}/${trashed[0]!}`).equals(before)).toBe(true);
  });

  it("update 保留 created、把 updated 刷成今天", () => {
    const file = "project_aged.md";
    const path = getMemoryFilePath(TEST_SLUG, file);
    writeFileSync(
      path,
      "---\nname: aged\ndescription: aged card\ntype: project\ncreated: 2020-01-01\nupdated: 2020-01-01\n---\n\nold body\n",
      "utf-8",
    );

    writeMemoryFile(TEST_SLUG, memoryProposal(file, "update", "new body"));

    const content = readFileSync(path, "utf-8");
    expect(content).toMatch(/^created: 2020-01-01$/m);
    expect(content).toMatch(new RegExp(`^updated: ${TODAY}$`, "m"));
    expect(content).toContain("new body");
  });

  it("append 新卡同时写 created 与 updated（同日），且不产生 .trash", () => {
    const file = "project_brand_new.md";
    const path = getMemoryFilePath(TEST_SLUG, file);
    const before = trashFileCount();

    writeMemoryFile(TEST_SLUG, memoryProposal(file, "append", "fresh body"));

    const content = readFileSync(path, "utf-8");
    expect(content).toMatch(new RegExp(`^created: ${TODAY}$`, "m"));
    expect(content).toMatch(new RegExp(`^updated: ${TODAY}$`, "m"));
    expect(trashFileCount()).toBe(before);
  });

  it("老卡无 created：update 后仍无 created（不伪造），只有 updated", () => {
    const file = "project_legacy.md";
    const path = getMemoryFilePath(TEST_SLUG, file);
    writeFileSync(
      path,
      "---\nname: legacy\ndescription: legacy card\ntype: project\n---\n\nlegacy body\n",
      "utf-8",
    );

    writeMemoryFile(TEST_SLUG, memoryProposal(file, "update", "legacy body v2"));

    const content = readFileSync(path, "utf-8");
    expect(content).not.toMatch(/^created:/m);
    expect(content).toMatch(new RegExp(`^updated: ${TODAY}$`, "m"));
    expect(content).toContain("legacy body v2");
  });

  it("正常写卡不残留 .tmp. 文件", () => {
    writeMemoryFile(TEST_SLUG, memoryProposal("project_no_tmp.md", "append", "no tmp"));
    writeMemoryFile(TEST_SLUG, memoryProposal("project_no_tmp.md", "update", "no tmp v2"));
    expect(tmpLeftovers()).toEqual([]);
  });
});

describe("deprecate 不再用提案内容覆盖原卡", () => {
  it("deprecate 后 .trash 内容等于原卡字节（而非提案内容）", () => {
    const file = "project_deprecate.md";
    const path = getMemoryFilePath(TEST_SLUG, file);
    writeMemoryFile(TEST_SLUG, memoryProposal(file, "append", "ORIGINAL BODY"));
    const before = readFileSync(path);
    let index = `## ${TEST_SLUG}\n- [x](~/.opencode/projects/${TEST_SLUG}/.mem/${file}) - desc\n`;

    index = applyMemoryProposal(memoryProposal(file, "deprecate", "PROPOSAL BODY"), index, TEST_SLUG);

    expect(index).not.toContain(file);
    expect(existsSync(path)).toBe(false);
    const trashed = trashEntriesFor(file);
    expect(trashed).toHaveLength(1);
    const trashedContent = readFileSync(`${trashDirPath()}/${trashed[0]!}`);
    expect(trashedContent.equals(before)).toBe(true);
    expect(trashedContent.toString("utf-8")).toContain("ORIGINAL BODY");
    expect(trashedContent.toString("utf-8")).not.toContain("PROPOSAL BODY");
  });

  it("deprecate 目标不存在时保留 warning 且不动索引之外的东西", () => {
    const index = `## ${TEST_SLUG}\n- [ghost](~/.opencode/projects/${TEST_SLUG}/.mem/project_ghost_dep.md) - ghost\n`;
    const result = applyMemoryProposals(
      [memoryProposal("project_ghost_dep.md", "deprecate", "")],
      index,
      TEST_SLUG,
    );
    expect(result.content).not.toContain("project_ghost_dep.md");
    expect(result.warnings).toContain("deprecate 目标文件不存在: project_ghost_dep.md");
  });
});

describe("tmp 写入失败时老卡不受损", () => {
  it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
    "写 tmp 抛错后最终文件保持原内容，且无 tmp 残留",
    () => {
      const slug = "root-project-perm-test";
      const file = "project_perm.md";
      const path = getMemoryFilePath(slug, file);
      writeMemoryFile(slug, memoryProposal(file, "append", "keep me intact"));
      const before = readFileSync(path);
      const dir = getMemoryDir(slug);

      chmodSync(dir, 0o500);
      try {
        expect(() => writeMemoryFile(slug, memoryProposal(file, "update", "must not land"))).toThrow();
      } finally {
        chmodSync(dir, 0o700);
      }

      expect(readFileSync(path).equals(before)).toBe(true);
      expect(readdirSync(dir).filter((f) => f.includes(".tmp."))).toEqual([]);
    },
  );
});
