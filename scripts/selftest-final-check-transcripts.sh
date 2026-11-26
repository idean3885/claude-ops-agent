#!/usr/bin/env bash
# selftest-final-check-transcripts.sh — 최종 점검 항목 e 의 녹음 정리본 판별 자체 점검 (#1287).
#
# final-check-transcripts.sh 를 고쳤으면 돌린다. 실제 스크립트를 실행해 출력을 비교한다.
#
# 사용: bash scripts/selftest-final-check-transcripts.sh
# 종료 코드: 실패 1, 전부 통과 0
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SUT="$HERE/final-check-transcripts.sh"
KNOWN='docs/rec/2026-11-24-review.md
docs/rec/2026-11-24-review.speakers.txt
docs/rec/2026-11-24-review.txt
docs/rec/README.md
docs/other.md
docs/rec/2026-11-24-review-notes.md'

failed=0
check() { # 이름 기대출력 인자...
  local name="$1" want="$2"; shift 2
  local got
  got=$(printf '%s\n' "$KNOWN" | bash "$SUT" "$@")
  if [ "$got" = "$want" ]; then echo "PASS  $name"; else echo "FAIL  $name (want [$want], got [$got])"; failed=$((failed+1)); fi
}

check "화자 턴 표시본이 옆에 있는 md 는 정리본이다" "docs/rec/2026-11-24-review.md" docs/rec/2026-11-24-review.md
check "같은 폴더의 다른 md 는 정리본이 아니다" "" docs/rec/README.md
check "이름 앞부분만 같은 md 는 정리본이 아니다" "" docs/rec/2026-11-24-review-notes.md
check "다른 폴더의 md 는 정리본이 아니다" "" docs/other.md
check "md 가 아닌 파일은 고르지 않는다" "" docs/rec/2026-11-24-review.txt
check "여러 파일 중 정리본만 고른다" "docs/rec/2026-11-24-review.md" docs/other.md docs/rec/2026-11-24-review.md docs/rec/README.md

[ "$failed" = 0 ] && echo "전부 통과" || echo "${failed}건 실패"
exit $(( failed > 0 ))
