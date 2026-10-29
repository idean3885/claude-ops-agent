#!/bin/bash
# gh-issue.sh — flow `/issue create` · `/issue start` 의 github provider 어댑터.
#
# Why: 이슈 작성 규칙(ISS5 · L7 · ADR-0027 대조 줄)은 있는데 생성 경로(`gh issue create` 직접 호출)에
# 묶이지 않아 실행되지 않았다. 생성 · 시작을 이 스크립트 하나로 모으고, 직접 호출은 훅이 거부한다 (#696).
# 어댑터 계약(필수 판단 · 종료 코드 · 출력 형식)은 providers/PROVIDER.md 에 있다.
#
# 사용법:
#   gh-issue.sh create --title "<제목>" --body-file <본문.md> --type <feat|fix|docs|refactor|chore>
#                      (--start | --no-start "<사유>")
#                      [-R <owner/repo | host/owner/repo>] [--structure <iss1|iss5|iss6|iss7>]
#                      [--worktree | --checkout] [--base <브랜치>] [--branch <이름>]
#   gh-issue.sh start <번호> [--type <타입>] [-R <레포>] [--worktree | --checkout] [--base <브랜치>] [--branch <이름>]
#
#   --type       라벨 · 브랜치 접두. 생성 시 라벨이 없으면 만든다 (providers/github.md 라벨 매핑)
#   --structure  본문 구조. 기본값은 fix → iss1, 그 외 → iss5 (extensions/issue.md 「필수 구조」 절)
#   --start      생성 직후 start 로 담당자 · 시작 코멘트 · (코드 작업이면) 브랜치
#   --no-start   지금 착수하지 않는 이슈(백로그 · 후속). 사유를 출력에 남긴다
#   --worktree   `../{프로젝트}-{타입}-{번호}` 워크트리를 이슈에 연결된 브랜치로 연다 (권장)
#   --checkout   현재 작업 트리에서 이슈에 연결된 브랜치로 직접 체크아웃
#                브랜치는 `gh issue develop` 이 `origin/{base}` 에서 원격에 만든다. 이슈에서 만든 브랜치라
#                그 브랜치의 PR 이 이슈에 자동 연결되고, 기본 브랜치에 머지되면 이슈가 닫힌다 (#813)
#   --branch     브랜치 이름. 기본 `{타입}/{번호}`. 리모트 머지 이력의 접두가 provider 패턴과 다를 때 넘긴다
#
# 종료 코드: 0 성공, 1 인자 · 본문 검사 실패(생성 안 됨), 2 gh · git 오류, 3 생성됐으나 시작 실패
# 출력: JSON 한 줄. 성공은 stdout, 오류는 stderr. status · number · start(started|skipped|failed) · reason

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
TYPES="feat fix docs refactor chore"

label_color() {
  case "$1" in
    feat) echo 0E8A16;; fix) echo d73a4a;; docs) echo 0075ca;; refactor) echo e4e669;; chore) echo ededed;;
  esac
}

is_type() {
  case " $TYPES " in *" $1 "*) return 0;; *) return 1;; esac
}

err_json() { # <종료 코드> <message> [k=v ...]
  local code="$1"; shift
  python3 -c '
import json, sys
d = {"status": "error", "message": sys.argv[1]}
for kv in sys.argv[2:]:
    k, v = kv.split("=", 1); d[k] = v
print(json.dumps(d, ensure_ascii=False))' "$@" >&2
  exit "$code"
}

ok_json() { # k=v ...
  python3 -c '
import json, sys
d = {"status": "ok"}
for kv in sys.argv[1:]:
    k, v = kv.split("=", 1); d[k] = v
print(json.dumps(d, ensure_ascii=False))' "$@"
}

