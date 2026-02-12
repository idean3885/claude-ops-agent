#!/bin/bash
# claude-devex: 이슈 사이클 스킬 설치 및 업데이트
#
# 사용법:
#   신규 설치:  bash <(curl -sfL https://raw.githubusercontent.com/dykim-base-project/claude-devex/main/setup.sh)
#   버전 확인:  bash <(curl -sfL https://raw.githubusercontent.com/dykim-base-project/claude-devex/main/setup.sh) --check
#   업데이트:   bash <(curl -sfL https://raw.githubusercontent.com/dykim-base-project/claude-devex/main/setup.sh) --update
#   구독:      bash <(curl -sfL https://raw.githubusercontent.com/dykim-base-project/claude-devex/main/setup.sh) --subscribe
#
# 파일 다운로드는 GitHub API를 사용합니다 (CDN 캐싱 없음)

set -e

REPO="dykim-base-project/claude-devex"
BRANCH="main"
API_BASE="https://api.github.com/repos/${REPO}/contents"

# GitHub API를 통해 파일 다운로드 (CDN 캐싱 없음)
fetch_raw() {
  local path="$1"
  local output="$2"
  if [ -n "$output" ]; then
    curl -sfL -H "Accept: application/vnd.github.raw" "${API_BASE}/${path}?ref=${BRANCH}" -o "$output"
  else
    curl -sfL -H "Accept: application/vnd.github.raw" "${API_BASE}/${path}?ref=${BRANCH}"
  fi
}

# 원격 최신 버전 조회
get_remote_version() {
  local version
  version=$(fetch_raw "VERSION")
  if [ $? -ne 0 ] || [ -z "$version" ]; then
    echo "[오류] 원격 버전을 조회할 수 없습니다 (${API_BASE}/VERSION?ref=${BRANCH})" >&2
    echo "       네트워크 연결 또는 저장소 URL을 확인하세요." >&2
    exit 1
  fi
  echo "$version"
}

# 로컬 설치 버전 조회
get_local_version() {
  if [ -f ".claude/.devex-version" ]; then
    cat ".claude/.devex-version"
  else
    echo "미설치"
  fi
}

# 버전 기록
save_version() {
  local version="$1"
  mkdir -p ".claude"
  echo "$version" > ".claude/.devex-version"
}

# 업데이트 대상 파일 설치 (skills, README.md)
install_updatable() {
  local version="$1"

  # skills/ (항상 최신으로 업데이트)
  SKILLS="github-issue spec implement commit github-pr"
  for skill in $SKILLS; do
    mkdir -p ".claude/skills/${skill}"
    fetch_raw ".claude/skills/${skill}/SKILL.md" ".claude/skills/${skill}/SKILL.md"
    echo "[설치] .claude/skills/${skill}/SKILL.md"
  done

  # .claude/README.md (업데이트 대상)
  fetch_raw ".claude/README.md" ".claude/README.md"
  echo "[설치] .claude/README.md"

  # 버전 기록
  save_version "$version"
  echo "[기록] .claude/.devex-version → ${version}"
}

# 프로젝트 보존 파일 설치 (최초 설치 시에만)
install_preserved() {
  # .claude/settings.json (없으면 생성)
  if [ ! -f ".claude/settings.json" ]; then
    fetch_raw ".claude/settings.json" ".claude/settings.json"
    echo "[생성] .claude/settings.json"
  else
    echo "[보존] .claude/settings.json"
  fi

  # .claude/project-profile.md (없으면 생성 안내)
  if [ ! -f ".claude/project-profile.md" ]; then
    echo "[안내] .claude/project-profile.md 없음 — 프로젝트에 맞게 직접 작성하세요"
    echo "       참고: https://github.com/${REPO}#프로젝트-프로필"
  else
    echo "[보존] .claude/project-profile.md"
  fi

  # CLAUDE.md (없으면 템플릿 복사)
  if [ ! -f "CLAUDE.md" ]; then
    fetch_raw "CLAUDE.md" "CLAUDE.md"
    echo "[생성] CLAUDE.md"
  else
    echo "[보존] CLAUDE.md"
  fi

  # .gitignore 패턴 추가
  if [ -f ".gitignore" ]; then
    if ! grep -q "settings.local.json" ".gitignore" 2>/dev/null; then
      echo "" >> ".gitignore"
      echo "# Claude Code 로컬 설정" >> ".gitignore"
      echo ".claude/settings.local.json" >> ".gitignore"
      echo "[추가] .gitignore에 Claude 패턴 추가"
    else
      echo "[유지] .gitignore (패턴 이미 존재)"
    fi
  else
    echo "# Claude Code 로컬 설정" > ".gitignore"
    echo ".claude/settings.local.json" >> ".gitignore"
    echo "[생성] .gitignore"
  fi
}

