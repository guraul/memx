#!/usr/bin/env bash
# test-forwarding.sh — 六个转发壳的契约自检
#
# 用法: bash scripts/pipeline/test-forwarding.sh
# 原理: 在临时目录里伪造 git / gh / node 与一个假的 dsh-pipeline 包（argv 记入日志），
#       把每个壳跑一遍再断言「转发出去的命令行」。全程不碰真实远端与 GitHub。
#
# 断言:
#   ① new-task.sh 125           → task 125 --root <脚本所属仓> --worktrees-dir /Users/gubin/workspace/memx-worktrees
#   ② new-task.sh 125 my-slug   → task 125 --slug my-slug --root … --worktrees-dir …（本仓硬约束，两个写法都带）
#   ③ new-task.sh 无参 / 非数字 → 退出 1，且不调用包
#   ④ open-pr.sh                → pr --root …
#   ⑤ open-pr.sh --issue 42     → pr --root … --issue 42
#   ⑥ open-pr.sh --issue 0      → 退出 1，且不调用包
#   ⑦ merge-pr.sh 7 --record f  → merge --pr 7 --root <主工作区> --record f
#   ⑧ merge-pr.sh 7 --no-review（缺 --reason）→ 退出 1，且不调用包
#   ⑨ 包缺失（DSH_PIPELINE_HOME 指向不存在的目录）→ 退出 1
#   ⑩ merge-pr.sh task/7-x（分支名）→ merge --pr 7（REST 解析）
#   ⑪ review.sh prepare 7      → review prepare --pr 7 --root <主工作区>
#   ⑫ review.sh publish 7 --response r.txt --round 2 → review publish --pr 7 --root <主工作区> --response r.txt --round 2
#   ⑬ review.sh prepare 缺 PR号 / publish 缺 --response → 退出 1，且不调用包
#   ⑭ 自检：壳退出码非零时（成对断言的第一、二条都会）报红 → 证明退出码检查不形同虚设
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pipeline-forward.XXXXXX")"
TMP="$(cd "$TMP" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT

# 本仓硬约束（AGENTS.md 强制规定 16）：worktree 必须在仓库外，断言转发里带这个参数
WTDIR="/Users/gubin/workspace/memx-worktrees"

FAIL=0
LAST_RC=0   # run 记下的最近一次壳退出码，expect 缺省读它（调用点不再传 $?——成对断言的第二条会取到上一条 expect 的返回值，恒 0）
LOG="$TMP/argv.log"
export STUB_LOG="$LOG"   # 桩包把 argv 追加到这里
PKG="$TMP/pkg"
mkdir -p "$PKG/bin" "$TMP/bin" "$TMP/repo/.git"

cat > "$PKG/bin/cli.mjs" <<'STUB'
import { appendFileSync } from 'node:fs'
appendFileSync(process.env.STUB_LOG, `${process.argv.slice(2).join(' ')}\n`)
if (process.env.STUB_RC) process.exit(Number(process.env.STUB_RC))
STUB
chmod +x "$PKG/bin/cli.mjs"

# git / gh 打桩：git 只回显「主工作区」，gh REST 列表查询回 7
cat > "$TMP/bin/git" <<STUB
#!/bin/sh
case "\$*" in
  *"worktree list --porcelain"*) printf 'worktree %s\nbranch refs/heads/main\n' "$TMP/repo" ;;
  *"rev-parse --show-toplevel"*) printf '%s\n' "$TMP/repo" ;;
  *"rev-parse --git-common-dir"*) printf '%s\n' "$TMP/repo/.git" ;;
  *"branch --show-current"*) printf 'task/7-x\n' ;;
  *) exit 0 ;;
esac
STUB
cat > "$TMP/bin/gh" <<'STUB'
#!/bin/sh
case "$*" in
  *"pulls?head="*) printf '7\n' ;;
esac
exit 0
STUB
chmod +x "$TMP/bin/git" "$TMP/bin/gh"

expect() { # expect <名称> <期望子串> [退出码]：退出码缺省取 LAST_RC（最近一次 run 的壳退出码），失败返回 1
  local name="$1" want="$2" rc="${3-$LAST_RC}"
  local got; got="$(cat "$LOG" 2>/dev/null | tail -1)"
  if [[ "$rc" -ne 0 ]]; then
    echo "  ✗ $name：退出码 $rc（期望 0）"
    FAIL=1
    return 1
  elif [[ "$got" != *"$want"* ]]; then
    echo "  ✗ $name：转发命令不含「$want」，实际: ${got:-<空>}"
    FAIL=1
    return 1
  else
    echo "  ✓ $name"
    return 0
  fi
}
expect_fail() { # expect_fail <名称> <命令...>
  local name="$1"; shift
  : > "$LOG"
  "$@" >/dev/null 2>&1
  local rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "  ✗ $name：应失败却退出 0"
    FAIL=1
  elif [[ -s "$LOG" ]]; then
    echo "  ✗ $name：应拒绝却仍调用了包"
    FAIL=1
  else
    echo "  ✓ $name"
  fi
}

