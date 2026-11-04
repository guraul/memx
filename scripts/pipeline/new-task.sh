#!/usr/bin/env bash
# new-task.sh — 薄转发：建 worktree 交给共享包 dsh-pipeline
#
# 用法: scripts/pipeline/new-task.sh <issue号> [slug]
#   slug 可选：手动指定分支/目录后缀（缺省由 issue 标题生成；中文标题会退化成哈希，可读性差时用它）。
#   会规范化：转小写、非字母数字折成 '-'、截断到 40 字符。
#
# 本仓硬约束（AGENTS.md 强制规定 16）: worktree 必须建在**仓库外**的
#   /Users/gubin/workspace/memx-worktrees/ —— 本机 opencode 从主仓加载本仓源码，
#   仓内切分支会让插件加载到未合并代码，所以这里固定转发 --worktrees-dir；
#   包内部仍拼 <号>-<slug>，缺省的 <root>/.worktrees 不再使用。
#
# 为什么只剩一个壳: 「读 issue 标题 → slug → 建 task/<号>-<slug> 分支与 worktree」
#   的唯一实现是共享包；本仓只保留参数原样转发，免得两份实现各自漂移。
source "$(dirname "$0")/lib.sh"
require_gh
require_pipeline_pkg

ISSUE="${1:-}"
SLUG="${2:-}"
if [[ -z "${ISSUE}" ]] || ! [[ "${ISSUE}" =~ ^[1-9][0-9]*$ ]]; then
  echo "用法: $0 <issue号> [slug]" >&2
  exit 1
fi

set -- task "${ISSUE}"
[[ -n "${SLUG}" ]] && set -- "$@" --slug "${SLUG}"
# cwd 不参与：始终以脚本所属仓为准
set -- "$@" --root "${REPO_ROOT}"
# 本仓特有：worktree 容器固定在仓库外（宿主从主仓加载源码）
set -- "$@" --worktrees-dir /Users/gubin/workspace/memx-worktrees

info "转发: node ${PIPELINE_CLI_PATH} $*"
set +e
node "${PIPELINE_CLI_PATH}" "$@"
exit $?
