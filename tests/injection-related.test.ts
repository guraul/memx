// #32：注入 = 当前节 + related。本文件钉死**纯函数**的四条硬性质：
//
//   1. related 命中：其它节里讲本项目的条目要能进来（只取当前节会丢 58% 的跨节记忆）
//   2. 停用词：`workspace` / `projects` / `Users` / `gubin` / `root-project` 这类路径容器
//      绝不能当键——拿它们匹配等于把整份索引又注回来
//   3. 同名去重：同一张卡被登记在两个节是存量事实，不能注两遍
//   4. 确定性：同一份索引 + 同一个 cwd，两次渲染**字节完全相同**（DSH 会话内字节恒定的前提）
//
// 另加两条退化安全：匹配不到就只注入当前节（宁可少注入，不可误注入）；合并后整体仍受
// `capSourceText` 的 200 行 / 25KB 约束。
import { describe, it, expect } from "vitest";
import {
  RELATED_INJECT_LIMIT,
  buildMemoryInjection,
  injectionKeyForDirectory,
  matchesInjectionKey,
} from "../src/core/pipeline/injection-source.ts";
import { buildInjectionParts } from "../src/core/injection.ts";

/** 索引构造器：`[slug, [[文件名, hook], …]]` → MEMORY.md 文本（与真实索引同格式）。 */
function indexOf(sections: Array<[string, Array<[string, string]>]>): string {
  return sections
    .map(([slug, entries]) => {
      const lines = [`## ${slug}`];
      for (const [file, hook] of entries) {
        lines.push(`- [${file}](${`~/.opencode/projects/${slug}/.mem/${file}`}) - ${hook}`);
      }
      return `${lines.join("\n")}\n`;
    })
    .join("\n");
}

const MEMX_DIR = "/Users/gubin/workspace/memx";

describe("injectionKeyForDirectory — 项目目录末段", () => {
  it("取末段，不是压平的 slug", () => {
    expect(injectionKeyForDirectory("/Users/gubin/workspace/memx")).toBe("memx");
    expect(injectionKeyForDirectory("/root/project/agent-mobile")).toBe("agent-mobile");
  });

  it("末尾斜杠 / 空白都归一", () => {
    expect(injectionKeyForDirectory("/Users/gubin/workspace/memx/")).toBe("memx");
    expect(injectionKeyForDirectory("  /Users/gubin/workspace/memx  ")).toBe("memx");
  });

  it("停用词一律 null（大小写不敏感）", () => {
    for (const dir of [
      "/Users/gubin/workspace",
      "/Users/gubin/Workspace",
      "/home/me/projects",
      "/home/me/project",
      "/Users",
      "/Users/gubin",
      "/root",
      "/root-project",
      "/tmp",
    ]) {
      expect(injectionKeyForDirectory(dir), dir).toBeNull();
    }
  });

  it("无目录 / 根目录 / 单字符 → null（短键误报面太大，宁可少注入）", () => {
    expect(injectionKeyForDirectory("")).toBeNull();
    expect(injectionKeyForDirectory("   ")).toBeNull();
    expect(injectionKeyForDirectory(null)).toBeNull();
    expect(injectionKeyForDirectory(undefined)).toBeNull();
    expect(injectionKeyForDirectory("/")).toBeNull();
    expect(injectionKeyForDirectory("/a")).toBeNull();
  });

  it("键统一小写（渲染出的 related 头稳定）", () => {
    expect(injectionKeyForDirectory("/w/MemX")).toBe("memx");
  });
});

