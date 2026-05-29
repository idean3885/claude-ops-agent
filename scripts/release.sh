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

# --- 캐시 경로 + update 전 기존 버전 캡처 ---
# PLUGIN_NAME = "{plugin}@{marketplace}" → ~/.claude/plugins/cache/{marketplace}/{plugin}/{version}/
# release.sh를 cache 외부(임시 클론 등)에서 호출해도 실제 cache 경로를 정확히 찾도록 명시 경로를 쓴다.
PLUGIN_PART="${PLUGIN_NAME%%@*}"
MARKETPLACE_PART="${PLUGIN_NAME##*@}"
CACHE_BASE="$HOME/.claude/plugins/cache/$MARKETPLACE_PART/$PLUGIN_PART"
# `claude plugins update` 는 옛 버전 캐시 디렉토리를 제거한다. update 후에 "남은 디렉토리"를 순회하면
# 복원 대상이 이미 사라진 뒤다. 활성 세션 hook 경로를 복원하려면 update 직전의 버전 목록을 먼저 기록한다.
BEFORE_VERSIONS=""
[ -d "$CACHE_BASE" ] && BEFORE_VERSIONS=$(ls -1 "$CACHE_BASE" 2>/dev/null || true)

# --- Step 3: 마켓플레이스 업데이트 ---
claude plugins update "$PLUGIN_NAME" 2>&1 || { echo "✘ 마켓플레이스 업데이트 실패"; exit 1; }
echo "✔ 마켓플레이스 업데이트 완료"

# --- Step 4: 새 캐시 디렉토리 git 복원 ---
NEW_CACHE="$CACHE_BASE/$NEW_VERSION"

if [ -d "$NEW_CACHE" ] && [ ! -d "$NEW_CACHE/.git" ]; then
  cd "$NEW_CACHE"
  git init --quiet
  git remote add origin "$REMOTE_URL" 2>/dev/null || true
  git add -A
  git commit -m "init: sync from marketplace $NEW_VERSION" --quiet
  echo "✔ 캐시 git 복원 ($NEW_VERSION)"
fi

# --- Step 4b: update 가 제거한 옛 버전 경로를 신버전 심볼릭으로 복원 ---
# 활성 세션의 PreToolUse / SessionStart hook 은 시작 시점에 결정된 plugin root 경로(옛 버전)를 계속 호출한다.
# update 가 옛 버전 디렉토리를 제거하면 그 경로가 ENOENT 가 되어 활성 세션 hook 이 실패한다.
# 그래서 update 직전 캡처한 BEFORE_VERSIONS 를 기준으로, 사라진 옛 버전 이름마다 신버전을 가리키는
# 심볼릭을 만들어 활성 세션 hook 경로를 유지한다. 다음 hook 호출이 신버전 코드를 해소하므로 reload 가 필요 없다.
# (관련 회귀: 활성 세션 중 release 직후 'Plugin directory does not exist' 에러.)
RESTORED=0
for OLD_NAME in $BEFORE_VERSIONS; do
  [ "$OLD_NAME" = "$NEW_VERSION" ] && continue
  TARGET="$CACHE_BASE/$OLD_NAME"
  # update 가 옛 버전을 실제 디렉토리로 그대로 남겨 두었다면(누적형) 건드리지 않는다.
  [ -e "$TARGET" ] && [ ! -L "$TARGET" ] && continue
  ln -sfn "$NEW_VERSION" "$TARGET"
  echo "✔ 옛 버전 경로 복원: $OLD_NAME → $NEW_VERSION (활성 세션 hook 유지)"
  RESTORED=$((RESTORED + 1))
done
[ "$RESTORED" -eq 0 ] && echo "ℹ 복원할 옛 버전 경로 없음"

# --- Step 5: 검증 ---
INSTALLED_VERSION=$(cat "$NEW_CACHE/VERSION" 2>/dev/null || echo "MISSING")
if [ "$INSTALLED_VERSION" = "$NEW_VERSION" ]; then
  echo "✅ 릴리스 완료: devex $NEW_VERSION"
else
  echo "✘ 버전 불일치 — 설치: $INSTALLED_VERSION, 기대: $NEW_VERSION"
  exit 1
fi
