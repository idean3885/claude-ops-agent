#!/usr/bin/env bash
# final-check-head.sh: PR 의 원격 head 와 로컬 HEAD 를 비교한다 (#1212).
#
# 강제 푸시 직후에는 PR API 가 이전 head 커밋을 돌려줄 수 있다. 그 값으로 점검하면
# 병합할 커밋과 다른 커밋에 통과 기록이 묶인다. 로컬에서 그 PR 브랜치를 보고 있을 때만 비교하고,
# 다른 브랜치 · 레포 밖 실행은 판정하지 않는다(로컬 HEAD 가 PR 과 무관하다).
#
# 사용: final-check-head.sh <PR head 브랜치> <PR head 커밋>
# 출력: 불일치면 사유 한 줄
# 종료: 0 = 일치 또는 판정 대상 아님, 1 = 불일치
set -u
PR_BRANCH="${1:?PR head 브랜치}"
PR_SHA="${2:?PR head 커밋}"

LOCAL_BRANCH=$(git symbolic-ref --quiet --short HEAD 2>/dev/null) || exit 0
[ "$LOCAL_BRANCH" = "$PR_BRANCH" ] || exit 0
LOCAL_SHA=$(git rev-parse HEAD 2>/dev/null) || exit 0
[ "$LOCAL_SHA" = "$PR_SHA" ] && exit 0

if git merge-base --is-ancestor "$PR_SHA" "$LOCAL_SHA" 2>/dev/null; then
  why="로컬이 앞서 있다. 푸시하지 않았거나 푸시가 아직 PR 에 반영되지 않았다"
else
  why="강제 푸시 직후 PR 이 이전 커밋을 보고 있거나, 로컬이 원격과 갈라졌다"
fi
printf 'PR head(%s)와 로컬 HEAD(%s)가 다르다. %s. git push 상태를 확인하고 잠시 뒤 같은 final-check.sh 명령을 다시 실행한다 (확인: gh pr view --json headRefOid -q .headRefOid)\n' "${PR_SHA:0:7}" "${LOCAL_SHA:0:7}" "$why"
exit 1
