#!/usr/bin/env bash
# open-pr.sh — 薄转发：推送分支并开 PR 交给共享包 dsh-pipeline
#
# 用法（在 worktree 内运行）:
#   scripts/pipeline/open-pr.sh [--issue <n>]
# --issue: 分支名不含 issue 号时（如 task/pipeline-dsh）指定 PR 要关哪个 issue；分支仍必须是 task/*。
#
# 相对旧实现的能力差异（有意为之，包暂不支持）:
#   * 不再支持 --title / --body-file —— PR 标题与正文由包按模板生成（正文首行固定 Closes #<号>）。
#   * cwd 不参与目标解析：始终以脚本所属仓为准。
source "$(dirname "$0")/lib.sh"
require_gh
require_pipeline_pkg

ISSUE_ARG=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --issue)
      [[ $# -ge 2 && "$2" =~ ^[1-9][0-9]*$ ]] || die "--issue 需要正整数"
      ISSUE_ARG=(--issue "$2"); shift 2 ;;
    --issue=*)
      val="${1#*=}"
      [[ "${val}" =~ ^[1-9][0-9]*$ ]] || die "--issue 需要正整数"
      ISSUE_ARG=(--issue "${val}"); shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) die "未知参数: $1（支持 --issue <n>）" ;;
  esac
done

set -- pr --root "${REPO_ROOT}"
[[ ${#ISSUE_ARG[@]} -gt 0 ]] && set -- "$@" "${ISSUE_ARG[@]}"

info "转发: node ${PIPELINE_CLI_PATH} $*"
set +e
node "${PIPELINE_CLI_PATH}" "$@"
exit $?
