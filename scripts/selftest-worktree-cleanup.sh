#!/bin/bash
# selftest-worktree-cleanup.sh — worktree-cleanup.sh 티켓 정리의 안전장치를 실제 git 으로 점검한다.
#
# Why: 정리 스크립트는 --force 와 rmtree 로 지운다. 지우지 말아야 할 것을 지우는 결함은
# 실행해야만 드러나고, 드러난 뒤에는 복구할 수 없다 (#818).
#
# 케이스
#   1. 커밋하지 않은 변경이 있으면 아무것도 지우지 않고 dirty 로 끝난다 (종료 코드 3)
#   2. 깨끗하면 워크트리와 bare clone 을 지운다
#   3. 정규 clone(메인 레포)은 지우지 않고 main_repo_preserved 로 남긴다
#   4. bare clone 에 쓰기 금지 파일이 있어도 권한을 주고 다시 지운다
#   5. 다른 티켓이 같은 bare clone 을 쓰면 그 clone 과 워크트리를 남기고 ok 로 끝난다
#   6. --sweep-stale 이 심볼릭 링크 경로에서도 고아 bare clone 을 찾는다
#   7. 재시도 뒤에도 남으면 failed 와 status error 로 보고한다 (chflags 가 있는 플랫폼만)
#   모든 프로젝트는 심볼릭 링크($ROOT)를 거쳐 실행한다. 경로 비교 결함은 링크 경로에서만 드러난다
#
# 사용: bash scripts/selftest-worktree-cleanup.sh

set -uo pipefail
SCRIPT="$(cd "$(dirname "$0")" && pwd)/worktree-cleanup.sh"
TMP="$(mktemp -d)"
mkdir "$TMP/real" && ln -s "$TMP/real" "$TMP/link"
ROOT="$TMP/link"
trap 'chflags -R nouchg "$TMP" 2>/dev/null; chmod -R u+w "$TMP" 2>/dev/null; rm -rf "$TMP"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
fail=0

seed() { # 커밋 하나짜리 원본 레포
  git init -q "$TMP/seed" && echo a >"$TMP/seed/a" && git -C "$TMP/seed" add a && git -C "$TMP/seed" commit -qm init
}

project() { # <이름> <bare|normal> — 프로젝트 · clone · 워크트리 · state 를 만들고 state 경로를 출력한다
  local p="$ROOT/$1" kind="$2"
  mkdir -p "$p/.ops-agent/state" && echo '{}' >"$p/.ops-agent/project.json"
  if [ "$kind" = bare ]; then
    git clone -q --bare "$TMP/seed" "$p/repo.git"
    git -C "$p/repo.git" worktree add -q -b feat/1 "$p/worktrees/repo/feat-1" 2>/dev/null
  else
    git clone -q "$TMP/seed" "$p/repo"
    git -C "$p/repo" worktree add -q -b feat/1 "$p/worktrees/repo/feat-1" 2>/dev/null
  fi
  printf '{"ticket":"1","repos":{"repo":{"branch":"feat/1","worktree":"worktrees/repo/feat-1"}}}' >"$p/.ops-agent/state/org-flow-1.json"
  echo "$p/.ops-agent/state/org-flow-1.json"
}

check() { # <이름> <조건 결과 0|1>
  if [ "$2" = 0 ]; then echo "  OK  $1"; else echo "  XX  $1"; fail=$((fail + 1)); fi
}

seed

# 1. dirty
st=$(project dirty bare); p="$ROOT/dirty"
echo x >"$p/worktrees/repo/feat-1/untracked.txt"
out=$(cd "$p" && bash "$SCRIPT" "$st"); code=$?
[ "$code" = 3 ] && grep -q '"status": "dirty"' <<<"$out"; check "dirty 면 종료 코드 3 · status dirty" $?
[ -f "$p/worktrees/repo/feat-1/untracked.txt" ] && [ -d "$p/repo.git" ] && [ -f "$st" ]; check "dirty 면 워크트리 · bare clone · state 를 지우지 않는다" $?

# 2. 깨끗한 bare
st=$(project clean bare); p="$ROOT/clean"
out=$(cd "$p" && bash "$SCRIPT" "$st"); code=$?
[ "$code" = 0 ] && [ ! -d "$p/worktrees/repo/feat-1" ] && [ ! -d "$p/repo.git" ]; check "깨끗하면 워크트리와 bare clone 을 지운다" $?

# 3. 정규 clone
st=$(project normal normal); p="$ROOT/normal"
out=$(cd "$p" && bash "$SCRIPT" "$st"); code=$?
[ -d "$p/repo/.git" ] && grep -q main_repo_preserved <<<"$out"; check "정규 clone 은 지우지 않는다" $?

# 4. 쓰기 금지된 bare clone
st=$(project readonly bare); p="$ROOT/readonly"
chmod -R a-w "$p/repo.git/objects"
out=$(cd "$p" && bash "$SCRIPT" "$st"); code=$?
[ "$code" = 0 ] && [ ! -d "$p/repo.git" ]; check "쓰기 금지 파일이 있어도 bare clone 을 지운다" $?

# 5. 두 티켓이 같은 bare clone 을 쓴다
st=$(project shared bare); p="$ROOT/shared"
git -C "$p/repo.git" worktree add -q -b feat/2 "$p/worktrees/repo/feat-2" 2>/dev/null
out=$(cd "$p" && bash "$SCRIPT" "$st"); code=$?
[ "$code" = 0 ] && [ -d "$p/repo.git" ] && [ -d "$p/worktrees/repo/feat-2" ] && grep -q clone_kept <<<"$out"; check "다른 티켓이 쓰는 bare clone 은 남기고 ok 로 끝난다" $?

# 6. sweep 이 고아 bare clone 을 찾는다
p="$ROOT/sweep"; mkdir -p "$p/.ops-agent/state" && echo '{}' >"$p/.ops-agent/project.json"
git clone -q --bare "$TMP/seed" "$p/orphan.git"
out=$(cd "$p" && bash "$SCRIPT" --sweep-stale)
grep -q '"orphan"' <<<"$out"; check "sweep 이 고아 bare clone 을 찾는다" $?

# 7. 재시도 뒤에도 남는 bare clone
if command -v chflags >/dev/null; then
  st=$(project locked bare); p="$ROOT/locked"
  chflags uchg "$p/repo.git/HEAD"
  out=$(cd "$p" && bash "$SCRIPT" "$st"); code=$?
  [ "$code" = 1 ] && grep -q '"status": "error"' <<<"$out" && grep -q '권한 재시도 후에도 남음' <<<"$out"; check "재시도 뒤에도 남으면 failed · status error 로 보고한다" $?
else
  echo "  --  재시도 뒤 잔존 보고 (chflags 없음, 건너뜀)"
fi

[ "$fail" = 0 ] && echo "전부 통과" || { echo "실패 ${fail}건"; exit 1; }
