// 出口①（issue #82 §B）memory_write 的 core 单测：显式写入 → 文件 + 索引 + 回执事实。
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync, existsSync, readdirSync } from "fs";
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

  it("同名同义再写 = update：不 fork、索引不重复登记（#31）", async () => {
    const first = await writeProjectMemory(SLUG, {
      text: "端口是 9928。",
      type: "project",
      name: "port-map",
      description: "改端口前先看",
      how_to_apply: "改端口前先看",
    });
    expect(first.ok).toBe(true);

    const second = await writeProjectMemory(SLUG, {
      text: "端口是 9928。",
      type: "project",
      name: "port-map",
      description: "改端口/跨域问题时先看",
      how_to_apply: "改端口前先看",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.action).toBe("update");
    expect(second.filename).toBe("project_port_map.md");

    // 只换了 description（索引 hook）→ 仍是同一张卡、同一条指针
    const file = readMemoryFile(SLUG, second.filename);
    expect(file).toContain("端口是 9928");
    expect(file).toContain("description: 改端口/跨域问题时先看");

    const index = readMemoryIndex();
    const hits = index.split("project_port_map.md").length - 1;
    expect(hits).toBe(1); // 索引里只有一条指针
    expect(index).toContain("改端口/跨域问题时先看");
  });

  it("同名同义（仅排版差异：空白/空行/CRLF）仍算修订", async () => {
    const first = await writeProjectMemory(SLUG, { text: "端口 9928。\n\n换端口先改 CORS。", name: "port-format" });
    const second = await writeProjectMemory(SLUG, {
      text: "端口 9928。   \r\n\r\n\r\n换端口先改 CORS。  ",
      name: "port-format",
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.filename).toBe(first.filename);
    expect(second.action).toBe("update");
  });

  it("中文名两次写入落在同一个文件（哈希命名 + update）", async () => {
    const one = await writeProjectMemory(SLUG, { text: "第一版部署流程", name: "部署流程", type: "project" });
    const two = await writeProjectMemory(SLUG, { text: "第一版部署流程", name: "部署流程", type: "project" });
    expect(one.ok && two.ok).toBe(true);
    if (!one.ok || !two.ok) return;
    expect(one.filename).toBe(two.filename);
    expect(two.action).toBe("update");
    expect(readMemoryFile(SLUG, two.filename)).toContain("第一版");
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

    // 修订语义：同 name 同内容再写一次 → update 原地替换，索引里仍只有 1 条（#37 验收）
    const second = await writeProjectMemory(slug, {
      text: "伴侣页 cwd 是 /，记一下必须能落地",
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

describe("memory_write · 同名不同义 → hash 尾缀 fork（#31）", () => {
  const memDir = `${TEST_HOME}/.opencode/projects/${SLUG}/.mem`;
  const cardsWithPrefix = (prefix: string) =>
    readdirSync(memDir).filter((f) => f.startsWith(prefix) && f.endsWith(".md")).sort();

  it("同名 + 同内容 → 仍是 1 张卡（修订，不 fork）", async () => {
    const name = "same-body-revise";
    const input = { text: "DSH 是控制面，opencode 是执行面。", type: "project", name, how_to_apply: "分工前先看" };
    const first = await writeProjectMemory(SLUG, input);
    const second = await writeProjectMemory(SLUG, input);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.action).toBe("update");
    expect(second.filename).toBe(first.filename);
    expect(second.filename).not.toContain("--");
    expect(cardsWithPrefix("project_same_body_revise")).toHaveLength(1);
  });

  it("同名 + 不同内容 → fork 出 hash 尾缀新卡，旧卡保留并记 Superseded by", async () => {
    const name = "deploy-notes-fork";
    const a = await writeProjectMemory(SLUG, {
      text: "部署走 9928 静态服务。",
      type: "project",
      name,
      how_to_apply: "部署前先看",
    });
    const b = await writeProjectMemory(SLUG, {
      text: "部署走 9929 Metro 热重载。",
      type: "project",
      name,
      how_to_apply: "部署前先看",
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    expect(a.filename).toBe("project_deploy_notes_fork.md");
    expect(b.action).toBe("append");
    expect(b.filename).toMatch(/^project_deploy_notes_fork--[0-9a-f]{6}\.md$/);
    expect(cardsWithPrefix("project_deploy_notes_fork")).toHaveLength(2);

    const fork = readMemoryFile(SLUG, b.filename);
    expect(fork).toContain(`same_name_as: ${a.filename}`);
    expect(fork).toContain("9929");

    const old = readMemoryFile(SLUG, a.filename);
    expect(old).toContain("9928"); // 旧卡不被覆盖
    expect(old).toContain(`**Superseded by:** ${b.filename}`);

    expect(b.warnings.join(" ")).toMatch(/同名不同义/);
  });

  it("同一段内容反复写 3 次 → 永远命中同一张 fork 卡（幂等）", async () => {
    const name = "idempotent-fork";
    const text = "内容 A";
    const first = await writeProjectMemory(SLUG, { text, type: "project", name, how_to_apply: "看这里" });
    const forkOnce = await writeProjectMemory(SLUG, { text: "内容 B", type: "project", name, how_to_apply: "看这里" });
    expect(first.ok && forkOnce.ok).toBe(true);
    if (!first.ok || !forkOnce.ok) return;
    expect(cardsWithPrefix("project_idempotent_fork")).toHaveLength(2);

    for (let i = 0; i < 3; i++) {
      const again = await writeProjectMemory(SLUG, { text: "内容 B", type: "project", name, how_to_apply: "看这里" });
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.filename).toBe(forkOnce.filename);
      expect(again.action).toBe("update");
    }
    expect(cardsWithPrefix("project_idempotent_fork")).toHaveLength(2);
    expect(readMemoryIndex().match(/project_idempotent_fork--[0-9a-f]{6}\.md/g)).toHaveLength(1);
  });

  it("纯中文同名不同事 → 照样 fork，文件名保持合法 ASCII（hash 兜底）", async () => {
    const name = "发布注意事项";
    const a = await writeProjectMemory(SLUG, { text: "上线前先跑 tsc。", type: "project", name, how_to_apply: "上线前看" });
    const b = await writeProjectMemory(SLUG, { text: "上线前先跑 vitest。", type: "project", name, how_to_apply: "上线前看" });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    expect(a.filename).toMatch(/^project_h[0-9a-f]{8}\.md$/);
    expect(b.filename).toMatch(/^project_h[0-9a-f]{8}--[0-9a-f]{6}\.md$/);
    expect(/^[\x20-\x7e]+$/.test(b.filename)).toBe(true);
    expect(existsSync(getMemoryFilePath(SLUG, b.filename))).toBe(true);
    expect(existsSync(getMemoryFilePath(SLUG, a.filename))).toBe(true);
  });

  it("索引里两张卡标题可区分（不出现两条完全相同的标题）", async () => {
    const name = "index-titles";
    await writeProjectMemory(SLUG, { text: "索引标题 A", type: "reference", name });
    await writeProjectMemory(SLUG, { text: "索引标题 B", type: "reference", name });

    const section = readMemoryIndex().split(`## ${SLUG}`)[1] ?? "";
    expect(section).toContain(`- [${name}](~/.opencode/projects/${SLUG}/.mem/reference_index_titles.md)`);
    expect(section).toContain(`- [${name} (2)](`);

    const titles = section
      .split("\n")
      .filter((line) => line.startsWith("- ["))
      .map((line) => line.slice(3, line.indexOf("](")));
    expect(new Set(titles).size).toBe(titles.length);

    // 重复写同一段内容不会把标题编号推高（幂等）
    await writeProjectMemory(SLUG, { text: "索引标题 B", type: "reference", name });
    expect(readMemoryIndex()).toContain(`- [${name} (2)](`);
  });
});
