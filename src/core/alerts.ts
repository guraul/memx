// memx 报警模块（阶段 4 第一半）。
// 单一事实源：~/.opencode/memx-alerts.json（JSON 数组，封顶 max 条，超出丢最旧）。
// 零宿主依赖：只用 node:fs / node:os / node:path。
// 容错：坏 JSON 从空开始、目录不存在自动创建、任何 IO 失败都吞掉不抛（插件不能崩）。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type AlertLevel = "info" | "warn" | "critical";

export interface AlertEvent {
  level: AlertLevel;
  code: string;
  message: string;
  ts: string;
  context?: Record<string, unknown>;
}

export interface AlertStore {
  append(event: AlertEvent): void;
  list(): AlertEvent[];
  counts(): Record<AlertLevel, number>;
  clear(): void;
}

const DEFAULT_MAX = 200;

function defaultPath(): string {
  return join(homedir(), ".opencode", "memx-alerts.json");
}

export function createFileAlertStore(opts?: { path?: string; max?: number }): AlertStore {
  const filePath = opts?.path ?? defaultPath();
  const max = opts?.max ?? DEFAULT_MAX;
  let events: AlertEvent[] = [];

  const load = (): void => {
    try {
      if (!existsSync(filePath)) return;
      const raw = readFileSync(filePath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        events = parsed.filter(
          (e): e is AlertEvent =>
            typeof e === "object" &&
            e !== null &&
            typeof (e as AlertEvent).level === "string" &&
            typeof (e as AlertEvent).code === "string" &&
            typeof (e as AlertEvent).message === "string" &&
            typeof (e as AlertEvent).ts === "string",
        );
      }
    } catch {
      events = [];
    }
  };

  const persist = (): void => {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify(events, null, 2), "utf-8");
    } catch {
      // 插件不能崩：任何 IO 失败都吞掉
    }
  };

  load();

  return {
    append(event: AlertEvent): void {
      events.push(event);
      if (events.length > max) events = events.slice(-max);
      persist();
    },
    list(): AlertEvent[] {
      return [...events];
    },
    counts(): Record<AlertLevel, number> {
      const counts: Record<AlertLevel, number> = { info: 0, warn: 0, critical: 0 };
      for (const e of events) counts[e.level]++;
      return counts;
    },
    clear(): void {
      events = [];
      persist();
    },
  };
}

/** MEMORY.md 顶部一行面包屑（只有有 warn/critical 时才返回非空串）。
 *  宿主靠 `<!-- memx:` 前缀识别/替换旧行。 */
export function formatBreadcrumb(store: AlertStore): string {
  const counts = store.counts();
  if (counts.warn === 0 && counts.critical === 0) return "";
  const parts: string[] = [];
  if (counts.warn > 0) parts.push(`${counts.warn} warn`);
  if (counts.critical > 0) parts.push(`${counts.critical} critical`);
  return "<!-- memx: ⚠️ " + parts.join(" / ") + " — run `memx doctor` -->";
}

/** memx doctor 的面板文本（alerts 段落；纯函数，好测）。 */
export function formatAlertsPanel(store: AlertStore): string {
  const counts = store.counts();
  const lines = [`alerts: info=${counts.info} warn=${counts.warn} critical=${counts.critical}`];
  const recent = store.list().slice(-10);
  for (const e of recent) {
    lines.push(`${e.ts} ${e.code} ${e.message}`);
  }
  return lines.join("\n");
}
