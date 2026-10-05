#!/usr/bin/env bash
# final-check.sh: 머지 직전 최종 점검 (#612).
#
# 점검이 LLM 의 기억에 달려 있으면 게이트가 열린 순간 점검 없이 머지된다. 이 스크립트가
# 결정적 점검을 돌리고, 통과하면 **머지할 커밋(HEAD)에 묶인 통과 기록**을 남긴다.
# pre-tool-use.mjs 가 `gh pr merge` 직전에 이 통과 기록을 확인한다. 푸시로 HEAD 가 바뀌면
# 통과 기록은 무효가 되므로 다시 돌린다.
#
# 사용: final-check.sh <PR번호> --notes <파일>
#   notes  판단 점검 노트. 아래 세 절이 있고 각 본문이 비어 있지 않아야 한다.
#          ## 설계 반영 / ## 서브 에이전트 산출물 / ## 교정
#          CodeRabbit 의 마지막 리뷰가 HEAD 가 아닐 때는 ## 자체 검증 도 채운다.
#          「해당 없음」 같은 한 줄은 본문으로 인정한다. 비워 두는 것만 막는다.
#
# 실패 조건 (하나라도 걸리면 목록을 출력하고 종료 코드 1):
#   a. 실패 또는 대기 중인 체크
#   b. 미해결 리뷰 스레드
#   c. `.coderabbit.yaml` 이 있고 CodeRabbit 마지막 리뷰가 HEAD 가 아닌데 ## 자체 검증 이 비어 있음
#      (체크 상태 SUCCESS 는 리뷰 여부와 무관하다. 리뷰의 commit_id 로 판정한다)
#   d. 레포의 `.ops-agent/final-check.sh` 가 있고 종료 코드가 0 이 아님 (레포가 선언한 체크리스트)
#   e. PR 이 **추가한 줄**의 PN7(서술 문장 종결 부호) 검출. 기존 줄의 PN7 과 다른 규칙 검출은 출력만 하고 실패로 세지 않는다
#   f. 노트의 세 절 중 없거나 비어 있는 것
#
# 통과하면 노트를 PR 댓글로 올리고 통과 기록을 남긴다.
#   통과 기록: ~/.claude/ops-agent/.cache/final-check/<owner>__<repo>__<PR>.json
#   지표:   ~/.claude/ops-agent/metrics/final-check.jsonl (매 실행 한 줄)
set -uo pipefail

START_MS=$(python3 -c 'import time; print(int(time.time()*1000))')
# 검증 실행이 실제 통과 기록 · 지표를 오염시키지 않도록 기록 위치만 바꿀 수 있다 (gh 인증은 HOME 그대로 쓴다).
HOME_DIR="${FINAL_CHECK_HOME:-${HOME:?}}"
CACHE_DIR="$HOME_DIR/.claude/ops-agent/.cache/final-check"
METRICS_FILE="$HOME_DIR/.claude/ops-agent/metrics/final-check.jsonl"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COUNTER="${CLAUDE_PLUGIN_ROOT:-$SCRIPT_DIR/..}/config/style-rules/metrics/readability_count.py"

PR=""
NOTES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --notes) NOTES="${2:-}"; shift 2 ;;
    -*) echo "알 수 없는 옵션: $1" >&2; exit 2 ;;
    *) PR="$1"; shift ;;
  esac
done
if ! [[ "$PR" =~ ^[0-9]+$ ]]; then
  echo "사용: final-check.sh <PR번호> --notes <파일>" >&2
  exit 2
fi

meta=$(gh pr view "$PR" --json number,headRefOid,headRefName,url) || { echo "PR $PR 을 읽지 못했다" >&2; exit 2; }
HEAD_SHA=$(jq -r .headRefOid <<<"$meta")
BRANCH=$(jq -r .headRefName <<<"$meta")
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner) || { echo "레포를 읽지 못했다" >&2; exit 2; }
ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

