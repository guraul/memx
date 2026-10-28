// memx sync 手工操作 —— 首推 / 首拉 / 合并后对齐 / 现场排查用。
//
// 用法：pnpm sync:op status                       只读：config + 待同步清单 + PII + 近况
//       pnpm sync:op pii                          只读：PII 自查（file:line + 规则名，绝不回显内容）
//       pnpm sync:op -- pull  [--machine=prod]     拉取（远端优先；本地差异自动备份 .bak.<ts>）
//       pnpm sync:op -- push  [--machine=prod]     推送（PII block 层命中即拒推；alert 层照推留痕）
//       pnpm sync:op -- both  [--machine=prod]     先拉后推
//
// `--machine=<name>` = **显式覆盖** `{enabled:true, machineName:<name>}`，用于"配置尚未开启、
// 但要人工执行一次首推/首拉"的场合（例如 prod 首次合并）。它**不改配置文件**，所以运行中的
// 宿主不受影响；不传该参数时完全走 `~/.opencode/memx.config.json`（未启用则直接拒绝）。
//
// `pii` 子命令（issue #10 DoD ③）解决的正是"闸门只说行号+规则名、用户无从自查"：
// 它只读地跑同一份 `scanSensitive`，把**命中明细 file / rule / line**列出来，
// 遵守既有约定——**绝不回显任何命中内容**（不打印那一行文字、不打印 key 片段）。
//
// ⚠️ 这是与插件同一条代码路径（core/sync 的 createSync.push/pull + scanSensitive），不是另一套实现。
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadMemxConfig } from "../src/core/config.ts";
import { createFileAlertStore } from "../src/core/alerts.ts";
import { buildDryRunReport, createSync, readSyncState } from "../src/core/sync.ts";

type Op = "status" | "pii" | "pull" | "push" | "both";

const OPS: readonly Op[] = ["status", "pii", "pull", "push", "both"];

const argv = process.argv.slice(2).filter((a) => a !== "--");
const op = argv[0] as Op | undefined;
const machine = argv.find((a) => a.startsWith("--machine="))?.slice("--machine=".length) ?? "";

if (!op || !OPS.includes(op)) {
  console.log("用法：pnpm sync:op <status|pii|pull|push|both> [--machine=<name>]");
  process.exit(0);
}

/** 只读子命令：status / pii 都不发任何 git 命令（连 fetch 都不发）。 */
const readOnly = op === "status" || op === "pii";

try {
  const fromFile = (await loadMemxConfig()).sync;
  const config = machine ? { ...fromFile, enabled: true, machineName: machine } : fromFile;

  // pii 自查：配置等无关信息一律不打，只输出"扫描了多少 + 命中明细"，便于直接贴进排查记录
  if (op === "pii") {
    const report = buildDryRunReport({ config });
    // issue #33：分层展示。block 拒推；alert 只告警、照推但留痕。
    const blockHits = report.piiHits.filter((h) => h.tier === "block");
    const alertHits = report.piiHits.filter((h) => h.tier === "alert");
    console.log(`PII 自查（只读；扫描本地镜像 ${report.files.length} 个文件，命中只报 file / rule / line，绝不回显内容）`);
    console.log(`block 层（高精度，命中即拒推）: ${blockHits.length} 处`);
    for (const h of blockHits) console.log(`  ${h.file}:${h.line}  ${h.pattern}`);
    console.log(`alert 层（低置信，只告警、照推留痕）: ${alertHits.length} 处`);
    for (const h of alertHits) console.log(`  ${h.file}:${h.line}  ${h.pattern}`);
    // alert 命中的持久留痕（状态文件 append-only，不剪龄）：文件被改掉后仍能查到"什么时候推过什么"
    const log = readSyncState()?.piiAlertLog ?? [];
    if (log.length > 0) {
      console.log(`历史留痕（状态文件，不剪龄）: ${log.length} 条`);
      for (const e of log.slice(-20)) console.log(`  ${e.at}  ${e.file}:${e.line}  ${e.pattern}`);
      if (log.length > 20) console.log("  …（仅显示最近 20 条；完整见 ~/.opencode/memx-sync-state.json）");
    }
    if (blockHits.length === 0 && alertHits.length === 0) {
      console.log("命中 0 处 → PII 闸门不会拦推送");
    } else {
      console.log(
        "处置：block 层先确认是真密钥还是词形误报（真密钥清理记忆内容，误报调 PII_BLOCK_RULES）；" +
          "alert 层照推不阻断，复核内容后决定是否清理。",
      );
    }
    process.exit(0);
  }

  console.log(
    `config: enabled=${config.enabled} machine=${config.machineName || "(未设置)"} repo=${config.repo} branch=${config.branch}` +
      (machine ? "（--machine 覆盖，配置文件未改）" : ""),
  );

  // status 不做任何 git 动作（连 fetch 都不做）
  const report = buildDryRunReport({ config, prepare: !readOnly });
  if (!readOnly) console.log(`prepare: ${report.note}`);
  console.log(`待同步 ${report.files.length} 个文件 / PII 命中 block=${report.piiHits.filter((h) => h.tier === "block").length} alert=${report.piiHits.filter((h) => h.tier === "alert").length}`);
  for (const h of report.piiHits) console.log(`  PII [${h.tier}] ${h.file}:${h.line} ${h.pattern}`);
  // 只有 block 层才拦截；alert 层照推（issue #33）
  if (report.piiHits.some((h) => h.tier === "block") && (op === "push" || op === "both")) {
    console.log("PII block 层命中 → 拒绝推送");
    process.exit(0);
  }

  const sync = createSync({ config, alerts: createFileAlertStore() });
  if (op === "push" || op === "both") {
    const r = await sync.push();
    // 未推提交数（issue #12）随每次 push 落进状态文件；这里直接打出来，断网积压一眼可见
    const st = sync.status();
    console.log(`push → ok=${r.ok} kind=${r.kind} ${r.message}`);
    console.log(`未推提交: ${st.unsyncedCommits}`);
  }
  if (op === "pull" || op === "both") {
    // 人工通道默认强制真实 pull：手动跑就是要把远端搬下来，不参与"远端无变化则跳过"
    const r = await sync.pull({ force: true });
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
