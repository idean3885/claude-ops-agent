#!/usr/bin/env bash
# UserPromptSubmit hook: 세션 마무리 신호를 받은 턴에 종결 절차를 주입한다 (#873).
#
# 원칙은 docs/working-principles.md 「세션 마무리는 종결로 끝낸다」에 있다. 원칙이 있어도 마무리 때
# 처리 목록만 내고 남은 일을 다음으로 넘기는 실패가 반복돼, 그 시점에 읽는 단계를 둔다.
# 본문은 복제하지 않고 가리킨다. 차단이 아니라 알림이다.
#
# 입력: stdin 의 hook JSON (`prompt` 필드)
# 지표: ~/.claude/ops-agent/metrics/session-wrap-prompt.jsonl (발동마다 한 줄)
set -euo pipefail

INPUT=$(cat)
PROMPT=$(printf '%s' "$INPUT" | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("prompt",""))
except Exception:
    pass' 2>/dev/null || true)

[[ -n "$PROMPT" ]] || exit 0

# 마무리 신호의 정의는 원칙 문서 「세션 마무리는 종결로 끝낸다」의 「신호」 항목이다.
# 마지막 비어 있지 않은 줄에서 공백과 끝의 마침표 · 느낌표를 빼고 아래 목록과 완전히 같을 때만 발동한다.
# 목록 밖의 문장은 판정하지 않는다. 놓친 말투는 지표를 보고 목록에 더한다.
LAST=$(printf '%s\n' "$PROMPT" | awk 'NF{l=$0} END{print l}' | tr -d '[:space:]' | sed -E 's/[.!]+$//')
ENDINGS='(합니다|하겠습니다|할게요|합시다|하자|하죠|해요|해주세요|해줘|부탁합니다|부탁드립니다|하고끝냅니다)'
MATCHED=""
if printf '%s' "$LAST" | grep -qE "^세션(을|를)?(마무리|종료|정리)${ENDINGS}?$"; then
  MATCHED="session"
elif printf '%s' "$LAST" | grep -qE "^(이제|여기서|오늘은여기까지)?마무리${ENDINGS}$"; then
  MATCHED="line-end"
fi
[[ -n "$MATCHED" ]] || exit 0

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
METRICS_FILE="$HOME/.claude/ops-agent/metrics/session-wrap-prompt.jsonl"
mkdir -p "$(dirname "$METRICS_FILE")"
printf '{"ts":"%s","matched":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$MATCHED" >>"$METRICS_FILE" 2>/dev/null || true

cat <<EOF
[세션 마무리 감지] 종결로 끝낸다. 절차는 $PLUGIN_ROOT/docs/working-principles.md 「세션 마무리는 종결로 끝낸다」를 읽고 따른다.
단계: 1 대상 수집 → 2 잔여 처리 · 묶음 → 3 막힌 것의 자리 결정 → 4 판결(첫 줄 「종결」 · 「미종결」)
EOF
