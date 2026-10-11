import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { loadMemxConfig, getConfigPath } from "../src/core/config";
import { writeFileSync, mkdirSync, existsSync, rmSync } from "fs";
import { join } from "path";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => "/tmp/opencode-memx-test-home" };
});

beforeAll(() => {
  mkdirSync("/tmp/opencode-memx-test-home/.opencode", { recursive: true });
});

afterAll(() => {
  rmSync("/tmp/opencode-memx-test-home", { recursive: true, force: true });
});

const configPath = getConfigPath();

describe("loadMemxConfig throttleMinutes", () => {
  it("defaults throttleMinutes to 10", async () => {
    if (existsSync(configPath)) rmSync(configPath);
    const config = await loadMemxConfig();
    expect(config.throttleMinutes).toBe(10);
  });

  it("reads throttleMinutes from config file", async () => {
    mkdirSync(join("/tmp/opencode-memx-test-home", ".opencode"), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ throttleMinutes: 5 }), "utf-8");
    const config = await loadMemxConfig();
    expect(config.throttleMinutes).toBe(5);
  });
});
