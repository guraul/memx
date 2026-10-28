// memx sync dry-run — 只读预览：不 push、不碰 ~/.opencode 里的记忆文件。
// 用法：pnpm sync:dry-run              仅比对已有缓存 workdir（零 git 写操作）
//       pnpm sync:dry-run -- --fetch   先 clone/fetch 到 workdir 再比对（首合并预演用；仍不 push）
// 退出码恒 0。输出：config / 待同步文件清单与双向行数 / PII 扫描（文件+行号+规则名，不回显内容）/ 远端状态。
import { loadMemxConfig } from "../src/core/config.ts";
import { buildDryRunReport } from "../src/core/sync.ts";

const argv = process.argv.slice(2);
const prepare = argv.includes("--fetch") || argv.includes("--prepare");
const unknown = argv.filter((a) => a !== "--" && a !== "--fetch" && a !== "--prepare");

try {
  const config = await loadMemxConfig();
  const report = buildDryRunReport({ config: config.sync, prepare });
  const s = report.config;
  console.log(`== memx sync dry-run（只读：不 push；${prepare ? "已对齐远端" : "不 clone/fetch"}）==`);
  console.log(
    `config: enabled=${s.enabled} repo=${s.repo} branch=${s.branch} machineName=${s.machineName || "(未设置)"} intervalMinutes=${s.intervalMinutes}`,
  );
  console.log(`workdir: ${report.workdir} — ${report.workdirExists ? "存在" : "不存在"}`);
  if (report.note) console.log(`prepare: ${report.note}`);
  if (unknown.length > 0) console.log(`⚠️ 未识别参数（忽略）：${unknown.join(" ")}`);
  console.log(`待同步文件: ${report.files.length} 个`);
  for (const f of report.files) {
    const diff =
      f.added === null
        ? "远端未取到（缓存 workdir 不存在；加 --fetch 可取远端基准）"
        : f.removed === 0
          ? `本地 +${f.added} 行 / 远端无此文件（首推）`
          : `本地 +${f.added} 行 / 远端 +${f.removed} 行`;
    console.log(`  ${f.repoPath} — ${diff}`);
  }
  if (report.piiHits.length === 0) {
    console.log(`PII 扫描: 清洁（${report.files.length} 个文件）`);
  } else {
    const blockHits = report.piiHits.filter((h) => h.tier === "block");
    const alertHits = report.piiHits.filter((h) => h.tier === "alert");
    // issue #33：block 拒推；alert 只告警、照推并落持久留痕
    console.log(
      `PII 扫描: block ${blockHits.length} 处（命中即拒推）/ alert ${alertHits.length} 处（只告警，照推留痕）`,
    );
    for (const h of report.piiHits) {
      console.log(`  [${h.tier}] ${h.file}:${h.line} ${h.pattern}`);
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
