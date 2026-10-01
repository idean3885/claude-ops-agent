#!/usr/bin/env bash
# UserPromptSubmit hook: 직전 응답에서 검출된 금지 표현 위반만 통지한다.
#
# 룰 목록은 컨텍스트에 주입하지 않는다 (#564). 25룰이 매 세션 약 5천 토큰을 차지했고,
# 교정 대상인 글은 교정 스킬(lint)이 tells_count.py 로 같은 룰을 대조한다.
# 대화 응답은 위반이 검출된 턴에만 이 훅이 교정을 요청한다.
#
# 입력: Stop 훅(hooks/forbidden-words-stop.sh)이 기록한 위반 목록
#       ~/.claude/.forbidden-violations-pending
#       파일에 패턴·매칭어·대체어가 이미 들어 있어 룰 재조회가 필요 없다.
set -euo pipefail

PENDING_FILE="$HOME/.claude/.forbidden-violations-pending"

[[ -f "$PENDING_FILE" ]] || exit 0

VIOLATIONS=$(cat "$PENDING_FILE")
rm -f "$PENDING_FILE"

[[ -n "${VIOLATIONS//[[:space:]]/}" ]] || exit 0

cat <<EOF
[직전 응답에서 검출된 금지 표현]
$VIOLATIONS
→ 다음 응답에서 위 표현을 대체어로 교정한다. 사과는 1회만, 반복하지 않는다.
EOF
