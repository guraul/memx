// memx sync 手工操作 —— 首推 / 首拉 / 合并后对齐 / 现场排查用。
//
// 用法：pnpm sync:op status                       只读：config + 待同步清单 + PII + 近况
//       pnpm sync:op -- pull  [--machine=prod]     拉取（远端优先；本地差异自动备份 .bak.<ts>）
//       pnpm sync:op -- push  [--machine=prod]     推送（PII 命中即拒推）
//       pnpm sync:op -- both  [--machine=prod]     先拉后推
//
// `--machine=<name>` = **显式覆盖** `{enabled:true, machineName:<name>}`，用于"配置尚未开启、
// 但要人工执行一次首推/首拉"的场合（例如 prod 首次合并）。它**不改配置文件**，所以运行中的
// 宿主不受影响；不传该参数时完全走 `~/.opencode/memx.config.json`（未启用则直接拒绝）。
//
// ⚠️ 这是与插件同一条代码路径（core/sync 的 createSync.push/pull），不是另一套实现。
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadMemxConfig } from "../src/core/config.ts";
import { createFileAlertStore } from "../src/core/alerts.ts";
import { buildDryRunReport, createSync } from "../src/core/sync.ts";

type Op = "status" | "pull" | "push" | "both";

const argv = process.argv.slice(2).filter((a) => a !== "--");
const op = argv[0] as Op | undefined;
const machine = argv.find((a) => a.startsWith("--machine="))?.slice("--machine=".length) ?? "";

if (!op || !["status", "pull", "push", "both"].includes(op)) {
  console.log("用法：pnpm sync:op <status|pull|push|both> [--machine=<name>]");
  process.exit(0);
}

try {
  const fromFile = (await loadMemxConfig()).sync;
  const config = machine ? { ...fromFile, enabled: true, machineName: machine } : fromFile;
  console.log(
    `config: enabled=${config.enabled} machine=${config.machineName || "(未设置)"} repo=${config.repo} branch=${config.branch}` +
      (machine ? "（--machine 覆盖，配置文件未改）" : ""),
  );

  // status 不做任何 git 动作（连 fetch 都不做）
  const report = buildDryRunReport({ config, prepare: op !== "status" });
  if (op !== "status") console.log(`prepare: ${report.note}`);
  console.log(`待同步 ${report.files.length} 个文件 / PII 命中 ${report.piiHits.length}`);
  for (const h of report.piiHits) console.log(`  PII ${h.file}:${h.line} ${h.pattern}`);
  if (report.piiHits.length > 0 && (op === "push" || op === "both")) {
    console.log("PII 命中 → 拒绝推送");
    process.exit(0);
  }

  const sync = createSync({ config, alerts: createFileAlertStore() });
  if (op === "push" || op === "both") {
    const r = await sync.push();
    console.log(`push → ok=${r.ok} kind=${r.kind} ${r.message}`);
  }
  if (op === "pull" || op === "both") {
    const r = await sync.pull();
    console.log(`pull → ok=${r.ok} kind=${r.kind} ${r.message}`);
  }
  for (const name of ["USER.md", "MEMORY.md"]) {
    const path = join(homedir(), ".opencode", name);
    if (existsSync(path)) {
      const sha = createHash("sha256").update(readFileSync(path, "utf8")).digest("hex").slice(0, 16);
      console.log(`${name}: sha256=${sha}`);
    }
  }
  console.log(`status → ${JSON.stringify(sync.status())}`);
  sync.dispose();
} catch (err) {
  console.log(`sync:op 失败: ${err instanceof Error ? err.message : String(err)}`);
}
