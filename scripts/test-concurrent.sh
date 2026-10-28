#!/usr/bin/env bash
# memx · 测试并发验证（issue #35）：N 进程 × M 轮跑全量 vitest。
#
# 验证什么：每个测试文件都把 homedir mock 到 `/tmp/opencode-memx-*-${process.pid}`，
# 多进程同时跑时互不删目录；锁文件（withFileLock）在真实并发下不互相覆盖。
# 本脚本就是这条结论的可重复证据：任一进程任一用例失败 → 非零退出，并打印失败用例名。
#
# 用法（CI 与本机同一份）：
#   bash scripts/test-concurrent.sh                  # 默认 4 进程 × 3 轮
#   PROCS=8 ROUNDS=5 bash scripts/test-concurrent.sh
#   pnpm test:concurrent                             # 等价入口
#
# 隔离：每个进程给一个一次性 HOME（脚本结束即删），全程不碰真实 ~/.opencode / ~/.local/share。
# 依赖：本仓已装好依赖（node_modules/.bin/vitest）；脚本自己**不 install、不动 lockfile**。
#
# 退出码：0 = 全部轮次全绿；1 = 有失败；2 = 用法/环境问题。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2

PROCS="${PROCS:-4}"
ROUNDS="${ROUNDS:-3}"

case "$PROCS" in ''|*[!0-9]*|0) echo "✗ PROCS 必须是正整数（当前：$PROCS）" >&2; exit 2 ;; esac
case "$ROUNDS" in ''|*[!0-9]*|0) echo "✗ ROUNDS 必须是正整数（当前：$ROUNDS）" >&2; exit 2 ;; esac

VITEST="$ROOT/node_modules/.bin/vitest"
if [ ! -x "$VITEST" ]; then
  echo "✗ 找不到 $VITEST —— 先在本仓装依赖（脚本本身不 install）" >&2
  exit 2
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/memx-test-concurrent.XXXXXX")" || exit 2
LOGS="$WORK/logs"
mkdir -p "$LOGS" "$WORK/homes"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

# 从 vitest 日志里提取失败用例名（默认 reporter 的 ` FAIL  <file> > <suite> > <case>` 行）。
# 子进程强制 NO_COLOR，否则行首是 ANSI 转义、`^[[:space:]]*FAIL` 匹配不到。
# 取不到时调用方会回落到打印日志尾部。
failed_cases() {
  grep -E '^[[:space:]]*FAIL[[:space:]]+' "$1" 2>/dev/null \
    | sed -E 's/^[[:space:]]*FAIL[[:space:]]+//' \
    | sed -E 's/[[:space:]]+$//' \
    | sort -u
}

FAILED=0
TOTAL_START=$(date +%s)

for round in $(seq 1 "$ROUNDS"); do
  echo "▶ 第 ${round}/${ROUNDS} 轮：${PROCS} 进程并发（vitest run，全量）"
  round_start=$(date +%s)
  pids=""
  i=1
  while [ "$i" -le "$PROCS" ]; do
    log="$LOGS/r${round}p${i}.log"
    exit_file="$LOGS/r${round}p${i}.exit"
    home="$WORK/homes/r${round}p${i}"
    mkdir -p "$home/.config" "$home/.cache" "$home/.local/share"
    (
      HOME="$home" \
      XDG_CONFIG_HOME="$home/.config" \
      XDG_CACHE_HOME="$home/.cache" \
      XDG_DATA_HOME="$home/.local/share" \
      NO_COLOR=1 FORCE_COLOR=0 \
      "$VITEST" run >"$log" 2>&1
      echo "$?" >"$exit_file"
    ) &
    pids="$pids $!"
    i=$((i + 1))
  done
  for pid in $pids; do
    wait "$pid"
  done

  i=1
  while [ "$i" -le "$PROCS" ]; do
    exit_file="$LOGS/r${round}p${i}.exit"
    log="$LOGS/r${round}p${i}.log"
    status="$(cat "$exit_file" 2>/dev/null || echo "?")"
    if [ "$status" != "0" ]; then
      FAILED=1
      echo "  ✗ 进程 ${i} 失败（exit ${status}）"
      names="$(failed_cases "$log")"
      if [ -n "$names" ]; then
        printf '%s\n' "$names" | sed 's/^/      - /'
      else
        echo "      （未能解析失败用例名，日志尾部如下）"
        tail -n 20 "$log" | sed 's/^/      /'
      fi
    fi
    i=$((i + 1))
  done

  if [ "$FAILED" -eq 0 ]; then
    echo "  ✓ 第 ${round} 轮全绿（$(( $(date +%s) - round_start ))s）"
  else
    echo "  ✗ 第 ${round} 轮有失败，继续跑完剩余轮次以收集完整信息"
  fi
done

TOTAL=$(( $(date +%s) - TOTAL_START ))
if [ "$FAILED" -ne 0 ]; then
  echo "✗ 并发验证失败：${ROUNDS} 轮 × ${PROCS} 进程（${TOTAL}s）"
  exit 1
fi
echo "✓ 并发验证通过：${ROUNDS} 轮 × ${PROCS} 进程全绿（${TOTAL}s）"
