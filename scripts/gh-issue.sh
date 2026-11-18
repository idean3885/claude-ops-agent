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
#                      [-R <owner/repo | host/owner/repo>] [--structure <iss1|iss5|iss6|iss7|iss10>]
#                      (-R 이 owner/repo 뿐이면 현재 레포 원격 중 같은 레포의 호스트를 붙인다)
#                      [--worktree | --checkout] [--base <브랜치>] [--branch <이름>]
#   gh-issue.sh start <번호> [--type <타입>] [-R <레포>] [--worktree | --checkout] [--base <브랜치>] [--branch <이름>]
#
#   --type       라벨 · 브랜치 접두. 생성 시 라벨이 없으면 만든다 (providers/github.md 라벨 매핑)
#   --structure  본문 구조. 기본값은 fix → iss1, 그 외 → iss5 (extensions/issue.md 「필수 구조」 절)
#   --start      생성 직후 start 로 담당자 · 시작 코멘트 · (코드 작업이면) 브랜치
#   --no-start   지금 착수하지 않는 이슈(백로그 · 후속). 사유를 출력에 남긴다
#   --worktree   `../{프로젝트}-{타입}-{번호}` 워크트리를 이슈에 연결된 브랜치로 연다 (가이드 기본값. 플래그를 생략하면 브랜치를 만들지 않는다)
#   --checkout   현재 작업 트리에서 이슈에 연결된 브랜치로 직접 체크아웃
#                브랜치는 `gh issue develop` 이 `origin/{base}` 에서 원격에 만든다. 이슈에서 만든 브랜치라
#                그 브랜치의 PR 이 이슈에 자동 연결되고, 기본 브랜치에 머지되면 이슈가 닫힌다 (#813)
#   --branch     브랜치 이름. 기본 `{타입}/{번호}`. 리모트 머지 이력의 접두가 provider 패턴과 다를 때 넘긴다.
#                원격에 이미 있는 브랜치(세션 묶음)면 이슈 연결 브랜치를 만들지 않고 그 브랜치를 열며 bundled=true 를 낸다
#
# 세션 인덱스: 생성 · 시작이 성공하면 ~/.claude/ops-agent/.cache/session-issues/<세션 번호>.jsonl 에
#   한 줄(repo · number · title · action)을 더한다. 세션 마무리 훅이 이 파일로 대상 이슈를 확정하고 지운다 (#1050).
#   세션 번호는 CLAUDE_CODE_SESSION_ID 다. 없으면 쓰지 않는다(마무리는 대화에서 대상을 모은다). 쓰기 실패는 결과를 바꾸지 않는다.
#
# 종료 코드: 0 성공, 1 인자 · 본문 검사 · 한자 섞임 검사 실패(생성 안 됨), 2 gh · git 오류, 3 생성됐으나 시작 실패
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

# 세션 인덱스에 한 줄을 더한다. 실패해도 조용히 넘어간다 (어댑터 결과를 바꾸지 않는다).
index_line() { # <action> <number> <title> <url>
  local sid="${CLAUDE_CODE_SESSION_ID:-}"
  sid="${sid//[^A-Za-z0-9_-]/}"
  [ -n "$sid" ] || return 0
  local dir="$HOME/.claude/ops-agent/.cache/session-issues"
  mkdir -p "$dir" 2>/dev/null || return 0
  python3 -c '
import json, sys, datetime
action, number, title, url = sys.argv[1:5]
# why: github.com 은 owner/repo, 그 밖의 호스트는 host/owner/repo 로 적어 -R 값과 같은 모양을 쓴다
path = url.split("://", 1)[-1].split("/issues/")[0]
host, _, rest = path.partition("/")
repo = rest if host == "github.com" else path
print(json.dumps({"ts": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                  "repo": repo, "number": number, "title": title, "action": action}, ensure_ascii=False))
' "$1" "$2" "$3" "$4" >>"$dir/$sid.jsonl" 2>/dev/null || true
}