failed=()
fail() { failed+=("$1"); printf '실패 %s: %s\n' "$1" "$2"; }

# 노트에서 `## <제목>` 절의 본문(다음 `##` 전까지)을 돌려준다. 공백 줄은 본문이 아니다.
section_body() {
  [ -f "$NOTES" ] || return 0
  awk -v want="$1" '
    /^##[[:space:]]/ { t=$0; sub(/^##[[:space:]]+/, "", t); sub(/[[:space:]]+$/, "", t); on=(t==want); next }
    on && NF { print }
  ' "$NOTES"
}

# a. 체크: 실패 · 취소 · 대기. 체크가 없는 PR 은 대상이 없으므로 통과로 둔다.
checks=$(gh pr checks "$PR" --json name,bucket 2>/dev/null || true)
if [ -n "$checks" ]; then
  bad=$(jq -r '.[] | select(.bucket != "pass" and .bucket != "skipping") | "\(.name)(\(.bucket))"' <<<"$checks" | paste -sd, -)
  [ -n "$bad" ] && fail a "실패 또는 대기 중인 체크: $bad"
fi

# b. 미해결 리뷰 스레드
owner="${REPO%/*}"; name="${REPO#*/}"
unresolved=$(gh api graphql -F owner="$owner" -F name="$name" -F pr="$PR" -f query='
  query($owner:String!,$name:String!,$pr:Int!){
    repository(owner:$owner,name:$name){ pullRequest(number:$pr){
      reviewThreads(first:100){ nodes{ isResolved } }
    } }
  }' --jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved|not)] | length' 2>/dev/null || echo "?")
if [ "$unresolved" != "0" ]; then
  fail b "미해결 리뷰 스레드: $unresolved"
fi

# c. CodeRabbit: 마지막 리뷰가 HEAD 에 달렸는가. 아니면 바뀐 부분을 자체 검증했다는 기록이 있어야 한다.
if [ -f "$ROOT/.coderabbit.yaml" ]; then
  last=$(gh api "repos/$REPO/pulls/$PR/reviews" --paginate --slurp 2>/dev/null \
    | jq -r '[.[][] | select(.user.login | test("coderabbitai"))] | last | .commit_id // ""' 2>/dev/null || true)
  if [ "$last" != "$HEAD_SHA" ] && [ -z "$(section_body '자체 검증')" ]; then
    fail c "CodeRabbit 마지막 리뷰(${last:0:7}${last:+ })가 HEAD(${HEAD_SHA:0:7})가 아니고 노트의 ## 자체 검증 이 비어 있다"
  fi
fi

# d. 레포가 선언한 체크리스트
if [ -f "$ROOT/.ops-agent/final-check.sh" ]; then
  if ! (cd "$ROOT" && FINAL_CHECK_PR="$PR" FINAL_CHECK_HEAD="$HEAD_SHA" bash .ops-agent/final-check.sh "$PR"); then
    fail d ".ops-agent/final-check.sh 종료 코드가 0 이 아니다"
  fi
fi