describe("matchesInjectionKey — 词边界", () => {
  it("中英夹缝都算边界（中文不是 word 字符）", () => {
    expect(matchesInjectionKey("用memx做提炼", "memx")).toBe(true);
    expect(matchesInjectionKey("memx仓库的 PR 一律 squash", "memx")).toBe(true);
  });

  it("大小写不敏感", () => {
    expect(matchesInjectionKey("MemX 注入通道", "memx")).toBe(true);
  });

  it("连字符是边界（已知误报方向：多注入一条，不是少注入）", () => {
    expect(matchesInjectionKey("memx-worktrees 目录", "memx")).toBe(true);
  });

  it("下划线 / 字母黏连**不**是边界（`memx_pr` / `memxy` 不算命中）", () => {
    expect(matchesInjectionKey("memx_pr_squash_only", "memx")).toBe(false);
    expect(matchesInjectionKey("memxy 是别的项目", "memx")).toBe(false);
    expect(matchesInjectionKey("ammemx", "memx")).toBe(false);
  });

  it("键里的正则元字符按字面量处理", () => {
    expect(matchesInjectionKey("看 a.b 这行", "a.b")).toBe(true);
    expect(matchesInjectionKey("看 axb 这行", "a.b")).toBe(false);
  });

  it("空文本 / 空键 → false", () => {
    expect(matchesInjectionKey("", "memx")).toBe(false);
    expect(matchesInjectionKey("memx", "")).toBe(false);
  });
});

describe("buildMemoryInjection — related 命中", () => {
  const INDEX = indexOf([
    ["Users-gubin-workspace-memx", [["project_inject.md", "memx 注入通道：context hook"]]],
    [
      "Users-gubin-workspace-agent-mobile",
      [
        ["feedback_squash.md", "memx（guraul/memx）仓库 PR 一律 squash 合并"],
        ["project_memx_version.md", "prod memx 版本 fe26fa1 已部署"],
        ["feedback_tts.md", "ttskill 登录态到期语义"],
      ],
    ],
    ["Users-gubin-workspace-homebase", [["project_bff.md", "BFF 在 homebase packages/web"]]],
  ]);

  it("当前节 = 本节条目；related = 其它节里词边界命中的条目（保持索引顺序）", () => {
    const result = buildMemoryInjection({ indexContent: INDEX, slug: "Users-gubin-workspace-memx", directory: MEMX_DIR });
    expect(result.key).toBe("memx");
    expect(result.current).toBe(1);
    expect(result.related).toBe(2);
    expect(result.text).toContain("## Users-gubin-workspace-memx");
    expect(result.text).toContain("## related: memx");
    expect(result.text).toContain("memx（guraul/memx）仓库 PR 一律 squash 合并");
    expect(result.text).toContain("prod memx 版本 fe26fa1 已部署");
    // 不相关的条目一条都不进
    expect(result.text).not.toContain("ttskill 登录态到期语义");
    expect(result.text).not.toContain("BFF 在 homebase packages/web");
  });

  it("related 排在当前节之后（不改写条目原文，只多一个 `## related:` 头）", () => {
    const result = buildMemoryInjection({ indexContent: INDEX, slug: "Users-gubin-workspace-memx", directory: MEMX_DIR });
    const text = result.text ?? "";
    expect(text.indexOf("## Users-gubin-workspace-memx")).toBeLessThan(text.indexOf("## related: memx"));
    expect(text.indexOf("memx（guraul/memx）仓库 PR")).toBeLessThan(text.indexOf("prod memx 版本"));
  });

  it("当前节不存在但有 related → 只出 related（跨节记忆仍可见）", () => {
    const result = buildMemoryInjection({
      indexContent: INDEX,
      slug: "Users-gubin-workspace-memx-worktrees-32-inject-related",
      directory: MEMX_DIR,
    });
    expect(result.current).toBe(0);
    // 讲 memx 的三条都在别的节：memx 节自己一条 + agent-mobile 两条
    expect(result.related).toBe(3);
    expect(result.text?.startsWith("## related: memx")).toBe(true);
  });

  it("匹配不到 → 只注入当前节，绝不凭空造 related 节", () => {
    const result = buildMemoryInjection({ indexContent: INDEX, slug: "Users-gubin-workspace-homebase", directory: "/w/homebase" });
    expect(result.related).toBe(0);
    expect(result.text).not.toContain("## related");
    expect(result.text).toContain("BFF 在 homebase packages/web");
  });

  it("当前节与 related 都空 → null（调用方一个 part 都不加）", () => {
    const result = buildMemoryInjection({ indexContent: INDEX, slug: "no-such-slug", directory: "/w/unknown-proj" });
    expect(result).toEqual({ text: null, current: 0, related: 0, key: "unknown-proj" });
  });

  it("索引为空 / null → null", () => {
    for (const indexContent of ["", "   ", null, undefined]) {
      expect(buildMemoryInjection({ indexContent, slug: "x", directory: MEMX_DIR }).text).toBeNull();
    }
  });

  it("非受管行（health 注释 / 手写说明）不注入", () => {
    const withExtras = `<!-- memx: ⚠️ 2 critical — run doctor -->\n\n${INDEX.replace(
      "ttskill 登录态到期语义",
      "ttskill 登录态到期语义\n<!-- health: 2026-10-20 清理死链 1 条 -->",
    )}`;
    const result = buildMemoryInjection({ indexContent: withExtras, slug: "Users-gubin-workspace-memx", directory: MEMX_DIR });
    expect(result.text).not.toContain("health:");
    expect(result.text).not.toContain("run doctor");
  });
});

