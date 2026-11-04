#!/usr/bin/env bash
# lib.sh — pipeline 公共常量与工具（被其他脚本 source，不直接执行）
# 手册：AGENTS.md 强制规定 16（worktree 纪律）+ ~/.dsh/AGENTS.md §7（交付流程）
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "✗ 必须在 memx 仓库（或其 worktree）内运行" >&2
  exit 1
}

# GitHub 仓库（origin 为 HTTPS：https://github.com/guraul/memx.git）
REPO="guraul/memx"

die()  { echo "✗ $*" >&2; exit 1; }
info() { echo "→ $*"; }
ok()   { echo "✓ $*"; }

require_gh() {
  command -v gh >/dev/null || die "需要 gh CLI（https://cli.github.com），且已 gh auth login"
}

# 把 TARGET_DIR_OVERRIDE（可空）解析成绝对物理路径写入 WORK_DIR
resolve_work_dir() {
  local dir="${TARGET_DIR_OVERRIDE:-$REPO_ROOT}"
  if [[ ! -d "$dir" ]]; then
    WORK_DIR="$dir"   # 让 die 的上下文显示的是那个不存在目标，而不是默认值
    die "目标目录不存在: ${dir}"
  fi
  WORK_DIR="$(cd "$dir" && pwd -P)"
}

# —— 共享 pipeline 包（dsh-pipeline）解析 ——
# 为什么需要集中解析: 转发壳通常在 worktree 里被调用，而依赖装在**主工作区**的
#   tools/node_modules；用 REPO_ROOT（= 当前 worktree 根）拼路径会落空。
# 查找顺序（与 self-dsh-plugins 的 resolve_pipeline_cli 一致，别再各写一份）：
#   ① $DSH_PIPELINE_HOME（显式覆盖：设了就是权威来源，不再回退——免得设错却静默用到别的包）
#   ② <主工作区>/tools/node_modules/dsh-pipeline
#      （主工作区 = git common dir 的父目录；worktree 里 common dir 指向主仓 .git）
#   ③ <当前脚本所属仓>/tools/node_modules/dsh-pipeline（非 worktree 的常规场景）
# 结果: 成功设置 PIPELINE_CLI_PATH / PIPELINE_HOME；失败返回 1，并把试过的路径写进 PIPELINE_TRIED
#   （用全局变量而不是 stdout：调用方若在 $(...) 里取值，子 shell 里改的变量传不回来）。
PIPELINE_CLI_PATH=""
PIPELINE_HOME=""
PIPELINE_TRIED=""

_pipeline_cli_candidates() {
  local common main
  if [[ -n "${DSH_PIPELINE_HOME:-}" ]]; then
    printf '%s\n' "${DSH_PIPELINE_HOME%/}/bin/cli.mjs"
    return 0
  fi
  # 旧 git 可能返回相对路径（主工作区里就是 `.git`）：先按 REPO_ROOT 折成绝对路径，再取父目录
  common=$(git -C "${REPO_ROOT}" rev-parse --git-common-dir 2>/dev/null) || common=""
  if [[ -n "${common}" && "${common}" != /* ]]; then
    common="${REPO_ROOT}/${common}"
  fi
  if [[ -n "${common}" ]]; then
    common=$( (cd "${common}" 2>/dev/null && pwd -P) ) || common=""
  fi
  if [[ -n "${common}" ]]; then
    main=$(dirname "${common}")
    printf '%s\n' "${main}/tools/node_modules/dsh-pipeline/bin/cli.mjs"
  fi
  printf '%s\n' "${REPO_ROOT}/tools/node_modules/dsh-pipeline/bin/cli.mjs"
}

resolve_pipeline_cli() {
  local candidate seen=""
  PIPELINE_CLI_PATH=""
  PIPELINE_TRIED=""
  while IFS= read -r candidate; do
    [[ -n "${candidate}" ]] || continue
    # 主工作区 == 当前仓时候选会重复，只报一次
    case "${seen}" in *"|${candidate}|"*) continue ;; esac
    seen="${seen}|${candidate}|"
    if [[ -f "${candidate}" ]]; then
      PIPELINE_CLI_PATH="${candidate}"
      return 0
    fi
    PIPELINE_TRIED="${PIPELINE_TRIED}${candidate} "
  done < <(_pipeline_cli_candidates)
  return 1
}

# 供转发壳调用：成功则设置 PIPELINE_CLI_PATH / PIPELINE_HOME；失败 die
require_pipeline_pkg() {
  if ! resolve_pipeline_cli; then
    die "找不到共享 pipeline 包（dsh-pipeline）。已尝试: ${PIPELINE_TRIED}；请在主工作区的 tools/ 里跑 pnpm install，或设置 DSH_PIPELINE_HOME 指向包目录"
  fi
  PIPELINE_HOME=$(dirname "$(dirname "${PIPELINE_CLI_PATH}")")
  command -v node >/dev/null 2>&1 || die "需要 node：共享包是 Node CLI"
}
