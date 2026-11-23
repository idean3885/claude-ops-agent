#!/bin/bash
# 상태줄 래퍼 (#1242). 상태줄 입력을 사용량 기록에 넘기고, 원래 상태줄 명령에 같은 입력을 넘겨 출력을 그대로 낸다.
# 기록은 뒤로 떼어 기다리지 않는다. 기록이 실패해도 상태줄 출력은 원래대로다.
# 설치 · 해제: usage-log.py install | uninstall (원래 명령은 ~/.claude/ops-agent/statusline/original.cmd)
input=$(cat)
here=${BASH_SOURCE[0]%/*}
[ "$here" = "${BASH_SOURCE[0]}" ] && here=.
{ printf '%s' "$input" | python3 "$here/usage-log.py" record; } </dev/null >/dev/null 2>&1 &
original=$(cat "$HOME/.claude/ops-agent/statusline/original.cmd" 2>/dev/null)
case "$original" in *usage-statusline.sh*) original="" ;; esac
[ -n "$original" ] || exit 0
printf '%s' "$input" | /bin/sh -c "$original"
