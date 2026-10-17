// 对外 CRUD 面（issue #13 / agent-mobile#62 路径 A · 切片 1）CLI 集成测试。
// 每用例独立 HOME=<tmp>：本仓规则——测试绝不碰真实 ~/.opencode。
// 真跑 `node --experimental-strip-types scripts/mem.ts`，覆盖参数解析 + 真实落盘。
import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "node:url";
import { deriveSlug } from "../src/core/memory-types.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(REPO, "scripts", "mem.ts");

const tmpHomes: string[] = [];
afterAll(() => {
  for (const h of tmpHomes) rmSync(h, { recursive: true, force: true });
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "memx-mem-cli-"));
  tmpHomes.push(home);
  return home;
}

function mem(args: string[], home: string, stdin?: string) {
  return spawnSync(process.execPath, ["--experimental-strip-types", CLI, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, HOME: home },
    cwd: REPO,
    input: stdin,
  });
}

const PROPOSAL = {
  action: "append",
  type: "reference",
  name: "bff-cors-9928",
  description: "改端口/跨域问题时读这条",
  content: "BFF 的 CORS 只放行 9928 三个 origin，换端口要先改 BFF。",
  target_file: "reference_bff_cors_9928.md",
  reason: "测试夹具",
};

const SLUG = "workspace-demo";

describe("mem slug · 与宿主 deriveSlug 一致", () => {
  it("--dir 推导结果与 core deriveSlug 相同", () => {
    const home = makeHome();
    const dir = "/Users/gubin/workspace/agent-mobile";
    const r = mem(["slug", "--dir", dir], home);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(deriveSlug(dir));
  });

  it("缺 --dir 时用 cwd 推导", () => {
    const home = makeHome();
    const r = mem(["slug"], home);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(deriveSlug(REPO));
  });
});

describe("mem write/list/search/get · happy path 与落盘", () => {
  it("write 落盘 .mem 文件、更新索引、第二次写生成 .bak", () => {
    const home = makeHome();
    const file = "reference_bff_cors_9928.md";

    const r1 = mem(["write", "--slug", SLUG], home, JSON.stringify([PROPOSAL]));
    expect(r1.status).toBe(0);
    const memDir = join(home, ".opencode", "projects", SLUG, ".mem");
    const written = join(memDir, file);
    expect(existsSync(written)).toBe(true);

    const indexPath = join(home, ".opencode", "MEMORY.md");
    expect(existsSync(indexPath)).toBe(true);
    const indexAfter1 = readFileSync(indexPath, "utf8");
    expect(indexAfter1).toContain("## " + SLUG);
    expect(indexAfter1).toContain(file);

    const update = { ...PROPOSAL, action: "update", content: "更新后的内容。" };
    const r2 = mem(["write", "--slug", SLUG], home, JSON.stringify([update]));
    expect(r2.status).toBe(0);
    expect(readFileSync(written, "utf8")).toContain("更新后的内容。");
    expect(readFileSync(indexPath, "utf8")).toContain(file);

    const baks = readdirSync(join(home, ".opencode")).filter((f) => f.startsWith("MEMORY.md.bak."));
    expect(baks.length).toBeGreaterThan(0);
  });

  it("list 列出 slug 与条目", () => {
    const home = makeHome();
    mem(["write", "--slug", SLUG], home, JSON.stringify([PROPOSAL]));
    const r = mem(["list"], home);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("## " + SLUG);
    expect(r.stdout).toContain("bff-cors-9928");
  });

  it("search 跨文件命中并给出行号", () => {
    const home = makeHome();
    mem(["write", "--slug", SLUG], home, JSON.stringify([PROPOSAL]));
    const r = mem(["search", "CORS", "--slug", SLUG], home);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("reference_bff_cors_9928.md");
    expect(r.stdout).toMatch(/:\d+:/);
  });

  it("get 打印单条记忆全文", () => {
    const home = makeHome();
    mem(["write", "--slug", SLUG], home, JSON.stringify([PROPOSAL]));
    const r = mem(["get", SLUG, "reference_bff_cors_9928.md"], home);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("name: bff-cors-9928");
    expect(r.stdout).toContain("type: reference");
    expect(r.stdout).toContain("CORS 只放行 9928");
  });

  it("--json 输出稳定键", () => {
    const home = makeHome();
    mem(["write", "--slug", SLUG], home, JSON.stringify([PROPOSAL]));
    const r = mem(["list", "--json"], home);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.count.slugs).toBe(1);
    expect(parsed.slugs[0].entries[0].title).toBe("bff-cors-9928");
  });
});

describe("mem forget · 软删", () => {
  it("移入 .trash 并移除索引条目", () => {
    const home = makeHome();
    mem(["write", "--slug", SLUG], home, JSON.stringify([PROPOSAL]));
    const file = "reference_bff_cors_9928.md";
    const memDir = join(home, ".opencode", "projects", SLUG, ".mem");

    const r = mem(["forget", "bff-cors", "--slug", SLUG], home);
    expect(r.status).toBe(0);
    expect(existsSync(join(memDir, file))).toBe(false);
    const trashed = readdirSync(join(memDir, ".trash"));
    expect(trashed.some((f) => f.startsWith(file + "."))).toBe(true);

    const index = readFileSync(join(home, ".opencode", "MEMORY.md"), "utf8");
    expect(index).not.toContain(file);
  });
});

describe("mem --dry-run · 不改任何文件", () => {
  it("write --dry-run 不产生 .mem 文件与索引", () => {
    const home = makeHome();
    const r = mem(["write", "--slug", SLUG, "--dry-run"], home, JSON.stringify([PROPOSAL]));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("dry-run");
    expect(existsSync(join(home, ".opencode", "projects", SLUG))).toBe(false);
    expect(existsSync(join(home, ".opencode", "MEMORY.md"))).toBe(false);
  });

  it("forget --dry-run 文件与索引均不变", () => {
    const home = makeHome();
    mem(["write", "--slug", SLUG], home, JSON.stringify([PROPOSAL]));
    const file = "reference_bff_cors_9928.md";
    const before = readFileSync(join(home, ".opencode", "MEMORY.md"), "utf8");

    const r = mem(["forget", "bff-cors", "--slug", SLUG, "--dry-run"], home);
    expect(r.status).toBe(0);
    expect(existsSync(join(home, ".opencode", "projects", SLUG, ".mem", file))).toBe(true);
    expect(readFileSync(join(home, ".opencode", "MEMORY.md"), "utf8")).toBe(before);
  });
});

describe("mem 退出码 · 0/1/2", () => {
  it("0：只读 happy path", () => {
    const home = makeHome();
    expect(mem(["list"], home).status).toBe(0);
    expect(mem(["status"], home).status).toBe(0);
  });

  it("1：用法错误（缺参数 / 缺 --slug）", () => {
    const home = makeHome();
    expect(mem(["get"], home).status).toBe(1);
    expect(mem(["write"], home, JSON.stringify([PROPOSAL])).status).toBe(1);
    expect(mem(["search", "kw"], home).status).toBe(1);
    expect(mem(["forget", "kw"], home).status).toBe(1);
  });

  it("2：业务错误（slug/文件不存在、未匹配、载荷非法）", () => {
    const home = makeHome();
    expect(mem(["get", "nosuchslug", "x.md"], home).status).toBe(2);
    expect(mem(["forget", "nosuchkw", "--slug", "nosuchslug"], home).status).toBe(2);
    expect(mem(["write", "--slug", SLUG], home, "not json").status).toBe(2);
    expect(mem(["write", "--slug", SLUG], home, JSON.stringify([{ action: "bogus" }])).status).toBe(2);
  });
});
