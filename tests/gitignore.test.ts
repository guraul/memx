// #67：`.gitignore` 的 `docs/*` 曾把 init 生成物（`docs/pipeline/`、`docs/archive/`）静默吞掉，
// 只能靠 `git add -f` 入库；上游模板新增第三份文档时同样会丢。本仓无 CI，用这条测试把规则钉住。
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 必须带 --no-index：默认模式下已跟踪文件一律不报「被忽略」，规则写错也看不出来
function ignored(path: string): boolean {
  const r = spawnSync("git", ["check-ignore", "--no-index", "-q", path], { cwd: ROOT });
  if (r.status !== 0 && r.status !== 1) {
    throw new Error(`git check-ignore ${path} 失败: ${r.error?.message ?? String(r.stderr)}`);
  }
  return r.status === 0;
}

describe(".gitignore 放行 init 生成物", () => {
  it("docs/pipeline 与 docs/archive 不被忽略（含尚未生成的新文档）", () => {
    const paths = [
      "docs/pipeline/README.md",
      "docs/pipeline/review-loop.md",
      "docs/pipeline/future-doc.md",
      "docs/archive/pipeline/README.md",
    ];
    expect(paths.filter(ignored), "被忽略的生成物（init 后 git add -A 会静默丢失）").toEqual([]);
  });

  it("运行态产物仍然被忽略", () => {
    const paths = [".dsh-web/reviews/x.json", ".tmp/review/x.json"];
    expect(paths.filter((path) => !ignored(path)), "应被忽略却放行了").toEqual([]);
  });
});
