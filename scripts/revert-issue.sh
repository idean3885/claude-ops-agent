#!/usr/bin/env bash
# revert-issue.sh: 머지된 이슈 커밋 하나를 지금 브랜치에서 되돌린다 (ADR-0040 결정 4).
#
# Usage: ./scripts/revert-issue.sh <커밋> <이슈번호>
#
# 롤백은 방향을 거부했거나 오작동이 지금도 퍼질 때 먼저 멈추는 수단이다. 실측에서 최근 이슈 커밋
# 40개 중 23개는 체인지로그 · 버전 파일에서만 부딪혔고 11개는 이후 변경과 내용이 부딪혔다.
#   - 버전 · 체인지로그 충돌: 지금 쪽(HEAD)을 남기고 되돌린 사실을 Unreleased 에 적는다.
#     이미 릴리즈된 절은 고치지 않는다. 발행된 릴리즈 노트와 어긋나기 때문이다.
#   - 내용 충돌: 되돌리지 않고 멈춘다. 이후 변경을 함께 깨뜨리므로 롤포워드로 고친다.
# 커밋 · PR · 머지는 하지 않는다. 반영 경로는 다른 변경과 같다.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
COMMIT="${1:-}"; ISSUE="${2:-}"
[ -n "$COMMIT" ] && [ -n "$ISSUE" ] || { echo "Usage: $0 <커밋> <이슈번호>" >&2; exit 2; }
cd "$ROOT_DIR"
git diff --quiet && git diff --cached --quiet || { echo "✘ 작업 트리가 깨끗하지 않습니다" >&2; exit 2; }

META='^(CHANGELOG\.md|VERSION|\.claude-plugin/plugin\.json|\.claude-plugin/marketplace\.json)$'
SUBJECT=$(git log -1 --format=%s "$COMMIT")

if ! git revert --no-commit "$COMMIT" >/dev/null 2>&1; then
  CONFLICTS=$(git diff --name-only --diff-filter=U)
  if [ -z "$CONFLICTS" ]; then
    git revert --abort 2>/dev/null || true
    echo "✘ 충돌이 아닌 이유로 롤백하지 못했습니다(머지 커밋 · 없는 커밋 등). 이슈 커밋을 지정합니다" >&2
    exit 1
  fi
  CONTENT=$(printf '%s\n' "$CONFLICTS" | grep -Ev "$META" || true)
  if [ -n "$CONTENT" ]; then
    git revert --abort
    echo "✘ 이후 변경과 내용이 부딪혀 롤백하지 않았습니다. 롤포워드로 고칩니다:" >&2
    printf '  %s\n' $CONTENT >&2
    exit 1
  fi
  for f in $CONFLICTS; do git checkout --ours -- "$f" && git add -- "$f"; done
fi
# 원래 커밋이 Unreleased 에 적은 줄이 롤백으로 지워졌을 수 있다. 어느 쪽이든 되돌린 사실을 남긴다.
git checkout HEAD -- CHANGELOG.md VERSION .claude-plugin/plugin.json .claude-plugin/marketplace.json 2>/dev/null || true
./scripts/bump-version.sh add "롤백: ${SUBJECT#*: } (#$ISSUE)" Changed >/dev/null
git add CHANGELOG.md
echo "✔ $COMMIT 를 롤백했습니다. 커밋: git commit -m \"fix: ${SUBJECT#*: } 롤백 (#$ISSUE)\""
