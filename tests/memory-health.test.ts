import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import {
  findDuplicateEntries,
  findLegacyEmptySlugDir,
  runHealthCheck,
  autoFix,
  formatHealthLog,
  rebuildIndex,
  runHealthMaintenance,
} from "../src/core/health/memory-health.ts";
import { applyMemoryProposal } from "../src/core/store/memory-md.ts";
import type { MemoryProposal } from "../src/core/memory-types.ts";

const TEST_HOME = vi.hoisted(() => `/tmp/opencode-memx-test-home-health-${process.pid}`);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => TEST_HOME };
});

const TEST_SLUG = "root-project-test";

beforeAll(() => {
  mkdirSync(`${TEST_HOME}/.opencode/projects/${TEST_SLUG}/.mem`, { recursive: true });
});

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
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

  it("keeps non-entry content in the index (health logs, prose)", () => {
    const index = `# MEMORY

手写说明

## ${TEST_SLUG}
- [ghost](~/.opencode/projects/${TEST_SLUG}/.mem/project_ghost_log.md) - ghost

<!-- 2026-10-12 auto-fix: previous run -->`;
    const report = runHealthCheck(index, TEST_SLUG);
    const { newIndex } = autoFix(report, index, TEST_SLUG);
    expect(newIndex).toContain("# MEMORY");
    expect(newIndex).toContain("手写说明");
    expect(newIndex).toContain("auto-fix: previous run");
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

describe("P0-5 runHealthMaintenance：健康日志绝不写回 MEMORY.md", () => {
  // 独立 slug + 独立 .mem 目录：健康检查是全目录扫描，共用 TEST_SLUG 会跟别的用例互相污染
  const MAINT_SLUG = "root-project-maint";

  beforeAll(() => {
    mkdirSync(`${TEST_HOME}/.opencode/projects/${MAINT_SLUG}/.mem`, { recursive: true });
  });

  it("死链被修掉，但返回的 index 里没有 auto-fix HTML 注释", () => {
    const index = `## ${MAINT_SLUG}\n- [ghost](~/.opencode/projects/${MAINT_SLUG}/.mem/project_ghost_maint.md) - ghost memory\n`;
    const { index: fixed, logs } = runHealthMaintenance(index, MAINT_SLUG);
    expect(logs.map((l) => l.action)).toContain("removed-dead-pointer");
    expect(fixed).not.toContain("auto-fix");
    expect(fixed).not.toContain("<!--");
    expect(fixed).not.toContain("project_ghost_maint.md");
  });

  it("孤儿文件补指针，索引里同样不落日志", () => {
    const orphan = makeProposal("project_orphan_maint.md", "orphan", "orphan context");
    applyMemoryProposal(orphan, "", MAINT_SLUG);
    const index = `## ${MAINT_SLUG}\n`;
    const { index: fixed, logs } = runHealthMaintenance(index, MAINT_SLUG);
    expect(logs.map((l) => l.action)).toContain("added-pointer");
    expect(fixed).toContain("project_orphan_maint.md");
    expect(fixed).not.toContain("<!--");
  });

  it("仅有 escalated（索引膨胀）时不动文件，只回传日志", () => {
    // 独立 slug：上一个用例写下的孤儿文件不能让这里的 orphanFiles 非空
    const MAINT2_SLUG = "root-project-maint2";
    mkdirSync(`${TEST_HOME}/.opencode/projects/${MAINT2_SLUG}/.mem`, { recursive: true });
    const keep = makeProposal("project_keep_maint.md", "keep", "keep context");
    applyMemoryProposal(keep, "", MAINT2_SLUG);
    // 200 条指向同一个真实文件：无死链、无孤儿，只有"行数超阈值"这一条 escalated
    const raw = `- [keep](~/.opencode/projects/${MAINT2_SLUG}/.mem/project_keep_maint.md) - keep context`;
    const index = `## ${MAINT2_SLUG}\n${Array.from({ length: 200 }, () => raw).join("\n")}\n`;
    const { index: fixed, logs, report } = runHealthMaintenance(index, MAINT2_SLUG);
    expect(report.deadLinks).toHaveLength(0);
    expect(report.orphanFiles).toHaveLength(0);
    expect(report.escalated.length).toBeGreaterThan(0);
    expect(logs.map((l) => l.action)).toContain("escalated-manual");
    expect(fixed).toBe(index); // 原样返回，不触发重写/备份
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

describe("存量兼容 · 空 slug 遗留（#36 / #37）", () => {
  it("projects/.mem 遗留卡片：指针归到 ## root、health 不报死链/孤儿，重复只提示不清洗", () => {
    mkdirSync(`${TEST_HOME}/.opencode/projects/.mem`, { recursive: true });
    writeFileSync(
      `${TEST_HOME}/.opencode/projects/.mem/project_legacy.md`,
      "---\nname: legacy\ndescription: legacy desc\ntype: project\n---\n\nbody\n",
    );

    // 生产现场形状：空节头 + 挂在它下面的孤儿指针（路径里是 projects//.mem）
    const index = [
      `## ${TEST_SLUG}`,
      `- [other](~/.opencode/projects/${TEST_SLUG}/.mem/project_other.md) - other`,
      "",
      "## ",
      "- [legacy](~/.opencode/projects//.mem/project_legacy.md) - legacy desc",
      "",
    ].join("\n");

    // 空节头认领成 root 后按 root 查：旧指针仍解析得到（POSIX 上 projects//.mem 就是 projects/.mem）
    const report = runHealthCheck(index, "root");
    expect(report.deadLinks).toHaveLength(0);
    expect(report.orphanFiles).toHaveLength(0);
    expect(report.indexLineCount).toBe(2);

    // doctor 侧只报事实，不动盘
    expect(findLegacyEmptySlugDir()).toEqual({
      dir: `${TEST_HOME}/.opencode/projects/.mem`,
      files: 1,
    });

    // 同一文件被登记在两节（空节指针曾被挂进上一个无关项目节）→ 只给建议，不清理
    const duplicated = [
      `## ${TEST_SLUG}`,
      "- [legacy](~/.opencode/projects//.mem/project_legacy.md) - legacy desc",
      "",
      "## ",
      "- [legacy](~/.opencode/projects//.mem/project_legacy.md) - legacy desc",
      "",
    ].join("\n");
    expect(findDuplicateEntries(duplicated)).toEqual([
      { filePath: "~/.opencode/projects//.mem/project_legacy.md", count: 2 },
    ]);
    expect(findDuplicateEntries(index)).toHaveLength(0);
  });
});
