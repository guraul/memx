// core · 记忆全文检索（宿主无关，零宿主依赖）
//
// 由来：原先只有 `scripts/mem.ts` 的 `cmdSearch` 能跨 `.mem/*.md` 检索（返回 file:line）。
// CLI 退役后这段判定逻辑上提到 core，供宿主工具（DSH `memory_search`）直接调用，
// 检索语义与旧 CLI 逐字对齐：大小写不敏感、按行匹配、行号从 1 起、命中行 trim。
//
// 只读：本模块不写盘、不加锁（读的是写者锁内落盘的整文件，最多看到"上一个版本"）。
import { existsSync, readdirSync } from "node:fs";
import { dirname } from "node:path";

import { getMemoryDir, parseMemoryIndex, readMemoryFile, readMemoryIndex } from "./memory-md.ts";

/** 一处命中：哪个 slug 的哪个文件的第几行。 */
export interface SearchHit {
  slug: string;
  file: string;
  line: number;
  text: string;
}

/**
 * 记忆目录集合 = 索引里的 slug ∪ 磁盘上有 `.mem/` 的 slug（纯 fs 读，不解析内容）。
 * 后者兜住"文件在盘上但索引没登记"的孤儿（检索仍应能找到它们）。
 */
function allSlugs(): string[] {
  const slugs = new Set(parseMemoryIndex(readMemoryIndex()).sections.map((s) => s.slug));
  const projectsDir = dirname(dirname(getMemoryDir("_")));
  if (existsSync(projectsDir)) {
    for (const ent of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      if (existsSync(getMemoryDir(ent.name))) slugs.add(ent.name);
    }
  }
  return [...slugs].sort();
}

/** 某个 slug 下参与检索的记忆文件（`.md`、排除点开头，排序稳定便于复现）。 */
function listMemoryFiles(slug: string): string[] {
  const dir = getMemoryDir(slug);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && !f.startsWith("."))
    .sort();
}

/**
 * 跨 `.mem/*.md` 检索关键词（标题 / hook / 正文一视同仁——都是文件里的行）。
 *
 * @param keyword 关键词；大小写不敏感，空串返回空数组（不把"空串匹配一切"当命中）
 * @param slug    限定单个 slug；缺省检索全部 slug
 */
export function searchMemories(keyword: string, slug?: string): SearchHit[] {
  const kw = keyword.trim().toLowerCase();
  if (kw === "") return [];

  const slugs = slug !== undefined && slug !== "" ? [slug] : allSlugs();
  const hits: SearchHit[] = [];
  for (const current of slugs) {
    for (const file of listMemoryFiles(current)) {
      const content = readMemoryFile(current, file);
      if (!content) continue;
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.toLowerCase().includes(kw)) {
          hits.push({ slug: current, file, line: i + 1, text: line.trim() });
        }
      }
    }
  }
  return hits;
}