# e. 변경 문서의 구조 검출. 로컬 작업 트리가 아니라 HEAD 의 내용을 받아 센다.
if [ -f "$COUNTER" ]; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  files=()
  while IFS= read -r f; do
    case "$f" in *.md) ;; *) continue ;; esac
    mkdir -p "$tmp/$(dirname "$f")"
    if gh api "repos/$REPO/contents/$f?ref=$HEAD_SHA" -H 'Accept: application/vnd.github.raw' >"$tmp/$f" 2>/dev/null; then
      files+=("$f")
    fi
  done < <(gh pr diff "$PR" --name-only 2>/dev/null)
  if [ "${#files[@]}" -gt 0 ]; then
    hits=$(cd "$tmp" && python3 "$COUNTER" "${files[@]}" 2>&1 || true)
    # PR 이 추가한 줄(+ 줄의 새 파일 기준 줄 번호)을 `파일:줄` 로 모은다. 기존 줄의 PN7 은 이 PR 의 몫이 아니다.
    added=$(gh pr diff "$PR" 2>/dev/null | awk '
      /^\+\+\+ b\// { f=substr($0, 7); next }
      /^\+\+\+ / { f=""; next }
      /^@@/ { match($0, /\+[0-9]+/); n=substr($0, RSTART+1, RLENGTH-1)+0; next }
      f=="" || /^---/ { next }
      /^\+/ { print f ":" n; n++; next }
      /^-/ { next }
      { n++ }
    ')
    pn7_all=$(grep '\[PN7\]' <<<"$hits" || true)
    pn7_new=$(while IFS= read -r l; do
      [ -n "$l" ] && grep -qxF -- "${l%% *}" <<<"$added" && printf '%s\n' "$l"
    done <<<"$pn7_all")
    total=$(grep -c . <<<"$pn7_all" || true)
    new=$(grep -c . <<<"$pn7_new" || true)
    other=$(grep -v '\[PN7\]' <<<"$hits" | sed '/^$/d' || true)
    [ -n "$other" ] && printf '참고 (실패 아님):\n%s\n' "$other"
    [ "${total:-0}" -gt 0 ] && echo "참고 (실패 아님): 기존 줄의 PN7 $((total - new))건"
    [ "${new:-0}" -gt 0 ] && { fail e "PR 이 추가한 줄의 PN7 ${new}건"; head -20 <<<"$pn7_new"; }
  fi
else
  echo "참고: 카운터를 찾지 못해 문서 검출을 건너뛴다 ($COUNTER)"
fi

# f. 판단 점검 노트
if [ ! -f "$NOTES" ]; then
  fail f "노트 파일이 없다 (--notes <파일>). 절: ## 설계 반영 / ## 서브 에이전트 산출물 / ## 교정"
else
  for sec in "설계 반영" "서브 에이전트 산출물" "교정"; do
    [ -z "$(section_body "$sec")" ] && fail f "노트의 ## $sec 절이 없거나 비어 있다"
  done
fi

record() {
  local result="$1" end_ms
  end_ms=$(python3 -c 'import time; print(int(time.time()*1000))')
  mkdir -p "$(dirname "$METRICS_FILE")"
  jq -nc --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg repo "$REPO" --argjson pr "$PR" --arg result "$result" \
    --argjson failed "$(printf '%s\n' "${failed[@]:-}" | sed '/^$/d' | sort -u | jq -R . | jq -sc .)" \
    --argjson d "$((end_ms - START_MS))" \
    '{ts:$ts,repo:$repo,pr:$pr,result:$result,failed:$failed,duration_ms:$d}' >>"$METRICS_FILE"
}

if [ "${#failed[@]}" -gt 0 ]; then
  record fail
  echo "최종 점검 실패 (PR $PR, HEAD ${HEAD_SHA:0:7}). 고친 뒤 다시 실행한다." >&2
  exit 1
fi

gh pr comment "$PR" --body-file "$NOTES" >/dev/null || { echo "노트 댓글을 올리지 못했다" >&2; failed+=(comment); record fail; exit 1; }
mkdir -p "$CACHE_DIR"
jq -nc --argjson pr "$PR" --arg head "$HEAD_SHA" --arg branch "$BRANCH" --arg repo "$REPO" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{pr:$pr,head:$head,branch:$branch,repo:$repo,at:$at}' >"$CACHE_DIR/${REPO/\//__}__${PR}.json"
record pass
echo "최종 점검 통과 (PR $PR, HEAD ${HEAD_SHA:0:7}). 통과 기록을 남겼다."
# why: 훅은 로컬 추적 브랜치로만 비교하므로, 원격에 다른 푸시가 있으면 서버 쪽 대조로 막는다
echo "머지: gh pr merge $PR --merge --match-head-commit $HEAD_SHA"
echo "이슈가 끝나면 세션 종료 또는 /clear"