# --check: 버전 비교
cmd_check() {
  local local_ver
  local remote_ver
  local_ver=$(get_local_version)
  remote_ver=$(get_remote_version)

  echo "=== claude-devex 버전 확인 ==="
  echo ""
  echo "  현재 설치: ${local_ver}"
  echo "  최신 버전: ${remote_ver}"
  echo ""

  if [ "$local_ver" = "$remote_ver" ]; then
    echo "최신 버전입니다."
  elif [ "$local_ver" = "미설치" ]; then
    echo "설치되지 않았습니다. setup.sh를 인수 없이 실행하세요."
  else
    echo "업데이트가 가능합니다. --update 옵션으로 업데이트하세요."
  fi
}

# --update: 업데이트 대상만 갱신
cmd_update() {
  local local_ver
  local remote_ver
  local_ver=$(get_local_version)
  remote_ver=$(get_remote_version)

  echo "=== claude-devex 업데이트 ==="
  echo ""
  echo "  ${local_ver} → ${remote_ver}"
  echo ""

  if [ "$local_ver" = "$remote_ver" ]; then
    echo "이미 최신 버전입니다."
    return 0
  fi

  # 업데이트 대상만 설치 (프로젝트 파일 보존)
  install_updatable "$remote_ver"

  echo ""
  echo "=== 업데이트 완료 ==="
  echo ""
  echo "업데이트 내역: https://github.com/${REPO}/blob/main/CHANGELOG.md"
  echo ""
  echo "보존된 파일:"
  echo "  .claude/project-profile.md  (프로젝트 고유)"
  echo "  .claude/settings.json       (프로젝트 설정)"
  echo "  CLAUDE.md                   (프로젝트 규칙)"
}

# 기본: 신규 설치
cmd_install() {
  local remote_ver
  remote_ver=$(get_remote_version)

  echo "=== claude-devex 이슈 사이클 설치 (v${remote_ver}) ==="
  echo ""

  install_updatable "$remote_ver"
  install_preserved

  echo ""
  echo "=== 설치 완료 (v${remote_ver}) ==="
  echo ""
  echo "사용법:"
  echo "  /github-issue  - GitHub 이슈 생성"
  echo "  /spec          - 명세(설계) 작성"
  echo "  /implement     - 코드 구현"
  echo "  /commit        - 변경사항 리뷰 및 커밋"
  echo "  /github-pr     - PR 생성"
  echo ""
  echo "상세 가이드: .claude/README.md"
  echo "버전 확인:   curl -sL .../setup.sh | bash -s -- --check"
  echo "업데이트:    curl -sL .../setup.sh | bash -s -- --update"
}

# --subscribe: 자동 업데이트 워크플로우 설치
cmd_subscribe() {
  echo "=== claude-devex 자동 업데이트 구독 ==="
  echo ""

  mkdir -p ".github/workflows"

  if [ -f ".github/workflows/claude-devex-update.yml" ]; then
    echo "[덮어쓰기] .github/workflows/claude-devex-update.yml"
  else
    echo "[설치] .github/workflows/claude-devex-update.yml"
  fi

  if ! fetch_raw ".github/workflows/claude-devex-update.yml" ".github/workflows/claude-devex-update.yml"; then
    echo "[오류] 워크플로우 파일을 다운로드할 수 없습니다." >&2
    exit 1
  fi

  echo ""
  echo "=== 구독 설정 완료 ==="
  echo ""
  echo "자동 업데이트:"
  echo "  스케줄: 매일 09:00 KST 자동 확인"
  echo "  수동:   GitHub Actions 탭 → claude-devex 자동 업데이트 확인 → Run workflow"
  echo ""
  echo "업데이트 감지 시 PR이 자동 생성됩니다."
}

# 메인: 인수에 따라 분기
case "${1:-}" in
  --check)
    cmd_check
    ;;
  --update)
    cmd_update
    ;;
  --subscribe)
    cmd_subscribe
    ;;
  *)
    cmd_install
    ;;
esac
