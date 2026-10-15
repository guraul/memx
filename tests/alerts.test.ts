import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import {
  createFileAlertStore,
  formatBreadcrumb,
  formatAlertsPanel,
  type AlertStore,
} from "../src/core/alerts.ts";
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

  it("resolve 只删指定 code，返回删掉条数，且持久化", () => {
    const now = new Date().toISOString();
    store.append({ level: "warn", code: "SYNC_ERROR", message: "a", ts: now });
    store.append({ level: "warn", code: "SYNC_ERROR", message: "b", ts: now });
    store.append({ level: "critical", code: "SYNC_PII_BLOCKED", message: "c", ts: now });
    const removed = store.resolve("SYNC_ERROR");
    expect(removed).toBe(2);
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.code).toBe("SYNC_PII_BLOCKED");
    // 持久化：新实例读到的也是删后状态
    const reloaded = createFileAlertStore({ path: STORE_PATH });
    expect(reloaded.list()).toHaveLength(1);
  });

  it("resolve 不存在的 code → 返回 0，账本不变", () => {
    store.append({ level: "warn", code: "X", message: "a", ts: "2026-01-01T00:00:00Z" });
    expect(store.resolve("NOPE")).toBe(0);
    expect(store.list()).toHaveLength(1);
  });

  it("maxAgeDays 剪掉老事件、保留新事件与不可解析 ts（有变化才持久化）", () => {
    const now = Date.now();
    const s = createFileAlertStore({ path: STORE_PATH, maxAgeDays: 7 });
    s.append({ level: "warn", code: "OLD", message: "old", ts: new Date(now - 10 * 86400e3).toISOString() });
    s.append({ level: "warn", code: "NEW", message: "new", ts: new Date(now - 1 * 86400e3).toISOString() });
    s.append({ level: "warn", code: "BAD", message: "unparseable", ts: "not-a-date" });
    // 剪龄发生在 load：新实例读盘即裁剪
    const reloaded = createFileAlertStore({ path: STORE_PATH, maxAgeDays: 7 });
    const codes = reloaded.list().map((e) => e.code);
    expect(codes).not.toContain("OLD");
    expect(codes).toContain("NEW");
    expect(codes).toContain("BAD");
  });

  it("默认 maxAgeDays=7：8 天前的事件被剪，6 天前的保留", () => {
    const now = Date.now();
    const write = (code: string, daysAgo: number): void => {
      const s = createFileAlertStore({ path: STORE_PATH });
      s.append({ level: "info", code, message: code, ts: new Date(now - daysAgo * 86400e3).toISOString() });
    };
    write("D8", 8);
    write("D6", 6);
    const reloaded = createFileAlertStore({ path: STORE_PATH });
    const codes = reloaded.list().map((e) => e.code);
    expect(codes).not.toContain("D8");
    expect(codes).toContain("D6");
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

  it("有 warn/critical 时含计数与 pnpm run doctor", () => {
    store.append({ level: "warn", code: "W", message: "warn msg", ts: "2026-01-01T00:00:00Z" });
    store.append({ level: "critical", code: "C", message: "crit msg", ts: "2026-01-02T00:00:00Z" });
    const bc = formatBreadcrumb(store);
    expect(bc).toContain("1 warn");
    expect(bc).toContain("1 critical");
    expect(bc).toContain("pnpm run doctor");
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
