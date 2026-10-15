// memx 报警账本手工清理 —— 瞬时故障恢复后销账 / 定期卫生用。
// 用法：pnpm alerts:clear [--code=SYNC_ERROR] [--dry-run]
//   无参数 = 清空全部；--code = 只删该 code 的条目；--dry-run 只打印不写盘。
// 退出码恒 0（清理是幂等手工操作，不存在失败语义）。
import { createFileAlertStore } from "../src/core/alerts.ts";

const argv = process.argv.slice(2);
const code = argv.find((a) => a.startsWith("--code="))?.slice("--code=".length);
const dryRun = argv.includes("--dry-run");

const store = createFileAlertStore();

const printCounts = (label: string): void => {
  const c = store.counts();
  console.log(`${label}: info=${c.info} warn=${c.warn} critical=${c.critical}`);
};

printCounts("清理前");

if (dryRun) {
  const pending = store.list().filter((e) => !code || e.code === code).length;
  console.log(`dry-run：将${code ? `删除 code=${code} 共 ${pending} 条` : `清空全部 ${pending} 条`}（未写盘）`);
} else if (code) {
  const removed = store.resolve(code);
  console.log(`已删除 code=${code} 共 ${removed} 条`);
} else {
  store.clear();
  console.log("已清空全部");
}

printCounts("清理后");