# ─── start ───
cmd_start() {
  local NUMBER="" TYPE="" REPO="" BASE="main" BRANCH="" MODE=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --type) TYPE="${2:-}"; shift 2;;
      -R|--repo) REPO="${2:-}"; shift 2;;
      --base) BASE="${2:-}"; shift 2;;
      --branch) BRANCH="${2:-}"; shift 2;;
      --worktree) MODE=worktree; shift;;
      --checkout) MODE=checkout; shift;;
      -*) err_json 1 "모르는 인자: $1";;
      *) [ -z "$NUMBER" ] && NUMBER="$1" || err_json 1 "번호는 하나: $1"; shift;;
    esac
  done
  [[ "$NUMBER" =~ ^[0-9]+$ ]] || err_json 1 "이슈 번호 필수 (숫자)"
  local R=()
  [ -n "$REPO" ] && R=(-R "$REPO")

  if [ -z "$TYPE" ]; then
    # 타입은 라벨에서 읽는다. 타입 라벨 5종 중 하나여야 한다. priority/* 같은 다른 라벨은 세지 않는다.
    local labels found=() l
    labels=$(gh issue view "$NUMBER" ${R[@]+"${R[@]}"} --json labels --jq '.labels[].name' 2>/dev/null) \
      || err_json 2 "이슈 조회 실패: $NUMBER" number="$NUMBER"
    for l in $labels; do is_type "$l" && found+=("$l"); done
    [ "${#found[@]}" -eq 1 ] || err_json 1 "타입 라벨이 ${#found[@]}개 (${found[*]:-없음}). --type 으로 지정" number="$NUMBER"
    TYPE="${found[0]}"
  fi
  is_type "$TYPE" || err_json 1 "타입은 $TYPES 중 하나: $TYPE"

  gh issue edit "$NUMBER" ${R[@]+"${R[@]}"} --add-assignee @me >/dev/null \
    || err_json 2 "담당자 설정 실패" number="$NUMBER"
  local STARTED
  STARTED="$(date '+%Y-%m-%d %H:%M')"
  gh issue comment "$NUMBER" ${R[@]+"${R[@]}"} --body "작업 시작: $STARTED" >/dev/null \
    || err_json 2 "시작 코멘트 실패" number="$NUMBER"

  [ -z "$BRANCH" ] && BRANCH="$TYPE/$NUMBER"
  local out=(number="$NUMBER" type="$TYPE" started="$STARTED")
  if [ -n "$MODE" ]; then
    local PROJECT
    PROJECT="$(basename "$(git rev-parse --show-toplevel)")" || err_json 2 "git 레포가 아니다" number="$NUMBER"
    # why: 로컬에서 만든 브랜치는 이슈와 이어지지 않는다. 이슈에서 만든 브랜치만 PR 이 이슈에 자동 연결된다
    gh issue develop "$NUMBER" ${R[@]+"${R[@]}"} --name "$BRANCH" --base "$BASE" >/dev/null \
      || err_json 2 "이슈 연결 브랜치 생성 실패: $BRANCH" number="$NUMBER" branch="$BRANCH"
    git fetch origin >/dev/null 2>&1 || err_json 2 "git fetch origin 실패" number="$NUMBER"
    if [ "$MODE" = worktree ]; then
      local WT="../${PROJECT}-${TYPE}-${NUMBER}"
      git worktree add "$WT" -b "$BRANCH" --track "origin/$BRANCH" >/dev/null \
        || err_json 2 "git worktree add 실패: $WT" number="$NUMBER" branch="$BRANCH"
      out+=(branch="$BRANCH" worktree="$WT")
    else
      git checkout -b "$BRANCH" --track "origin/$BRANCH" >/dev/null \
        || err_json 2 "git checkout -b 실패: $BRANCH" number="$NUMBER" branch="$BRANCH"
      out+=(branch="$BRANCH")
    fi
  fi
  ok_json "${out[@]}"
}

