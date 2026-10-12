// 出口①（issue #82 §B）memory_write 的 core 单测：显式写入 → 文件 + 索引 + 回执事实。
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync, existsSync } from "fs";
import {
  writeProjectMemory,
  deriveMemoryFilename,
  slugifyMemoryName,
} from "../src/core/memory-write";
import { readMemoryIndex, readMemoryFile, getMemoryFilePath } from "../src/core/store/memory-md";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => "/tmp/opencode-memx-memwrite-home" };
});

const SLUG = "workspace-demo";

beforeAll(() => {
  mkdirSync(`/tmp/opencode-memx-memwrite-home/.opencode/projects/${SLUG}/.mem`, { recursive: true });
});

afterAll(() => {
  rmSync("/tmp/opencode-memx-memwrite-home", { recursive: true, force: true });
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
    const lockPath = "/tmp/opencode-memx-memwrite-home/.opencode/.MEMORY.md.lock";
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
