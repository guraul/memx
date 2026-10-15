// 相对 import 必须带 .ts 扩展名：`node --experimental-strip-types` 直接加载时
// 缺扩展名会 ERR_MODULE_NOT_FOUND（tsc/vitest 都发现不了，只有真跑才炸——
// 已两次踩到：./store/lock、../types）。bare specifier（node:*、zod 等）不在此列。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkTs(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const RELATIVE_IMPORT_RE = /(?:from\s+|import\s*\(\s*)["'](\.\.?\/[^"']+?)["']/g;

describe("import 风格：相对 import 必须带 .ts 扩展名", () => {
  it("src/tests/scripts 全部相对 import 无遗漏（含 import type 与动态 import）", () => {
    const files = (["src", "tests", "scripts"] as const).flatMap((d) => walkTs(join(ROOT, d)));
    const problems: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf-8").split("\n");
      lines.forEach((line, i) => {
        RELATIVE_IMPORT_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = RELATIVE_IMPORT_RE.exec(line)) !== null) {
          if (!m[1]!.endsWith(".ts")) {
            problems.push(`${relative(ROOT, file)}:${i + 1}: ${m[1]}`);
          }
        }
      });
    }
    expect(problems, `相对 import 缺 .ts 扩展名：\n${problems.join("\n")}`).toEqual([]);
  });
});
