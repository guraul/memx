import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import {
  createFileAlertStore,
  formatBreadcrumb,
  formatAlertsPanel,
  type AlertStore,
} from "../src/core/alerts";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => "/tmp/opencode-memx-alerts-test-home" };
});

beforeAll(() => {
  mkdirSync("/tmp/opencode-memx-alerts-test-home/.opencode", { recursive: true });
});

afterAll(() => {
  rmSync("/tmp/opencode-memx-alerts-test-home", { recursive: true, force: true });
});

const STORE_PATH = "/tmp/opencode-memx-alerts-test-home/.opencode/memx-alerts.json";

describe("createFileAlertStore", () => {
  let store: AlertStore;

  beforeEach(() => {
    store = createFileAlertStore({ path: STORE_PATH });
    store.clear();
  });

  it("append → list → counts 基本闭环 + 时间序", () => {
    store.append({ level: "info", code: "A", message: "first", ts: "2026-01-01T00:00:00Z" });
    store.append({ level: "warn", code: "B", message: "second", ts: "2026-01-02T00:00:00Z" });
    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list[0]!.code).toBe("A");
    expect(list[1]!.code).toBe("B");
    const counts = store.counts();
    expect(counts.info).toBe(1);
    expect(counts.warn).toBe(1);
    expect(counts.critical).toBe(0);
  });

  it("封顶丢最旧", () => {
    const smallStore = createFileAlertStore({ path: STORE_PATH, max: 3 });
    for (let i = 1; i <= 5; i++) {
      smallStore.append({ level: "info", code: `C${i}`, message: `msg${i}`, ts: `2026-01-0${i}T00:00:00Z` });
    }
    const list = smallStore.list();
    expect(list).toHaveLength(3);
    expect(list[0]!.code).toBe("C3");
    expect(list[1]!.code).toBe("C4");
    expect(list[2]!.code).toBe("C5");
  });

  it("坏 JSON 文件容错", () => {
    writeFileSync(STORE_PATH, "not valid json {{{", "utf-8");
    const s = createFileAlertStore({ path: STORE_PATH });
    expect(() => s.append({ level: "info", code: "X", message: "ok", ts: "2026-01-01T00:00:00Z" })).not.toThrow();
    expect(s.list()).toHaveLength(1);
    expect(s.list()[0]!.code).toBe("X");
  });

  it("文件路径不存在时自动建目录", () => {
    const deepPath = "/tmp/opencode-memx-alerts-test-home/.opencode/deep/nested/alerts.json";
    const s = createFileAlertStore({ path: deepPath });
    s.append({ level: "info", code: "Y", message: "deep", ts: "2026-01-01T00:00:00Z" });
    expect(existsSync(deepPath)).toBe(true);
  });

  it("clear() 清空", () => {
    store.append({ level: "info", code: "Z", message: "clear me", ts: "2026-01-01T00:00:00Z" });
    expect(store.list()).toHaveLength(1);
    store.clear();
    expect(store.list()).toHaveLength(0);
  });
});

describe("formatBreadcrumb", () => {
  let store: AlertStore;

  beforeEach(() => {
    store = createFileAlertStore({ path: STORE_PATH });
    store.clear();
  });

  it("只有 info 时返回空串", () => {
    store.append({ level: "info", code: "A", message: "info only", ts: "2026-01-01T00:00:00Z" });
    expect(formatBreadcrumb(store)).toBe("");
  });

  it("有 warn/critical 时含计数与 memx doctor", () => {
    store.append({ level: "warn", code: "W", message: "warn msg", ts: "2026-01-01T00:00:00Z" });
    store.append({ level: "critical", code: "C", message: "crit msg", ts: "2026-01-02T00:00:00Z" });
    const bc = formatBreadcrumb(store);
    expect(bc).toContain("1 warn");
    expect(bc).toContain("1 critical");
    expect(bc).toContain("memx doctor");
    expect(bc.startsWith("<!-- memx:")).toBe(true);
  });
});

describe("formatAlertsPanel", () => {
  let store: AlertStore;

  beforeEach(() => {
    store = createFileAlertStore({ path: STORE_PATH });
    store.clear();
  });

  it("含计数行与最近条目内容", () => {
    store.append({ level: "info", code: "INFO1", message: "info message", ts: "2026-01-01T00:00:00Z" });
    store.append({ level: "warn", code: "WARN1", message: "warn message", ts: "2026-01-02T00:00:00Z" });
    const panel = formatAlertsPanel(store);
    const lines = panel.split("\n");
    expect(lines[0]).toContain("info=1");
    expect(lines[0]).toContain("warn=1");
    expect(lines[0]).toContain("critical=0");
    expect(panel).toContain("INFO1");
    expect(panel).toContain("info message");
    expect(panel).toContain("WARN1");
  });
});