# ─── create ───
cmd_create() {
  local TITLE="" BODY="" TYPE="" REPO="" STRUCTURE="" START="" NO_START_REASON="" START_ARGS=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --title) TITLE="${2:-}"; shift 2;;
      --body-file) BODY="${2:-}"; shift 2;;
      --type) TYPE="${2:-}"; shift 2;;
      -R|--repo) REPO="${2:-}"; shift 2;;
      --structure) STRUCTURE="${2:-}"; shift 2;;
      --start) START=1; shift;;
      --no-start) NO_START_REASON="${2:-}"; shift 2 || shift;;
      --worktree|--checkout) START_ARGS+=("$1"); shift;;
      --base|--branch) START_ARGS+=("$1" "${2:-}"); shift 2;;
      *) err_json 1 "모르는 인자: $1";;
    esac
  done
  [ -n "$TITLE" ] || err_json 1 "--title 필수"
  [ -n "$BODY" ] && [ -s "$BODY" ] || err_json 1 "--body-file 필수 (비어 있지 않은 파일)"
  is_type "$TYPE" || err_json 1 "--type 은 $TYPES 중 하나"
  if [ -n "$START" ] && [ -n "$NO_START_REASON" ]; then err_json 1 "--start 와 --no-start 는 함께 쓸 수 없다"; fi
  if [ -z "$START" ] && [ -z "$NO_START_REASON" ]; then
    err_json 1 '시작 결정 필수: --start 또는 --no-start "<사유>". 지금 손대는 이슈면 --start, 백로그 · 후속이면 사유를 적는다'
  fi
  if [ -z "$START" ] && [ "${#START_ARGS[@]}" -gt 0 ]; then err_json 1 "--worktree · --checkout · --base · --branch 는 --start 와 함께만 쓴다"; fi
  if [ -z "$STRUCTURE" ]; then
    [ "$TYPE" = fix ] && STRUCTURE=iss1 || STRUCTURE=iss5
  fi

  # 본문 구조 검사. 실패하면 생성하지 않는다.
  local CHECK
  if ! CHECK=$(node "$SCRIPT_DIR/issue-body-rules.mjs" --structure "$STRUCTURE" < "$BODY"); then
    python3 -c '
import json, sys
d = json.loads(sys.argv[1]); d["status"] = "error"; d["step"] = "body-check"
d["message"] = "본문 검사 실패. 생성하지 않았다. 규칙: config/style-rules/extensions/issue.md"
print(json.dumps(d, ensure_ascii=False))' "$CHECK" >&2
    exit 1
  fi

  local R=()
  [ -n "$REPO" ] && R=(-R "$REPO")

  # 라벨 보장 (providers/github.md 라벨 자동 생성). -R 이 있으면 라벨 명령에도 같은 레포.
  if ! gh label list ${R[@]+"${R[@]}"} --json name --jq '.[].name' 2>/dev/null | grep -qx "$TYPE"; then
    gh label create "$TYPE" ${R[@]+"${R[@]}"} --color "$(label_color "$TYPE")" >/dev/null \
      || err_json 2 "라벨 생성 실패: $TYPE"
  fi

  local URL NUMBER
  URL=$(gh issue create ${R[@]+"${R[@]}"} --title "$TITLE" --body-file "$BODY" --label "$TYPE") \
    || err_json 2 "이슈 생성 실패"
  NUMBER="${URL##*/}"
  [[ "$NUMBER" =~ ^[0-9]+$ ]] || err_json 2 "생성 응답에서 번호를 읽지 못했다: $URL"

  if [ -n "$NO_START_REASON" ]; then
    ok_json number="$NUMBER" url="$URL" start=skipped reason="$NO_START_REASON"
    return 0
  fi

  local START_OUT START_RC
  set +e
  START_OUT=$(cmd_start "$NUMBER" --type "$TYPE" ${R[@]+"${R[@]}"} ${START_ARGS[@]+"${START_ARGS[@]}"})
  START_RC=$?
  set -e
  if [ "$START_RC" -ne 0 ]; then
    err_json 3 "생성됨, 시작 실패. gh-issue.sh start $NUMBER 로 다시" number="$NUMBER" url="$URL" start=failed step=start
  fi
  python3 -c '
import json, sys
d = json.loads(sys.argv[1]); d["url"] = sys.argv[2]; d["start"] = "started"
print(json.dumps(d, ensure_ascii=False))' "$START_OUT" "$URL"
}

case "${1:-}" in
  create) shift; cmd_create "$@";;
  start) shift; cmd_start "$@";;
  *) err_json 1 "사용법: gh-issue.sh create|start … (머리 주석 참조)";;
esac
