#!/usr/bin/env bash
# cluster-write-allow.sh — ops-agent 클러스터 쓰기 가드 세션 허용 마커 관리.
#
# pre-tool-use.mjs 의 "운영 클러스터 쓰기 가드" 는 mutating kube/argocd/helm 명령을
# 이 마커가 있을 때만 통과시킨다. 사용자 명시 승인 후에만 켤 것.
#
# 사용: cluster-write-allow.sh on|off|status [ttl_minutes] [session_id]
#   on      마커 생성 (기본 TTL 30분). session_id 지정 시 그 세션에만 허용.
#   off     마커 삭제 (즉시 차단 복귀).
#   status  현재 허용 상태 출력.
set -euo pipefail

MARKER="$HOME/.claude/ops-agent/.cache/cluster-write-allow.json"
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
    echo "[cluster-write-allow] ON (TTL ${ttl}m${sid:+, session ${sid}})"
    ;;
  off)
    rm -f "$MARKER"
    echo "[cluster-write-allow] OFF"
    ;;
  status)
    if [ -f "$MARKER" ]; then
      echo "[cluster-write-allow] $(cat "$MARKER")"
    else
      echo "[cluster-write-allow] OFF (마커 없음)"
    fi
    ;;
  *)
    echo "usage: $0 on|off|status [ttl_minutes] [session_id]" >&2
    exit 2
    ;;
esac
