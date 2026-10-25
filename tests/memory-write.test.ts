// 出口①（issue #82 §B）memory_write 的 core 单测：显式写入 → 文件 + 索引 + 回执事实。
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync, existsSync } from "fs";
import {
  writeProjectMemory,
  deriveMemoryFilename,
  slugifyMemoryName,
} from "../src/core/memory-write.ts";
import { readMemoryIndex, readMemoryFile, getMemoryFilePath } from "../src/core/store/memory-md.ts";
import { deriveSlug } from "../src/core/memory-types.ts";

const TEST_HOME = vi.hoisted(() => `/tmp/opencode-memx-memwrite-home-${process.pid}`);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => TEST_HOME };
});

const SLUG = "workspace-demo";

beforeAll(() => {
  mkdirSync(`${TEST_HOME}/.opencode/projects/${SLUG}/.mem`, { recursive: true });
});

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("memory_write · 文件命名", () => {
  it("ASCII 名字按类型前缀 + snake_case 落名", () => {
    expect(deriveMemoryFilename("project", "Auth Rewrite")).toBe("project_auth_rewrite.md");
    expect(deriveMemoryFilename("feedback", "no-mock-db")).toBe("feedback_no_mock_db.md");
  });

  it("纯中文名退化成确定性哈希（同名必须同文件，否则更新语义失效）", () => {
    const a = slugifyMemoryName("部署流程");
    const b = slugifyMemoryName("部署流程");
    expect(a).toBe(b);
    expect(a).toMatch(/^h[0-9a-f]{8}$/);
    expect(slugifyMemoryName("另一条")).not.toBe(a);
  });
});

