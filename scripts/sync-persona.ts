// 把仓库真源 `personas/whale-girl.md` 幂等复制到 `~/.opencode/PERSONA.md`（智能体人设，注入第三轨）。
// 幂等：内容一致则不写、不改 mtime；改完各打印一行「已写入 / 无变化」。
// 用法：node --experimental-strip-types scripts/sync-persona.ts [目标路径]   （默认 ~/.opencode/PERSONA.md）
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PERSONA_FILE_NAME } from "../src/core/pipeline/injection-source.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(repoRoot, "personas", "whale-girl.md");
const target = process.argv[2] ?? join(homedir(), ".opencode", PERSONA_FILE_NAME);

try {
  const template = readFileSync(source, "utf8");
  mkdirSync(dirname(target), { recursive: true });
  const current = existsSync(target) ? readFileSync(target, "utf8") : null;
  if (current === template) {
    console.log(`  -> ${target} (无变化)`);
  } else {
    writeFileSync(target, template, "utf8");
    console.log(`  -> ${target} (已写入人设，${template.length} 字节)`);
  }
} catch (err) {
  console.error(`!! 人设文件写入失败: ${target}: ${err instanceof Error ? err.message : String(err)}`);
  console.error(`   请手动执行：node --experimental-strip-types ${join(repoRoot, "scripts", "sync-persona.ts")}`);
  process.exit(1);
}
