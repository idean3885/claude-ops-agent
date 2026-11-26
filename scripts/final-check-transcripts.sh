#!/usr/bin/env bash
# final-check-transcripts.sh — 최종 점검 항목 e 에서 제외할 녹음 정리본을 고른다 (#1287).
#
# transcribe 스킬은 한 출력 경로에 `<이름>.speakers.txt` 와 정리본 `<이름>.md` 를 함께 남기고,
# 정리본은 한 번 쓰면 다시 고치지 않는다. 받아쓴 발화 줄에는 종결 부호가 없으므로 항목 e 가
# 이 파일을 검출하면 두 규칙을 함께 지킬 방법이 없다. 같은 자리에 같은 이름의 화자 턴 표시본이
# 있는 `.md` 만 정리본으로 본다. 이름만 비슷한 다른 문서는 제외하지 않는다.
#
# 사용: final-check-transcripts.sh <md 경로...>  (표준 입력: 레포 HEAD 의 경로 목록, 한 줄에 하나)
# 출력: 정리본으로 판별된 md 경로, 한 줄에 하나
set -u
known=$(cat)
for f in "$@"; do
  case "$f" in *.md) ;; *) continue ;; esac
  grep -qxF -- "${f%.md}.speakers.txt" <<<"$known" && printf '%s\n' "$f"
done
exit 0
