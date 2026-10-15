import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { loadMemxConfig, getConfigPath } from "../src/core/config.ts";
import { writeFileSync, mkdirSync, existsSync, rmSync } from "fs";
import { join } from "path";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => "/tmp/opencode-memx-test-home-config" };
});

beforeAll(() => {
  mkdirSync("/tmp/opencode-memx-test-home/.opencode", { recursive: true });
});

afterAll(() => {
  rmSync("/tmp/opencode-memx-test-home-config", { recursive: true, force: true });
});

const configPath = getConfigPath();

describe("loadMemxConfig throttleMinutes", () => {
  it("defaults throttleMinutes to 10", async () => {
    if (existsSync(configPath)) rmSync(configPath);
    const config = await loadMemxConfig();
    expect(config.throttleMinutes).toBe(10);
  });

  it("reads throttleMinutes from config file", async () => {
    mkdirSync(join("/tmp/opencode-memx-test-home-config", ".opencode"), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ throttleMinutes: 5 }), "utf-8");
    const config = await loadMemxConfig();
    expect(config.throttleMinutes).toBe(5);
  });
});

describe("loadMemxConfig inject（注入闸门）", () => {
  const write = (cfg: unknown) => writeFileSync(configPath, JSON.stringify(cfg), "utf-8");

  it("缺省 → 全开：enabled=true / includeAgents='all' / excludeAgents=[]", async () => {
    rmSync(configPath, { force: true });
    const config = await loadMemxConfig();
    expect(config.inject).toEqual({ enabled: true, includeAgents: "all", excludeAgents: [] });
  });

  it("空 inject 对象 → 同样落到全开默认值（部分字段缺失不炸）", async () => {
    write({ inject: {} });
    const config = await loadMemxConfig();
    expect(config.inject).toEqual({ enabled: true, includeAgents: "all", excludeAgents: [] });
  });

  it("读 enabled=false", async () => {
    write({ inject: { enabled: false } });
    expect((await loadMemxConfig()).inject.enabled).toBe(false);
  });

  it('读 includeAgents="all"', async () => {
    write({ inject: { includeAgents: "all" } });
    expect((await loadMemxConfig()).inject.includeAgents).toBe("all");
  });

  it("读 includeAgents=[...] 列表", async () => {
    write({ inject: { includeAgents: ["a", "b"] } });
    expect((await loadMemxConfig()).inject.includeAgents).toEqual(["a", "b"]);
  });

  it("读 excludeAgents=[...]，与 include 并存", async () => {
    write({ inject: { includeAgents: ["a"], excludeAgents: ["x"] } });
    const inject = (await loadMemxConfig()).inject;
    expect(inject.includeAgents).toEqual(["a"]);
    expect(inject.excludeAgents).toEqual(["x"]);
  });

  it("坏配置（includeAgents 既不是 'all' 也不是数组）→ 回落全默认，不抛", async () => {
    write({ inject: { includeAgents: 42 } });
    const config = await loadMemxConfig();
    expect(config.inject).toEqual({ enabled: true, includeAgents: "all", excludeAgents: [] });
  });

  it("inject 坏掉不会连累别的字段（throttleMinutes 仍读得到）", async () => {
    write({ throttleMinutes: 7, inject: { enabled: "yes-please" } });
    const config = await loadMemxConfig();
    // schema 整体失败 → 全默认（loadMemxConfig 的既有行为）
    expect(config.inject.enabled).toBe(true);
    expect(config.inject.includeAgents).toBe("all");
  });

  it("includeAgents / excludeAgents 可以是空数组（不注入任何 agent）", async () => {
    write({ inject: { includeAgents: [], excludeAgents: [] } });
    const inject = (await loadMemxConfig()).inject;
    expect(inject.includeAgents).toEqual([]);
    expect(inject.excludeAgents).toEqual([]);
  });
});