describe("memory_write · 落盘与索引", () => {
  it("首次写入 = append：文件 + MEMORY.md 索引条目同时出现", async () => {
    const result = await writeProjectMemory(SLUG, {
      text: "BFF 的 CORS 只放行 9928 三个 origin，换端口要先改 BFF。",
      type: "reference",
      name: "bff-cors-9928",
      description: "改端口/跨域问题时读这条",
      evidence: "用户说把这个记一下",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("append");
    expect(result.filename).toBe("reference_bff_cors_9928.md");

    const file = readMemoryFile(SLUG, result.filename);
    expect(file).toContain("name: bff-cors-9928");
    expect(file).toContain("type: reference");
    expect(file).toContain("BFF 的 CORS 只放行 9928");
    expect(file).toContain("**Why:**"); // 缺省 why 必须落进 frontmatter 之后

    const index = readMemoryIndex();
    expect(index).toContain("## " + SLUG);
    expect(index).toContain("reference_bff_cors_9928.md");
    expect(index).toContain("改端口/跨域问题时读这条");
  });

  it("同名同类型再写 = update：内容被替换，索引不重复登记", async () => {
    const first = await writeProjectMemory(SLUG, {
      text: "旧内容：端口是 9928。",
      type: "project",
      name: "port-map",
      how_to_apply: "改端口前先看",
    });
    expect(first.ok).toBe(true);

    const second = await writeProjectMemory(SLUG, {
      text: "新内容：端口是 9929（2026-10-12 变更）。",
      type: "project",
      name: "port-map",
      how_to_apply: "改端口前先看",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.action).toBe("update");

    const file = readMemoryFile(SLUG, second.filename);
    expect(file).toContain("9929");
    expect(file).not.toContain("旧内容");
    expect(file).toContain("**How to apply:** 改端口前先看");

    const index = readMemoryIndex();
    const hits = index.split("project_port_map.md").length - 1;
    expect(hits).toBe(1); // 索引里只有一条指针
  });

  it("中文名两次写入落在同一个文件（哈希命名 + update）", async () => {
    const one = await writeProjectMemory(SLUG, { text: "第一版部署流程", name: "部署流程", type: "project" });
    const two = await writeProjectMemory(SLUG, { text: "第二版部署流程", name: "部署流程", type: "project" });
    expect(one.ok && two.ok).toBe(true);
    if (!one.ok || !two.ok) return;
    expect(one.filename).toBe(two.filename);
    expect(two.action).toBe("update");
    expect(readMemoryFile(SLUG, two.filename)).toContain("第二版");
  });

  it("type 缺省是 project", async () => {
    const result = await writeProjectMemory(SLUG, { text: "缺省类型的记忆" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.type).toBe("project");
    expect(result.filename.startsWith("project_")).toBe(true);
  });

  it("feedback/project 缺 how_to_apply → 回执带告警（不静默）", async () => {
    const result = await writeProjectMemory(SLUG, { text: "协作规则：提交信息用中文", type: "feedback" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.join(" ")).toMatch(/how_to_apply 缺失/);
  });
});

describe("memory_write · 校验与锁", () => {
  it("空 text / 超长 text → 明确失败（不半写）", async () => {
    const empty = await writeProjectMemory(SLUG, { text: "   " });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toMatch(/不能为空/);

    const tooLong = await writeProjectMemory(SLUG, { text: "x".repeat(501), name: "too-long" });
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.error).toMatch(/超长/);
    expect(existsSync(getMemoryFilePath(SLUG, "project_too_long.md"))).toBe(false);
  });

  it("写完不残留锁文件（锁只包 read-modify-write）", async () => {
    await writeProjectMemory(SLUG, { text: "锁必须释放", name: "lock-check" });
    const lockPath = `${TEST_HOME}/.opencode/.MEMORY.md.lock`;
    expect(existsSync(lockPath)).toBe(false);
  });

  it("并发两次写入串行化：两条都在索引里（不互相覆盖）", async () => {
    const [a, b] = await Promise.all([
      writeProjectMemory(SLUG, { text: "并发条目 A", name: "concurrent-a", type: "reference" }),
      writeProjectMemory(SLUG, { text: "并发条目 B", name: "concurrent-b", type: "reference" }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    const index = readMemoryIndex();
    expect(index).toContain("reference_concurrent_a.md");
    expect(index).toContain("reference_concurrent_b.md");
  });
});

describe("memory_write · cwd=/ → root（#36 / #37）", () => {
  it("根目录写入落 projects/root/.mem，索引登记到 ## root；同 name 再写不增条目", async () => {
    const slug = deriveSlug("/");
    expect(slug).toBe("root");

    const first = await writeProjectMemory(slug, {
      text: "伴侣页 cwd 是 /，记一下必须能落地",
      type: "project",
      name: "root-cwd-write",
      why: "根目录会话没有项目归属",
      how_to_apply: "cwd=/ 的记忆去 projects/root/.mem 找",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.action).toBe("append");
    // 不再落进 projects/.mem（空 slug 目录）
    expect(first.filePath).toBe(`${TEST_HOME}/.opencode/projects/root/.mem/project_root_cwd_write.md`);
    expect(existsSync(first.filePath)).toBe(true);
    expect(existsSync(`${TEST_HOME}/.opencode/projects/.mem`)).toBe(false);

    const index = readMemoryIndex();
    expect(index).toContain("## root");
    expect(index).not.toContain("projects//.mem");

    // 修订语义：同 name 再写一次 → update 原地替换，索引里仍只有 1 条（#37 验收）
    const second = await writeProjectMemory(slug, {
      text: "伴侣页 cwd 是 /，记一下必须能落地（修订）",
      type: "project",
      name: "root-cwd-write",
      why: "根目录会话没有项目归属",
      how_to_apply: "cwd=/ 的记忆去 projects/root/.mem 找",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.action).toBe("update");
    expect(readMemoryIndex().match(/project_root_cwd_write\.md/g)).toHaveLength(1);
    // 旧实现在这里会吐「update 索引无此条目 → 登记为新条目」（空 slug 节永远找不到）
    expect(second.warnings).toEqual([]);
  });
});