describe("buildMemoryInjection — 停用词（宁可少注入，不可误注入）", () => {
  const INDEX = indexOf([
    ["Users-gubin-workspace-memx", [["a.md", "本项目"]]],
    ["Users-gubin-workspace-agent-mobile", [["b.md", "workspace 里所有项目都该看这条"]]],
  ]);

  it("停在容器目录上 → 不找 related（否则等于把整份索引注回来）", () => {
    const result = buildMemoryInjection({ indexContent: INDEX, slug: "Users-gubin-workspace-memx", directory: "/Users/gubin/workspace" });
    expect(result.key).toBeNull();
    expect(result.related).toBe(0);
    expect(result.text).not.toContain("workspace 里所有项目都该看这条");
  });

  it("`/` 与取不到的目录同样不找 related", () => {
    for (const directory of ["/", "", undefined]) {
      const result = buildMemoryInjection({ indexContent: INDEX, slug: "Users-gubin-workspace-memx", directory });
      expect(result.related).toBe(0);
      expect(result.text).toContain("本项目");
    }
  });
});

describe("buildMemoryInjection — 同名去重", () => {
  it("当前节已有的卡片不再从 related 重复注入（按文件名）", () => {
    const INDEX = indexOf([
      ["Users-gubin-workspace-memx", [["memx_channel.md", "memx 注入通道"]]],
      // 同一张卡在别的节里被重复登记的存量事实
      ["Users-gubin-workspace-agent-mobile", [["memx_channel.md", "memx 注入通道（重复登记）"]]],
    ]);
    const result = buildMemoryInjection({ indexContent: INDEX, slug: "Users-gubin-workspace-memx", directory: MEMX_DIR });
    expect(result.current).toBe(1);
    expect(result.related).toBe(0);
    expect(result.text).not.toContain("重复登记");
  });

  it("两张不同节的同名卡只收第一张（索引顺序在前的那条）", () => {
    const INDEX = indexOf([
      ["Users-gubin-workspace-memx", [["own.md", "本项目"]]],
      ["Users-gubin-workspace-agent-mobile", [["dup.md", "memx 第一条"]]],
      ["Users-gubin-workspace-homebase", [["dup.md", "memx 第二条"]]],
    ]);
    const result = buildMemoryInjection({ indexContent: INDEX, slug: "Users-gubin-workspace-memx", directory: MEMX_DIR });
    expect(result.related).toBe(1);
    expect(result.text).toContain("memx 第一条");
    expect(result.text).not.toContain("memx 第二条");
  });
});

