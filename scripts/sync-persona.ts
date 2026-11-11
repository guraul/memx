// 把仓库真源 `personas/whale-girl.md` 复制到 `~/.opencode/PERSONA.md`（智能体人设，注入第三轨）。
//
// 语义：
// - 目标不存在 → 写入（安装/首次启用）。
// - 内容相同   → 无变化，不写、不改 mtime（幂等，宿主 stat 缓存不会被无谓刷新）。
// - 内容不同   → **默认跳过**并提示。PERSONA.md 是用户会手改的文件，安装器绝不能把本地改动覆盖掉；
//                确实要用真源覆盖时显式加 `--force`。
// - 写入走 tmp + rename（原子），避免宿主在同一 step 里 stat 到半份内容。
//
// 用法：node --experimental-strip-types scripts/sync-persona.ts [--force] [目标路径]
//       （默认 ~/.opencode/PERSONA.md）
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PERSONA_FILE_NAME } from "../src/core/pipeline/injection-source.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(repoRoot, "personas", "whale-girl.md");
const argv = process.argv.slice(2);
const force = argv.includes("--force");
const positional = argv.filter((arg) => arg !== "--force");
const target = positional[0] ?? join(homedir(), ".opencode", PERSONA_FILE_NAME);

try {
  const template = readFileSync(source, "utf8");
  mkdirSync(dirname(target), { recursive: true });
  const current = existsSync(target) ? readFileSync(target, "utf8") : null;

  if (current === template) {
    console.log(`  -> ${target} (无变化)`);
  } else if (current !== null && !force) {
    console.log(`  -> ${target} (本地已有改动，跳过；要用真源覆盖请加 --force)`);
  } else {
    const tmp = `${target}.tmp-${process.pid}`;
    writeFileSync(tmp, template, "utf8");
    renameSync(tmp, target);
    const bytes = Buffer.byteLength(template, "utf8");
    console.log(`  -> ${target} (已写入人设，${bytes} 字节)`);
  }
} catch (err) {
  console.error(`!! 人设文件写入失败: ${target}: ${err instanceof Error ? err.message : String(err)}`);
  console.error(`   请手动执行：node --experimental-strip-types ${join(repoRoot, "scripts", "sync-persona.ts")}`);
  process.exit(1);
}
