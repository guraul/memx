// memx doctor — 只读状态面板：alerts / memory files / opencode diag / sync。
// 用法：node --experimental-strip-types scripts/doctor.ts   或   pnpm run doctor
// ⚠️ 不要用 `pnpm doctor`（pnpm 有同名内建命令，会跑成 pnpm 自检）。
// 不联网、不写盘、退出码恒 0。
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { createFileAlertStore, formatAlertsPanel } from "../src/core/alerts.ts";
import { loadMemxConfig } from "../src/core/config.ts";
import { findDuplicateEntries, findLegacyEmptySlugDir } from "../src/core/health/memory-health.ts";
import { listPendingDeletions, listToSync, readSyncState } from "../src/core/sync.ts";

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

  // 存量提示（#36 / #37）：只说事实与建议，不动文件——搬迁与去重都需要人确认。
  const legacy = findLegacyEmptySlugDir();
  if (legacy) {
    console.log(
      `memx 提示: ${legacy.dir} 仍有 ${legacy.files} 张卡片（空 slug 遗留；新写入已归到 projects/root/，本面板只提示、不搬迁）`,
    );
  }
  const duplicates = findDuplicateEntries(memoryMdLines.join("\n"));
  if (duplicates.length > 0) {
    console.log(
      `memx 提示: MEMORY.md 有 ${duplicates.length} 个文件被重复登记（历史重复，#37 产物；只提示不清洗，确认后手工删多余行）`,
    );
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
        // issue #12：未推提交数要可见——否则"断网期攒的提交推不出去"会一直伪装成"同步正常"
        console.log(`sync.unsyncedCommits: ${state.unsyncedCommits ?? 0}`);
        // issue #21：待传播的删除要可见——"远端还有、本地已删"就是删除没收敛的直接证据
        const pendingDeleted = state.lastRemoteSha ? listPendingDeletions({ rev: state.lastRemoteSha }) : [];
        const preview = pendingDeleted.slice(0, 5).join(", ");
        console.log(
          `sync.pendingDeletions: ${pendingDeleted.length}` +
            (preview === "" ? "" : `（${preview}${pendingDeleted.length > 5 ? " …" : ""}）`),
        );
      } else {
        console.log("sync.status: 未取到（尚未发生过 push/pull）");
      }
      const pii = state?.lastPiiScan;
      console.log(
        pii
          ? `sync.pii: ${pii.hits} 处命中 / ${pii.files} 个文件 @ ${pii.at}；明细自查：pnpm sync:op pii`
          : "sync.pii: 未取到（尚未扫描）；自查：pnpm sync:op pii",
      );
    }
  } catch {
    console.log("sync: 未取到");
  }
})();