describe("buildMemoryInjection — 选择上限与确定性", () => {
  const many = (n: number): Array<[string, string]> =>
    Array.from({ length: n }, (_, i) => [`card_${i}.md`, `memx 第 ${i} 条`]);

  it(`索引顺序前 ${RELATED_INJECT_LIMIT} 条（不多收，也不按字母/时间重排）`, () => {
    const INDEX = indexOf([["Users-gubin-workspace-memx", [["own.md", "本项目"]]], ["other", many(15)]]);
    const result = buildMemoryInjection({ indexContent: INDEX, slug: "Users-gubin-workspace-memx", directory: MEMX_DIR });
    expect(result.related).toBe(RELATED_INJECT_LIMIT);
    expect(result.text).toContain("memx 第 0 条");
    expect(result.text).toContain("memx 第 9 条");
    expect(result.text).not.toContain("memx 第 10 条");
  });

  it("同输入两次渲染字节完全相同（无时间戳/计数/随机）", () => {
    const INDEX = indexOf([["Users-gubin-workspace-memx", [["own.md", "本项目"]]], ["other", many(12)]]);
    const once = buildMemoryInjection({ indexContent: INDEX, slug: "Users-gubin-workspace-memx", directory: MEMX_DIR });
    const twice = buildMemoryInjection({ indexContent: INDEX, slug: "Users-gubin-workspace-memx", directory: MEMX_DIR });
    expect(twice.text).toBe(once.text);
    expect(Buffer.from(twice.text ?? "", "utf-8").equals(Buffer.from(once.text ?? "", "utf-8"))).toBe(true);
  });

  it("合并后整体仍受 capSourceText 约束（200 行 / 25KB 不被绕开）", () => {
    const huge = Array.from({ length: 400 }, (_, i) => `- [c${i}](~/.opencode/projects/s/.mem/c${i}.md) - memx 第 ${i} 条`).join("\n");
    const text = buildMemoryInjection({ indexContent: `## s\n${huge}\n`, slug: "s", directory: MEMX_DIR }).text ?? "";
    const built = buildInjectionParts({ memory: text });
    expect(built.truncations).toBe(1);
    expect(built.parts[0]!.text).toContain("[memx: truncated");
    expect(built.parts[0]!.text.split("\n").length).toBeLessThanOrEqual(201);
  });
});

describe("buildMemoryInjection — 卡片正文兜底（hook 不中才读正文）", () => {
  const INDEX = indexOf([
    ["Users-gubin-workspace-memx", [["own.md", "本项目"]]],
    ["Users-gubin-workspace-agent-mobile", [["body_hit.md", "只在正文里提到"], ["none.md", "完全无关的钩子"]]],
  ]);
  const BODIES: Record<string, string> = {
    "~/.opencode/projects/Users-gubin-workspace-agent-mobile/.mem/body_hit.md": "# 卡\n\n这条讲 memx 的注入链路。\n",
    "~/.opencode/projects/Users-gubin-workspace-agent-mobile/.mem/none.md": "# 卡\n\n讲的是别的项目。\n",
  };

  it("hook 不含键、正文含 → 命中", () => {
    const result = buildMemoryInjection({
      indexContent: INDEX,
      slug: "Users-gubin-workspace-memx",
      directory: MEMX_DIR,
      readCard: (path) => BODIES[path] ?? null,
    });
    expect(result.related).toBe(1);
    expect(result.text).toContain("只在正文里提到");
    expect(result.text).not.toContain("完全无关的钩子");
  });

  it("读不到卡片正文（文件缺失）→ 不命中，绝不猜", () => {
    const result = buildMemoryInjection({
      indexContent: INDEX,
      slug: "Users-gubin-workspace-memx",
      directory: MEMX_DIR,
      readCard: () => null,
    });
    expect(result.related).toBe(0);
  });

  it("hook 已命中就不读卡片（每 step 的 IO 只花在兜底路径上）", () => {
    let reads = 0;
    const index = indexOf([
      ["Users-gubin-workspace-memx", [["own.md", "本项目"]]],
      ["other", [["hit.md", "memx 钩子直接命中"]]],
    ]);
    const result = buildMemoryInjection({
      indexContent: index,
      slug: "Users-gubin-workspace-memx",
      directory: MEMX_DIR,
      readCard: () => {
        reads++;
        return null;
      },
    });
    expect(result.related).toBe(1);
    expect(reads).toBe(0);
  });
});