run() { : > "$LOG"; DSH_PIPELINE_HOME="$PKG" PATH="$TMP/bin:$PATH" "$@"; LAST_RC=$?; }

echo "── ① new-task.sh 125"
run bash "$HERE/new-task.sh" 125 >/dev/null 2>&1
expect "issue 号转发" "task 125 --root"
expect "worktrees-dir 固定转发（仓外容器）" "--worktrees-dir $WTDIR"

echo "── ② new-task.sh 125 my-slug"
run bash "$HERE/new-task.sh" 125 my-slug >/dev/null 2>&1
expect "slug 透传" "task 125 --slug my-slug"
expect "slug 下仍带 worktrees-dir" "--worktrees-dir $WTDIR"

echo "── ③ new-task.sh 用法错误"
expect_fail "无参数" env DSH_PIPELINE_HOME="$PKG" PATH="$TMP/bin:$PATH" bash "$HERE/new-task.sh"
expect_fail "非数字" env DSH_PIPELINE_HOME="$PKG" PATH="$TMP/bin:$PATH" bash "$HERE/new-task.sh" abc

echo "── ④⑤⑥ open-pr.sh"
run bash "$HERE/open-pr.sh" >/dev/null 2>&1
expect "默认转发" "pr --root"
run bash "$HERE/open-pr.sh" --issue 42 >/dev/null 2>&1
expect "--issue 透传" "pr --root"
expect "--issue 值真的到达包" "--issue 42"
expect_fail "--issue 0" env DSH_PIPELINE_HOME="$PKG" PATH="$TMP/bin:$PATH" bash "$HERE/open-pr.sh" --issue 0

echo "── ⑦⑧ merge-pr.sh"
REC="$TMP/rec.json"; echo '{}' > "$REC"
run bash "$HERE/merge-pr.sh" 7 --review-record="$REC" >/dev/null 2>&1
expect "参数映射" "merge --pr 7"
expect "--review-record → --record" "--record $REC"
expect "root 取主工作区" "--root $TMP/repo"

echo "── ⑩ 分支名 → PR 号（REST）"
run bash "$HERE/merge-pr.sh" task/7-x >/dev/null 2>&1
expect "分支名解析成 PR 号" "merge --pr 7"
expect_fail "--no-review 缺 --reason" env DSH_PIPELINE_HOME="$PKG" PATH="$TMP/bin:$PATH" bash "$HERE/merge-pr.sh" 7 --no-review

echo "── ⑨ 包缺失"
DSH_PIPELINE_HOME="$TMP/nope" bash "$HERE/new-task.sh" 125 >/dev/null 2>&1
[[ $? -ne 0 ]] && echo "  ✓ 包缺失时拒绝" || { echo "  ✗ 包缺失时未拒绝"; FAIL=1; }

echo "── ⑪ review.sh prepare"
run bash "$HERE/review.sh" prepare 7 >/dev/null 2>&1
expect "prepare 转发" "review prepare --pr 7 --root $TMP/repo"

echo "── ⑫ review.sh publish"
run bash "$HERE/review.sh" publish 7 --response r.txt --round 2 >/dev/null 2>&1
expect "publish 转发" "review publish --pr 7 --root $TMP/repo --response r.txt --round 2"
run bash "$HERE/review.sh" publish 7 --response=r.txt --round=2 >/dev/null 2>&1
expect "--flag=值 写法" "review publish --pr 7 --root $TMP/repo --response r.txt --round 2"

echo "── ⑬ review.sh 缺参"
expect_fail "prepare 缺 PR号" env DSH_PIPELINE_HOME="$PKG" PATH="$TMP/bin:$PATH" bash "$HERE/review.sh" prepare
expect_fail "publish 缺 --response" env DSH_PIPELINE_HOME="$PKG" PATH="$TMP/bin:$PATH" bash "$HERE/review.sh" publish 7

echo "── ⑭ 自检：壳退出码非零时 expect 必须报红"
# 这一条保护的是 expect 的 rc 闸门本身：桩包强制非零退出（STUB_RC=1），
# 壳会转发失败、run() 记下非零退出码，成对断言必须因此报红。
# 放在最后：子 shell 里的 LAST_RC / FAIL 不污染上面的结果。
if ( LAST_RC=1; expect "自检：壳非零" "task 125" ) >/dev/null 2>&1; then
  echo "  ✗ ⑭ 自检失败：壳退出码非零，expect 仍判成功"
  FAIL=1
else
  echo "  ✓ ⑭ 壳非零时 expect 判失败"
fi

# 再验一次真实路径：让桩包以 1 退出，壳必然失败，这次 run 的 LAST_RC 应为非零
STUB_RC=1 run bash "$HERE/new-task.sh" 125 >/dev/null 2>&1
if [[ "${LAST_RC}" -ne 0 ]]; then
  echo "  ✓ ⑭ 桩包失败时壳退出码非零（$LAST_RC）"
else
  echo "  ✗ ⑭ 桩包失败但壳仍退出 0"
  FAIL=1
fi
unset STUB_RC

echo
if [[ $FAIL -eq 0 ]]; then echo "✓ 全部通过"; else echo "✗ 有失败项"; fi
exit $FAIL
