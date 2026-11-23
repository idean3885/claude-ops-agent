#!/usr/bin/env bash
# 실험 기록 레포를 만든다. 공개 · 기본 브랜치 하나 · 머지된 head 브랜치 자동 삭제. 브랜치 보호 규칙은 두지 않는다.
# 이미 있는 레포면 만들지 않고 설정만 맞춘다(GitHub 은 이 설정의 조직 기본값이 없어 레포마다 켠다).
# 사용: lab-repo-create.sh <owner/name> ["설명"] [--dry-run]
set -euo pipefail
repo=${1:?사용: lab-repo-create.sh <owner/name> [\"설명\"] [--dry-run]}
desc=${2:-}
dry=0; for a in "$@"; do [ "$a" = --dry-run ] && dry=1; done
[ "$desc" = --dry-run ] && desc=""
run() { if [ $dry = 1 ]; then printf '%q ' "$@"; echo; else "$@"; fi; }

if [ $dry = 0 ] && gh repo view "$repo" >/dev/null 2>&1; then
  echo "exists: $repo (설정만 맞춘다)"
else
  run gh repo create "$repo" --public --add-readme --description "$desc"
fi
run gh api -X PATCH "repos/$repo" -F delete_branch_on_merge=true --silent
[ $dry = 1 ] && exit 0
gh api "repos/$repo" -q '"\(.full_name) default=\(.default_branch) delete_branch_on_merge=\(.delete_branch_on_merge)"'
