#!/usr/bin/env bash
# lab-repo-create.sh 가 레포 생성과 머지 뒤 head 브랜치 자동 삭제를 함께 거는지 확인한다(--dry-run, 네트워크 없음).
set -uo pipefail
S="$(cd "$(dirname "$0")" && pwd)/lab-repo-create.sh"
out=$(bash "$S" demo-org/demo-lab "설명" --dry-run)
fail=0
echo "$out" | grep -q '^gh repo create demo-org/demo-lab --public' || { echo "FAIL: 생성 명령 없음"; fail=1; }
echo "$out" | grep -q 'delete_branch_on_merge=true' || { echo "FAIL: 자동 삭제 설정 없음"; fail=1; }
echo "$out" | grep -q 'protection' && { echo "FAIL: 보호 규칙을 건다"; fail=1; }
out2=$(bash "$S" demo-org/demo-lab --dry-run)
echo "$out2" | grep -q -- '--description ' || { echo "FAIL: 설명 생략 처리"; fail=1; }
echo "$out2" | grep -q -- '--dry-run' && { echo "FAIL: --dry-run 이 설명으로 들어감"; fail=1; }
[ $fail = 0 ] && echo "selftest-lab-repo-create: ok"
exit $fail
