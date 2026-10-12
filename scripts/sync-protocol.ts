// 把 src/core/protocol-template.ts 的协议正文写到 ~/.opencode/memx-protocol.md。
// 幂等：内容一致则不写、不改 mtime。
// 用法：node scripts/sync-protocol.ts [目标路径]      （默认 ~/.opencode/memx-protocol.md）
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PROTOCOL_TEMPLATE,
  PROTOCOL_VERSION,
  PROTOCOL_FILE_NAME,
  PROTOCOL_INSTRUCTION,
} from "../src/core/protocol-template.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2] ?? join(homedir(), ".opencode", PROTOCOL_FILE_NAME);

try {
  mkdirSync(dirname(target), { recursive: true });
  const current = existsSync(target) ? readFileSync(target, "utf8") : null;
  if (current === PROTOCOL_TEMPLATE) {
    console.log(`  -> ${target} (已与仓库一致，未改动)`);
  } else {
    writeFileSync(target, PROTOCOL_TEMPLATE, "utf8");
    console.log(`  -> ${target} (写入协议 v${PROTOCOL_VERSION}，${PROTOCOL_TEMPLATE.length} 字节)`);
  }
  console.log(`     register it as: "${PROTOCOL_INSTRUCTION}" in ~/.config/opencode/opencode.json`);
} catch (err) {
  console.error(`!! 协议文件写入失败: ${target}: ${err instanceof Error ? err.message : String(err)}`);
  console.error(`   请手动执行：node ${join(repoRoot, "scripts", "sync-protocol.ts")}`);
  process.exit(1);
}