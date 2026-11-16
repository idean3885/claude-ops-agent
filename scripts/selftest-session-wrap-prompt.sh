#!/usr/bin/env bash
# hooks/session-wrap-prompt.sh 발동 조건 셀프테스트 (#873).
#
# 마무리 신호에서만 종결 절차를 주입하고, 「마무리」가 다른 뜻으로 쓰인 문장에서는 조용해야 한다.
#   bash scripts/selftest-session-wrap-prompt.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$ROOT/hooks/session-wrap-prompt.sh"
export HOME="$(mktemp -d)"   # 지표 파일을 실제 홈에 남기지 않는다

fires() {
  printf '{"prompt":%s}' "$(printf '%s' "$1" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" \
    | bash "$HOOK" | grep -q '세션 마무리 감지'
}

PASS=0; FAIL=0
expect() {  # expect <fire|quiet> <문장>
  if fires "$2"; then got=fire; else got=quiet; fi
  if [ "$got" = "$1" ]; then PASS=$((PASS+1)); echo "OK   $1: $2"; else FAIL=$((FAIL+1)); echo "FAIL $1 기대, $got: $2"; fi
}

# 신호 목록과 완전히 같은 마지막 줄만 발동한다
expect fire  "세션 마무리"
expect fire  "세션 정리"
expect fire  "세션 종료하겠습니다"
expect fire  "세션 정리하고 끝냅니다"
expect fire  "세션을 마무리하죠"
expect fire  "세션 마무리 하겠습니다"
expect fire  "세션 마무리해 주세요"
expect fire  "세션 마무리해주세요"
expect fire  "세션 마무리 부탁합니다"
expect fire  "세션 마무리합시다."
expect fire  "이제 마무리합니다"
expect fire  "마무리합니다"
expect fire  "세션 마무리!"
expect quiet "세션 마무리…"
expect fire  "오늘은 여기까지 마무리하겠습니다."
expect fire  "정리 끝났으면
세션 마무리"
# 명사 앞 · 다른 낱말이 붙은 문장
expect quiet "세션 종료 훅"
expect quiet "세션 정리 스크립트"
expect quiet "세션 마무리 절차"
expect quiet "세션 종료 훅 부탁합니다"
expect quiet "세션 마무리 단계에서 볼트 수정하겠습니다"
expect quiet "세션 정리하고 나서 훅 코드 고쳐 주세요"
expect quiet "세션 마무리라는 말의 뜻이 뭐죠"
# 부정 · 질문
expect quiet "세션 마무리 하나요"
expect quiet "세션 마무리할까요"
expect quiet "세션 종료하고싶지않아요"
expect quiet "세션 마무리 안 합니다"
# 「마무리」가 다른 뜻 · 대상이 세션이 아닌 줄
expect quiet "마무리 단계 문서 정리"
expect quiet "PR 마무리했습니다 확인 부탁"
expect quiet "PR 리뷰 마무리합니다"
expect quiet "구현을 마무리하고 테스트를 돌립니다 결과 알려주세요"
# 붙여 넣은 글 안의 줄
expect quiet "아래 글을 교정해 주세요
이 절은 결론으로 마무리합니다.
다음 절은 부록입니다"
expect quiet "교정 부탁
세션 마무리
위 두 줄은 제목 후보입니다"

echo "$PASS/$((PASS+FAIL)) 통과"
[ "$FAIL" -eq 0 ]
