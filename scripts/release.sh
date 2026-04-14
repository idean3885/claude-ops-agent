#!/usr/bin/env bash
# release.sh — devex 플러그인 원자 릴리스
# 버전 범프 → 커밋 → 푸시 → 마켓플레이스 업데이트 → 로컬 캐시 git 복원 → 검증
#
# Usage: ./scripts/release.sh <patch|minor|major> ["변경 설명"]
# Example: ./scripts/release.sh patch "브랜치 분기 시 origin/{base} 강제"
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGIN_NAME="devex@claude-devex"

# --- 인자 파싱 ---
if [ $# -lt 1 ]; then
  echo "Usage: $0 <patch|minor|major> [\"변경 설명\"]"
  exit 1
fi

BUMP_TYPE="$1"
MESSAGE="${2:-chore: version bump}"

# --- 현재 버전 읽기 ---
CURRENT_VERSION=$(cat "$ROOT_DIR/VERSION")
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"

case "$BUMP_TYPE" in
  patch) PATCH=$((PATCH + 1)) ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  *) echo "Invalid bump type: $BUMP_TYPE (patch|minor|major)"; exit 1 ;;
esac

NEW_VERSION="$MAJOR.$MINOR.$PATCH"
echo "📦 $CURRENT_VERSION → $NEW_VERSION"

# --- Step 1: 버전 범프 ---
bash "$SCRIPT_DIR/bump-version.sh" "$NEW_VERSION" "$MESSAGE"

# --- Step 2: 커밋 + 푸시 ---
cd "$ROOT_DIR"
if [ ! -d .git ]; then
  echo "⚠ .git 없음 — git init"
  git init --quiet
  git remote add origin git@github.com:dongyoung-kim/claude-devex.git 2>/dev/null || true
  git add -A
  git commit -m "init: sync before release $NEW_VERSION" --quiet
fi

git add -A
git commit -m "$(cat <<EOF
release: $NEW_VERSION — $MESSAGE

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)" --quiet 2>/dev/null || echo "ℹ 변경 없음 — 커밋 스킵"

git push origin main 2>&1 || { echo "✘ 푸시 실패"; exit 1; }
echo "✔ 푸시 완료"

# --- Step 3: 마켓플레이스 업데이트 ---
claude plugins update "$PLUGIN_NAME" 2>&1 || { echo "✘ 마켓플레이스 업데이트 실패"; exit 1; }
echo "✔ 마켓플레이스 업데이트 완료"

# --- Step 4: 새 캐시 디렉토리 git 복원 ---
CACHE_BASE="$(dirname "$ROOT_DIR")"
NEW_CACHE="$CACHE_BASE/$NEW_VERSION"

if [ -d "$NEW_CACHE" ] && [ ! -d "$NEW_CACHE/.git" ]; then
  cd "$NEW_CACHE"
  git init --quiet
  git remote add origin git@github.com:dongyoung-kim/claude-devex.git 2>/dev/null || true
  git add -A
  git commit -m "init: sync from marketplace $NEW_VERSION" --quiet
  echo "✔ 캐시 git 복원 ($NEW_VERSION)"
fi

# --- Step 5: 검증 ---
INSTALLED_VERSION=$(cat "$NEW_CACHE/VERSION" 2>/dev/null || echo "MISSING")
if [ "$INSTALLED_VERSION" = "$NEW_VERSION" ]; then
  echo "✅ 릴리스 완료: devex $NEW_VERSION"
else
  echo "✘ 버전 불일치 — 설치: $INSTALLED_VERSION, 기대: $NEW_VERSION"
  exit 1
fi
