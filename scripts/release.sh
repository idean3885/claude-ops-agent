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
REMOTE_URL="${DEVEX_REMOTE_URL:-https://github.com/idean3885/claude-devex.git}"

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
  git remote add origin "$REMOTE_URL" 2>/dev/null || true
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
# PLUGIN_NAME = "{plugin}@{marketplace}" → ~/.claude/plugins/cache/{marketplace}/{plugin}/{version}/
# release.sh를 cache 외부(임시 클론 등)에서 호출해도 실제 마켓플레이스 cache 경로를 정확히 찾도록
# ROOT_DIR 상대 경로 대신 명시 경로를 사용한다.
PLUGIN_PART="${PLUGIN_NAME%%@*}"
MARKETPLACE_PART="${PLUGIN_NAME##*@}"
CACHE_BASE="$HOME/.claude/plugins/cache/$MARKETPLACE_PART/$PLUGIN_PART"
NEW_CACHE="$CACHE_BASE/$NEW_VERSION"

if [ -d "$NEW_CACHE" ] && [ ! -d "$NEW_CACHE/.git" ]; then
  cd "$NEW_CACHE"
  git init --quiet
  git remote add origin "$REMOTE_URL" 2>/dev/null || true
  git add -A
  git commit -m "init: sync from marketplace $NEW_VERSION" --quiet
  echo "✔ 캐시 git 복원 ($NEW_VERSION)"
fi

# --- Step 4b: 옛 버전 디렉토리를 신버전 심볼릭 링크로 교체 ---
# 활성 세션의 PreToolUse / SessionStart hook 은 시작 시점에 결정된 plugin root 경로 (옛 버전) 를 계속 호출한다.
# 옛 디렉토리를 그대로 삭제하면 활성 세션에서 hook 이 ENOENT 로 실패하므로, 신버전 디렉토리를 가리키는
# 심볼릭 링크로 교체한다. 다음 hook 호출이 자동으로 신버전 코드를 해소하여 사용자 측 reload 가 필요 없다.
# (관련 회귀: 활성 세션 중 release 직후 'Plugin directory does not exist' 에러.)
if [ -d "$CACHE_BASE" ]; then
  for OLD_DIR in "$CACHE_BASE"/*/; do
    [ -d "$OLD_DIR" ] || continue
    OLD_NAME=$(basename "$OLD_DIR")
    [ "$OLD_NAME" = "$NEW_VERSION" ] && continue
    # 이미 심볼릭이면 신버전을 가리키도록 갱신, 일반 디렉토리면 제거 후 심볼릭으로 교체
    if [ -L "$CACHE_BASE/$OLD_NAME" ]; then
      ln -sfn "$NEW_VERSION" "$CACHE_BASE/$OLD_NAME"
    else
      rm -rf "$CACHE_BASE/$OLD_NAME"
      ln -s "$NEW_VERSION" "$CACHE_BASE/$OLD_NAME"
    fi
    echo "✔ 옛 버전 보존: $OLD_NAME → $NEW_VERSION (활성 세션 hook 경로 유지)"
  done
fi

# --- Step 5: 검증 ---
INSTALLED_VERSION=$(cat "$NEW_CACHE/VERSION" 2>/dev/null || echo "MISSING")
if [ "$INSTALLED_VERSION" = "$NEW_VERSION" ]; then
  echo "✅ 릴리스 완료: devex $NEW_VERSION"
else
  echo "✘ 버전 불일치 — 설치: $INSTALLED_VERSION, 기대: $NEW_VERSION"
  exit 1
fi
