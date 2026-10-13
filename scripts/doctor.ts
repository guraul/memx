// memx doctor — 只读状态面板：alerts / memory files / opencode diag。
// 用法：node --experimental-strip-types scripts/doctor.ts  （或 pnpm doctor）
// 不联网、不写盘、退出码恒 0。
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { createFileAlertStore, formatAlertsPanel } from "../src/core/alerts.ts";
import { loadMemxConfig } from "../src/core/config.ts";
import { listToSync, readSyncState } from "../src/core/sync.ts";

// ---- alerts ----
try {
  const alertStore = createFileAlertStore();
  console.log(formatAlertsPanel(alertStore));
} catch {
  console.log("alerts: 未取到");
}

// ---- memory files ----
try {
  const opencodeDir = join(homedir(), ".opencode");

  const userMdPath = join(opencodeDir, "USER.md");
  const userMdLines = existsSync(userMdPath) ? readFileSync(userMdPath, "utf8").split("\n") : [];
  const userMdEntryCount = userMdLines.filter((l) => /^- \[\d{4}-\d{2}-\d{2}\]/.test(l)).length;

  const memoryMdPath = join(opencodeDir, "MEMORY.md");
  const memoryMdLines = existsSync(memoryMdPath) ? readFileSync(memoryMdPath, "utf8").split("\n") : [];
  const memoryMdEntryCount = memoryMdLines.filter((l) => /^- \[.*?\]\(.*?\)/.test(l)).length;

  console.log(`USER.md: ${userMdLines.length} lines, ${userMdEntryCount} entries`);
  console.log(`MEMORY.md: ${memoryMdLines.length} lines, ${memoryMdEntryCount} entries`);

  const projectsDir = join(opencodeDir, "projects");
  if (existsSync(projectsDir)) {
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const memDir = join(projectsDir, entry.name, ".mem");
      if (!existsSync(memDir)) continue;
      const files = readdirSync(memDir, { withFileTypes: true }).filter(
        (f) => f.isFile() && f.name.endsWith(".md"),
      ).length;
      console.log(`projects/${entry.name}: ${files} files`);
    }
  }
} catch {
  console.log("memory files: 未取到");
}

// ---- opencode diag ----
try {
  const dbPath = join(homedir(), ".local", "share", "opencode", "opencode.db");
  const result = spawnSync(
    "sqlite3",
    [dbPath, "SELECT key, substr(value, 1, 300) FROM kv WHERE key LIKE 'plugin:%diag:%'"],
    { encoding: "utf8", timeout: 5000 },
  );
  if (result.status === 0 && result.stdout) {
    console.log("opencode diag:");
    console.log(result.stdout.split("\n").slice(0, 5).join("\n"));
  } else {
    console.log("opencode diag: 未取到");
  }
} catch {
  console.log("opencode diag: 未取到");
}

// ---- sync（阶段 4 第二半）----
// 只读：config 字段 / 状态文件（若启用）/ 待推文件数 / 最近 PII 扫描。不 clone、不 fetch。
void (async () => {
  try {
    const config = await loadMemxConfig();
    const s = config.sync;
    console.log(
      `sync: enabled=${s.enabled} repo=${s.repo} branch=${s.branch} machineName=${s.machineName || "(未设置)"} intervalMinutes=${s.intervalMinutes}`,
    );
    console.log(`sync.pendingFiles: ${listToSync().length}`);
    if (s.enabled && s.machineName) {
      const state = readSyncState();
      if (state) {
        console.log(
          `sync.status: lastPushAt=${state.lastPushAt ?? "从未"} lastPullAt=${state.lastPullAt ?? "从未"} consecutiveFailures=${state.consecutiveFailures} lastError=${state.lastError || "无"}`,
        );
      } else {
        console.log("sync.status: 未取到（尚未发生过 push/pull）");
      }
      const pii = state?.lastPiiScan;
      console.log(
        pii
          ? `sync.pii: ${pii.hits} 处命中 / ${pii.files} 个文件 @ ${pii.at}`
          : "sync.pii: 未取到（尚未扫描）",
      );
    }
  } catch {
    console.log("sync: 未取到");
  }
})();
