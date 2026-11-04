#!/usr/bin/env bash
# review.sh — 薄转发：审核准备与判定落盘交给共享包 dsh-pipeline
#
# 为什么只剩一个壳: 「读 PR 的 diff 生成审核请求 / 把判定写成记录」的唯一实现是共享包
#   dsh-pipeline 的 review 子命令；本仓只保留参数校验与转发，免得两份实现各自漂移
#   （由来同 merge-pr.sh）。
#
# 用法:
#   scripts/pipeline/review.sh prepare <PR号> [--model <m>]
#   scripts/pipeline/review.sh publish <PR号> --response <文件> [--round <n>] [--model <m>] [--provider <p>] [--form <f>]
#   scripts/pipeline/review.sh <动作> ... -C <dir>     # 指定目标工作区（同 --worktree；root 仍取主工作区）
#
# 参数映射: <PR号> → --pr <号>；-C/--worktree <dir> → --root <dir>（resolve_work_dir 解析）；
#   --model / --round / --provider / --form / --response 原样透传，
#   --flag=值 与 --flag 值 两种写法都支持（同 merge-pr.sh）。prepare 只接受 --model，publish 必须给 --response。
#
# root 取主工作区: 请求写 <root>/.tmp/review/<pr>/、记录写 <root>/.dsh-web/reviews/，
#   落在主仓才不会随 worktree 一起被删——与 merge-pr.sh 同一口径。
#
# 退出码: 包的退出码原样透传（壳里参数错误 die 为 1；包的参数/判定错误为 1 或 2）。
source "$(dirname "$0")/lib.sh"
require_gh
require_pipeline_pkg

usage="用法: $0 prepare <PR号> [--model <m>] | $0 publish <PR号> --response <文件> [--round <n>] [--model <m>] [--provider <p>] [--form <f>]"

ACTION="${1:-}"
case "${ACTION}" in
  prepare|publish) shift ;;
  -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
  "") die "${usage}" ;;
  *)  die "未知动作: ${ACTION}（允许 prepare / publish）" ;;
esac

PR=""
if [[ $# -gt 0 ]]; then PR="$1"; shift; fi
[[ "${PR}" =~ ^[1-9][0-9]*$ ]] || die "<PR号> 需要正整数（${usage}）"

HAS_MODEL=0; HAS_RESPONSE=0; HAS_ROUND=0; HAS_PROVIDER=0; HAS_FORM=0
MODEL=""; RESPONSE=""; ROUND=""; PROVIDER=""; FORM=""
while [[ $# -gt 0 ]]; do
  a="$1"; shift
  case "${a}" in
    --model=*)    MODEL="${a#*=}";    HAS_MODEL=1 ;;
    --response=*) RESPONSE="${a#*=}"; HAS_RESPONSE=1 ;;
    --round=*)    ROUND="${a#*=}";    HAS_ROUND=1 ;;
    --provider=*) PROVIDER="${a#*=}"; HAS_PROVIDER=1 ;;
    --form=*)     FORM="${a#*=}";     HAS_FORM=1 ;;
    --model|--response|--round|--provider|--form)
      [[ $# -ge 1 ]] || die "${a} 缺少取值"
      case "${a}" in
        --model)    MODEL="$1";    HAS_MODEL=1 ;;
        --response) RESPONSE="$1"; HAS_RESPONSE=1 ;;
        --round)    ROUND="$1";    HAS_ROUND=1 ;;
        --provider) PROVIDER="$1"; HAS_PROVIDER=1 ;;
        --form)     FORM="$1";     HAS_FORM=1 ;;
      esac
      shift ;;
    -C|--worktree)
      [[ $# -ge 1 ]] || die "${a} 缺少取值"
      TARGET_DIR_OVERRIDE="$1"; shift ;;
    --worktree=*) TARGET_DIR_OVERRIDE="${a#*=}" ;;
    -*) die "未知参数: ${a}（${usage}）" ;;
    *)  die "多余的位置参数: ${a}（${usage}）" ;;
  esac
done

# —— 动作各自的必填/允许项：在壳里先拒，省掉一次包调用（判定全在包里）——
if [[ "${ACTION}" == "prepare" ]]; then
  [[ $HAS_RESPONSE -eq 0 && $HAS_ROUND -eq 0 && $HAS_PROVIDER -eq 0 && $HAS_FORM -eq 0 ]] \
    || die "prepare 只支持 --model（${usage}）"
else
  [[ $HAS_RESPONSE -eq 1 && -n "${RESPONSE}" ]] || die "publish 必须给 --response <文件>（${usage}）"
fi

resolve_work_dir

# —— root 取主工作区（请求与记录落在主仓，不随 worktree 一起被删；同 merge-pr.sh）——
MAIN_WT=$(git -C "${WORK_DIR}" worktree list --porcelain | awk '/^worktree /{print $2; exit}')
[[ -n "${MAIN_WT}" ]] || die "找不到主工作区"

# —— 只做参数映射，不做任何判定（判定全在包里）——
set -- review "${ACTION}" --pr "${PR}" --root "${MAIN_WT}"
if [[ "${ACTION}" == "publish" ]]; then set -- "$@" --response "${RESPONSE}"; fi
if [[ $HAS_ROUND -eq 1 ]];     then set -- "$@" --round "${ROUND}"; fi
if [[ $HAS_MODEL -eq 1 ]];     then set -- "$@" --model "${MODEL}"; fi
if [[ $HAS_PROVIDER -eq 1 ]];  then set -- "$@" --provider "${PROVIDER}"; fi
if [[ $HAS_FORM -eq 1 ]];      then set -- "$@" --form "${FORM}"; fi

info "共享 pipeline 包: ${PIPELINE_HOME}"
info "转发: node ${PIPELINE_CLI_PATH} $*"

set +e
node "${PIPELINE_CLI_PATH}" "$@"
RC=$?
set -e
exit "${RC}"
