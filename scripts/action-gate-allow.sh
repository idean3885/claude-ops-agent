#!/usr/bin/env bash
# action-gate-allow.sh — ops-agent 액션 게이트 세션 허용 마커 관리.
#
# pre-tool-use.mjs 의 "액션 게이트" 는 되돌리기 어려운/외부 영향 행위(클러스터 mutation·
# PR 머지·릴리즈·force push·리소스 삭제)를 이 마커가 있을 때만 통과시킨다.
# 사용자 명시 승인 후에만 켤 것.
#
# 사용: action-gate-allow.sh on|off|status [ttl_minutes] [session_id]
#   on      마커 생성 (기본 TTL 30분). session_id 지정 시 그 세션에만 허용.
#   off     마커 삭제 (즉시 차단 복귀).
#   status  현재 허용 상태 출력.
set -euo pipefail

MARKER="$HOME/.claude/ops-agent/.cache/action-gate-allow.json"
cmd="${1:-status}"

case "$cmd" in
  on)
    ttl="${2:-30}"
    sid="${3:-}"
    mkdir -p "$(dirname "$MARKER")"
    now_ms=$(( $(date +%s) * 1000 ))
    exp=$(( now_ms + ttl * 60000 ))
    if [ -n "$sid" ]; then
      printf '{"expiresAt":%s,"sessionId":"%s"}\n' "$exp" "$sid" > "$MARKER"
    else
      printf '{"expiresAt":%s}\n' "$exp" > "$MARKER"
    fi
    echo "[action-gate-allow] ON (TTL ${ttl}m${sid:+, session ${sid}})"
    ;;
  off)
    rm -f "$MARKER"
    # 레거시 마커도 함께 정리
    rm -f "$HOME/.claude/ops-agent/.cache/cluster-write-allow.json"
    echo "[action-gate-allow] OFF"
    ;;
  status)
    if [ -f "$MARKER" ]; then
      echo "[action-gate-allow] $(cat "$MARKER")"
    else
      echo "[action-gate-allow] OFF (마커 없음)"
    fi
    ;;
  *)
    echo "usage: $0 on|off|status [ttl_minutes] [session_id]" >&2
    exit 2
    ;;
esac
