// 注入来源的文件读取层单测（core/pipeline/injection-source.ts）：路径解析 + mtime/size 缓存失效。
//
// 缓存存在的理由是 hook 每 step 触发一次（一轮回复十几次）。这里不测"缓存命中率"这种
// 性能指标，而是测**失效正确性**：改了文件必须看得见，删了文件必须读不到，
// 没变时必须复用（否则缓存就是个 bug 而不是优化）。
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdirSync, rmSync, writeFileSync, utimesSync, statSync } from "fs";
import { join } from "path";
import {
  InjectionSourceCache,
  getProtocolPath,
  readInjectionSources,
} from "../src/core/pipeline/injection-source.ts";

const HOME = "/tmp/opencode-memx-test-home-inject";

// 测试隔离：把 homedir 指向临时目录，绝不触碰真实 ~/.opencode
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => HOME };
});

const DIR = join(HOME, ".opencode");

beforeAll(() => {
  mkdirSync(DIR, { recursive: true });
});

beforeEach(() => {
  rmSync(join(DIR, "memx-protocol.md"), { force: true });
  rmSync(join(DIR, "USER.md"), { force: true });
  rmSync(join(DIR, "MEMORY.md"), { force: true });
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

describe("路径解析", () => {
  it("三块内容都落在 ~/.opencode/ 下（与 install.sh 的写入位置一致）", () => {
    expect(getProtocolPath()).toBe(join(DIR, "memx-protocol.md"));
  });
});

describe("InjectionSourceCache — 缺失静默", () => {
  it("文件不存在 → null，不抛", () => {
    const cache = new InjectionSourceCache();
    expect(cache.read(join(DIR, "does-not-exist.md"))).toBeNull();
  });

  it("目录路径（不是文件）→ 当作缺失，不抛", () => {
    const cache = new InjectionSourceCache();
    expect(cache.read(DIR)).toBeNull();
  });

  it("缺失态也被缓存（第二次不再重复走读路径），文件一出现就放行", () => {
    const path = join(DIR, "later.md");
    const cache = new InjectionSourceCache();
    expect(cache.read(path)).toBeNull();
    writeFileSync(path, "now here", "utf-8");
    expect(cache.read(path)).toBe("now here");
  });
});

describe("InjectionSourceCache — mtime/size 双校验", () => {
  const path = () => join(DIR, "cached.md");
  /** 把文件的 mtime 精确设为给定的 epoch 毫秒，便于单独隔离出某一维来验证。 */
  const pinMtime = (p: string, mtimeMs: number) => {
    const at = new Date(mtimeMs);
    utimesSync(p, at, at);
  };

  it("mtime 与 size 都没变 → 命中缓存（拿到旧值，不重读盘）", () => {
    const p = path();
    writeFileSync(p, "first", "utf-8");
    const mtime = statSync(p).mtimeMs;
    pinMtime(p, mtime);

    const cache = new InjectionSourceCache();
    expect(cache.read(p)).toBe("first");

    // 同长度改内容 + 把 mtime 钉回缓存记录的那个值 = 双校验都认为"没变"
    writeFileSync(p, "SECON", "utf-8");
    pinMtime(p, mtime);

    expect(cache.read(p)).toBe("first");
    expect(cache.wasCached(p)).toBe(true);
  });

  it("size 变了（mtime 被钉回原值）→ 重新读取", () => {
    const p = path();
    writeFileSync(p, "a", "utf-8");
    const mtime = statSync(p).mtimeMs;
    pinMtime(p, mtime);

    const cache = new InjectionSourceCache();
    expect(cache.read(p)).toBe("a");

    // 只改 size，mtime 钉死
    writeFileSync(p, "much longer content", "utf-8");
    pinMtime(p, mtime);

    expect(cache.read(p)).toBe("much longer content");
  });

  it("mtime 变了（size 不变）→ 重新读取", () => {
    const p = path();
    writeFileSync(p, "v1", "utf-8");
    const mtime = statSync(p).mtimeMs;
    pinMtime(p, mtime);

    const cache = new InjectionSourceCache();
    expect(cache.read(p)).toBe("v1");

    // 同长度改内容，mtime 明确前进
    writeFileSync(p, "v2!", "utf-8");
    pinMtime(p, mtime + 5000);

    expect(cache.read(p)).toBe("v2!");
  });

  it("内容变了但 mtime 前进 → 重新读取（memx 真实写盘路径）", () => {
    const p = path();
    writeFileSync(p, "v1", "utf-8");
    const cache = new InjectionSourceCache();
    expect(cache.read(p)).toBe("v1");
    // 真实写盘场景（memx 的 writeFileSync+renameSync）：mtime 必然前进
    writeFileSync(p, "v2-changed", "utf-8");
    expect(cache.read(p)).toBe("v2-changed");
  });

  it("删除文件后 → 读不到（缓存不会把已删的内容继续供出去）", () => {
    const p = path();
    writeFileSync(p, "here", "utf-8");
    const cache = new InjectionSourceCache();
    expect(cache.read(p)).toBe("here");
    rmSync(p, { force: true });
    expect(cache.read(p)).toBeNull();
  });

  it("clear() 后重新读盘", () => {
    const p = path();
    writeFileSync(p, "one", "utf-8");
    const cache = new InjectionSourceCache();
    expect(cache.read(p)).toBe("one");
    cache.clear();
    writeFileSync(p, "two-two", "utf-8");
    expect(cache.read(p)).toBe("two-two");
  });
});

describe("readInjectionSources — 三块一起读", () => {
  it("全在 → 三个字段都有值，键名与 buildInjectionParts 的来源一致", () => {
    writeFileSync(join(DIR, "memx-protocol.md"), "protocol body", "utf-8");
    writeFileSync(join(DIR, "USER.md"), "user body", "utf-8");
    writeFileSync(join(DIR, "MEMORY.md"), "memory body", "utf-8");
    const sources = readInjectionSources(new InjectionSourceCache());
    expect(sources).toEqual({ protocol: "protocol body", user: "user body", memory: "memory body" });
  });

  it("MEMORY.md 不存在（Track 2 还没跑过）→ memory 为 null，其余照常", () => {
    writeFileSync(join(DIR, "memx-protocol.md"), "protocol body", "utf-8");
    writeFileSync(join(DIR, "USER.md"), "user body", "utf-8");
    const sources = readInjectionSources(new InjectionSourceCache());
    expect(sources.protocol).toBe("protocol body");
    expect(sources.user).toBe("user body");
    expect(sources.memory).toBeNull();
  });

  it("全缺 → 三块都是 null（上层据此一个 part 都不加）", () => {
    const sources = readInjectionSources(new InjectionSourceCache());
    expect(sources).toEqual({ protocol: null, user: null, memory: null });
  });

  it("readInjectionSources 的产物能直接喂给 buildInjectionParts（管道闭合）", async () => {
    writeFileSync(join(DIR, "memx-protocol.md"), "protocol body", "utf-8");
    const { buildInjectionParts } = await import("../src/core/injection.ts");
    const built = buildInjectionParts(readInjectionSources(new InjectionSourceCache()));
    expect(built.parts).toEqual([{ type: "text", text: "protocol body" }]);
  });
});