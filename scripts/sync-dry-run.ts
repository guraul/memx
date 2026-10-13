// memx sync dry-run — 只读预览：永不 clone/fetch/push，绝不写盘。
// 用法：pnpm sync:dry-run（退出码恒 0）
// 输出：config 字段 / 待推文件清单与增删行数 / PII 扫描结果（文件+行号+规则名，不回显内容）/ 远端状态。
import { loadMemxConfig } from "../src/core/config.ts";
import { buildDryRunReport } from "../src/core/sync.ts";

try {
  const config = await loadMemxConfig();
  const report = buildDryRunReport({ config: config.sync });
  const s = report.config;
  console.log("== memx sync dry-run（只读：不 clone/fetch/push）==");
  console.log(
    `config: enabled=${s.enabled} repo=${s.repo} branch=${s.branch} machineName=${s.machineName || "(未设置)"} intervalMinutes=${s.intervalMinutes}`,
  );
  console.log(`workdir: ${report.workdir} — ${report.workdirExists ? "存在" : "不存在"}`);
  console.log(`待推文件: ${report.files.length} 个`);
  for (const f of report.files) {
    const diff = f.added === null ? "(远端未取到)" : f.removed === 0 ? `+${f.added} 行` : `+${f.added}/-${f.removed} 行`;
    console.log(`  ${f.repoPath} ${diff}`);
  }
  if (report.piiHits.length === 0) {
    console.log(`PII 扫描: 清洁（${report.files.length} 个文件）`);
  } else {
    console.log(`PII 扫描: ${report.piiHits.length} 处命中`);
    for (const h of report.piiHits) {
      console.log(`  ${h.file}:${h.line} ${h.pattern}`);
    }
  }
  if (report.remoteLog.length === 0) {
    console.log("远端状态: 未取到");
  } else {
    console.log("远端状态:");
    for (const line of report.remoteLog) {
      console.log(`  ${line}`);
    }
  }
} catch (err) {
  console.log(`sync dry-run 失败: ${err instanceof Error ? err.message : String(err)}`);
}
