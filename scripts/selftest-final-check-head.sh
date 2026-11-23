#!/usr/bin/env bash
# selftest-final-check-head.sh — 최종 점검의 원격 head · 로컬 HEAD 비교 자체 점검 (#1212).
#
# final-check-head.sh 를 고쳤으면 돌린다. 임시 git 레포에서 브랜치 · 커밋을 만들어 실제로 실행한다.
#
# 사용: bash scripts/selftest-final-check-head.sh
# 종료 코드: 실패 1, 전부 통과 0
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SUT="$HERE/final-check-head.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK" || exit 1
git init -q -b main . && git config user.email t@t && git config user.name t
git commit -q --allow-empty -m one
OLD=$(git rev-parse HEAD)
git checkout -q -b feat/1
git commit -q --allow-empty -m two
NEW=$(git rev-parse HEAD)

failed=0
check() { # 이름 기대종료코드 인자...
  local name="$1" want="$2"; shift 2
  bash "$SUT" "$@" >/dev/null 2>&1
  local got=$?
  if [ "$got" = "$want" ]; then echo "PASS  $name"; else echo "FAIL  $name (want $want, got $got)"; failed=$((failed+1)); fi
}

check "같은 브랜치 · 같은 커밋은 통과" 0 feat/1 "$NEW"
check "같은 브랜치 · 이전 커밋(푸시 반영 지연)은 실패" 1 feat/1 "$OLD"
check "같은 브랜치 · 갈라진 커밋은 실패" 1 feat/1 0000000000000000000000000000000000000000
check "다른 브랜치를 보고 있으면 판정하지 않는다" 0 feat/2 "$OLD"
git checkout -q --detach HEAD
check "detached HEAD 는 판정하지 않는다" 0 feat/1 "$OLD"
cd /
check "레포 밖은 판정하지 않는다" 0 feat/1 "$OLD"

[ "$failed" = 0 ] && echo "전부 통과" || echo "${failed}건 실패"
exit $(( failed > 0 ))
