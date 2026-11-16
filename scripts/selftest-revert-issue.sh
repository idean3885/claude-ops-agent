#!/usr/bin/env bash
# revert-issue.sh 자체 점검 (ADR-0040 결정 4).
# 임시 레포에서 세 경우를 고정한다: 버전 · 체인지로그만 충돌 → 롤백, 내용 충돌 → 멈춤(1),
# 충돌 아닌 실패(머지 커밋) → 멈춤(1).
set -uo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
cd "$T"
git init -q -b main && git config user.name t && git config user.email t@t
mkdir -p scripts .claude-plugin
cp "$SRC/revert-issue.sh" "$SRC/bump-version.sh" "$SRC/changelog.py" scripts/
echo '{"version":"1.0.0"}' > .claude-plugin/plugin.json
echo '{"plugins":[{"version":"1.0.0"}]}' > .claude-plugin/marketplace.json
echo 1.0.0 > VERSION
printf '# C\n<!-- bump-version.sh 삽입 지점 -->\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n\n### Added\n* init (#0)\n' > CHANGELOG.md
echo a > a.txt; echo b > b.txt
git add -A && git commit -qm init

fail=0
check() { if [ "$2" = "$3" ]; then echo "✔ $1"; else echo "✘ $1 (기대 $2, 실제 $3)"; fail=1; fi; }

# 1. 이슈 커밋(내용 + 체인지로그) 뒤 릴리즈 커밋 → 체인지로그만 충돌
echo a2 > a.txt; ./scripts/bump-version.sh add 'feat: a 변경 (#1)' >/dev/null; git commit -qam 'feat: a 변경 (#1)'; C1=$(git rev-parse HEAD)
./scripts/bump-version.sh release 1.1.0 >/dev/null; git commit -qam 'chore: release 1.1.0'
./scripts/revert-issue.sh "$C1" 1 >/dev/null 2>&1; rc=$?
check "메타만 충돌 → 롤백" 0 "$rc"
check "롤백 뒤 내용 원복" a "$(cat a.txt)"
check "롤백 항목 적립" 1 "$(grep -c '^\* 롤백: a 변경 (#1)' CHANGELOG.md)"
check "릴리즈된 절 보존" 1 "$(grep -c '^\* a 변경 (#1)' CHANGELOG.md)"
git reset -q --hard

# 2. 같은 줄을 이후 커밋이 바꿈 → 내용 충돌로 멈춤
echo b2 > b.txt; git commit -qam 'feat: b 변경 (#2)'; C2=$(git rev-parse HEAD)
echo b3 > b.txt; git commit -qam 'feat: b 다시 (#3)'
./scripts/revert-issue.sh "$C2" 2 >/dev/null 2>&1; rc=$?
check "내용 충돌 → 멈춤" 1 "$rc"
check "멈춘 뒤 작업 트리 깨끗" "" "$(git status --porcelain)"

# 3. 머지 커밋 → 충돌 아닌 실패로 멈춤
git checkout -qb side && echo c > c.txt && git add c.txt && git commit -qm 'feat: c (#4)'
git checkout -q main && git merge -q --no-ff side -m 'Merge side'
./scripts/revert-issue.sh HEAD 4 >/dev/null 2>&1; rc=$?
check "머지 커밋 → 멈춤" 1 "$rc"
check "멈춘 뒤 작업 트리 깨끗" "" "$(git status --porcelain)"

exit $fail