# -R 이 owner/name 뿐이면 현재 레포의 원격 중 같은 owner/name 을 가리키는 것의 호스트를 붙인다 (#1098).
# why: owner/name 만 받은 gh 명령은 현재 레포의 원격이 아니라 기본 호스트(github.com)로 간다. 엔터프라이즈 레포면
#      라벨 조회가 공개 GitHub 로 새 404 로 멈춘다. 호스트 환경 변수를 셸 전체에 내보내면 대외비 가드가 그 셸의
#      호출을 공개 표면으로 판정하므로, 호출 인자(host/owner/name)로만 넘긴다.
# 맞는 원격이 없거나 github.com 이면 받은 값 그대로 둔다
resolve_repo() { # <repo>
  local repo="$1"
  if [[ ! "$repo" =~ ^[^/]+/[^/]+$ ]]; then printf '%s' "$repo"; return 0; fi
  local remotes
  remotes=$(git remote -v 2>/dev/null) || remotes=""
  python3 -c '
import re, sys
want = sys.argv[1].lower().removesuffix(".git")
for line in sys.stdin:
    parts = line.split()
    if len(parts) < 2:
        continue
    url = parts[1]
    m = (re.match(r"^[a-z+]+://(?:[^@/]+@)?([^/:]+)(?::\d+)?/(.+)$", url, re.I)
         or re.match(r"^(?:[^@/]+@)?([^/:]+):(?!//)(.+)$", url))
    if not m:
        continue
    host, path = m.group(1).lower(), m.group(2).strip("/").lower().removesuffix(".git")
    if path == want and host != "github.com":
        print(host + "/" + sys.argv[1], end="")
        sys.exit(0)
print(sys.argv[1], end="")
' "$repo" <<<"$remotes"
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
  [ -n "$REPO" ] && R=(-R "$(resolve_repo "$REPO")")

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
    # 세션 묶음(ADR-0039): 한 PR 브랜치에 이슈를 더하면 브랜치가 이미 원격에 있다.
    # why: gh issue develop 은 있는 이름에서 실패하면서 git 설정에 이름 빈 브랜치 절을 남겨 레포의 git 명령을 모두 깨뜨린다 (#1078)
    # 전체 참조 이름으로 본다. 짧은 이름은 끝자리 일치라 backup/fix/42 가 fix/42 로 읽힌다.
    # 종료 0 있음 · 2 없음. 그 밖(네트워크 · 인증)은 있는지 모르므로 develop 전에 멈춘다
    local EXISTING="" LS_RC=0
    git ls-remote --exit-code origin "refs/heads/$BRANCH" >/dev/null 2>&1 || LS_RC=$?
    case "$LS_RC" in
      0) EXISTING=1;;
      2) ;;
      *) err_json 2 "원격 브랜치 조회 실패: $BRANCH (종료 $LS_RC)" number="$NUMBER" branch="$BRANCH";;
    esac
    # 로컬 브랜치가 없으면 origin 을 명시해 만든다. 원격이 둘이면 이름만으로는 모호하다
    local LOCAL=""
    [ -n "$EXISTING" ] && git show-ref --verify --quiet "refs/heads/$BRANCH" && LOCAL=1
    if [ -z "$EXISTING" ]; then
      # why: 로컬에서 만든 브랜치는 이슈와 이어지지 않는다. 이슈에서 만든 브랜치만 PR 이 이슈에 자동 연결된다
      gh issue develop "$NUMBER" ${R[@]+"${R[@]}"} --name "$BRANCH" --base "$BASE" >/dev/null \
        || err_json 2 "이슈 연결 브랜치 생성 실패: $BRANCH" number="$NUMBER" branch="$BRANCH"
    fi
    git fetch origin >/dev/null 2>&1 || err_json 2 "git fetch origin 실패" number="$NUMBER"
    if [ "$MODE" = worktree ]; then
      local WT="../${PROJECT}-${TYPE}-${NUMBER}"
      if [ -n "$LOCAL" ]; then
        git worktree add "$WT" "$BRANCH" >/dev/null \
          || err_json 2 "git worktree add 실패: $WT" number="$NUMBER" branch="$BRANCH"
      else
        git worktree add "$WT" -b "$BRANCH" --track "origin/$BRANCH" >/dev/null \
          || err_json 2 "git worktree add 실패: $WT" number="$NUMBER" branch="$BRANCH"
      fi
      out+=(branch="$BRANCH" worktree="$WT")
    elif [ -n "$LOCAL" ]; then
      git checkout "$BRANCH" >/dev/null \
        || err_json 2 "git checkout 실패: $BRANCH" number="$NUMBER" branch="$BRANCH"
      out+=(branch="$BRANCH")
    else
      git checkout -b "$BRANCH" --track "origin/$BRANCH" >/dev/null \
        || err_json 2 "git checkout -b 실패: $BRANCH" number="$NUMBER" branch="$BRANCH"
      out+=(branch="$BRANCH")
    fi
    # 있는 브랜치에 붙인 이슈는 브랜치가 이슈와 이어지지 않는다. PR 본문의 닫는 키워드로 잇는다
    # 그 이슈 자신의 기본 브랜치를 다시 연 것(재시작)은 이미 이슈와 이어져 있어 묶음이 아니다
    [ -n "$EXISTING" ] && [ "$BRANCH" != "$TYPE/$NUMBER" ] && out+=(bundled=true)
  fi
  if [ -n "${CLAUDE_CODE_SESSION_ID:-}" ]; then
    # 생성에서 이어진 시작이면 제목 · 주소를 이미 안다. 단독 시작만 조회한다
    local META_TITLE="${KNOWN_TITLE:-}" META_URL="${KNOWN_URL:-}" META
    if [ -z "$META_URL" ]; then
      META=$(gh issue view "$NUMBER" ${R[@]+"${R[@]}"} --json title,url --jq '.url + "\t" + .title' 2>/dev/null) || META=""
      META_URL="${META%%$'\t'*}"; META_TITLE="${META#*$'\t'}"
    fi
    [ -n "$META_URL" ] && index_line 시작 "$NUMBER" "$META_TITLE" "$META_URL"
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

  # 한자 섞임 검사. 제목 · 본문에 한글과 붙은 한자가 있으면 생성하지 않는다 (#1090). 사유는 모듈이 stderr 에 낸다
  node "$SCRIPT_DIR/han-intrusion.mjs" --text "$TITLE" "$BODY" || exit 1

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
  [ -n "$REPO" ] && R=(-R "$(resolve_repo "$REPO")")

  # 라벨 보장 (providers/github.md 라벨 자동 생성). -R 이 있으면 라벨 명령에도 같은 레포.
  # why: 조회 실패(없는 레포 · 다른 호스트로 샌 호출)를 「라벨 없음」으로 읽으면 생성 단계에서야 엉뚱한 사유로 멈춘다
  local LABELS
  LABELS=$(gh label list ${R[@]+"${R[@]}"} --json name --jq '.[].name' 2>/dev/null) \
    || err_json 2 "라벨 조회 실패. 레포 · 호스트를 확인한다 (엔터프라이즈 레포는 -R host/owner/repo)" repo="${R[1]:-현재 레포}"
  if ! grep -qx "$TYPE" <<<"$LABELS"; then
    gh label create "$TYPE" ${R[@]+"${R[@]}"} --color "$(label_color "$TYPE")" >/dev/null \
      || err_json 2 "라벨 생성 실패: $TYPE"
  fi

  local URL NUMBER
  URL=$(gh issue create ${R[@]+"${R[@]}"} --title "$TITLE" --body-file "$BODY" --label "$TYPE") \
    || err_json 2 "이슈 생성 실패"
  NUMBER="${URL##*/}"
  [[ "$NUMBER" =~ ^[0-9]+$ ]] || err_json 2 "생성 응답에서 번호를 읽지 못했다: $URL"

  index_line 생성 "$NUMBER" "$TITLE" "$URL"

  if [ -n "$NO_START_REASON" ]; then
    ok_json number="$NUMBER" url="$URL" start=skipped reason="$NO_START_REASON"
    return 0
  fi

  local START_OUT START_RC
  set +e
  START_OUT=$(KNOWN_TITLE="$TITLE" KNOWN_URL="$URL" cmd_start "$NUMBER" --type "$TYPE" ${R[@]+"${R[@]}"} ${START_ARGS[@]+"${START_ARGS[@]}"})
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
