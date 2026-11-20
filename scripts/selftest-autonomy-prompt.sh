#!/usr/bin/env bash
# hooks/autonomy-prompt.sh 발동 조건 · 지표 셀프테스트 (#649 · #1048 · #1154).
#
# 자율 위임 문장에서만 계획 · 권한 선취 절차를 주입하고, 대화창 위임 문장(「푸시 권한 위임」) 하나뿐인 메시지는 조용해야 한다.
# 지표 줄에는 세션 식별자를 남겨 그 세션의 결과(정답률)와 잇는다.
#   bash scripts/selftest-autonomy-prompt.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$ROOT/hooks/autonomy-prompt.sh"
export HOME="$(mktemp -d)"   # 지표 파일을 실제 홈에 남기지 않는다
METRICS="$HOME/.claude/ops-agent/metrics/autonomy-prompt.jsonl"

run_hook() {  # run_hook <문장> [session_id]
  python3 -c 'import json,sys;print(json.dumps({"prompt":sys.argv[1],"session_id":sys.argv[2]}))' "$1" "${2:-}" | bash "$HOOK"
}

PASS=0; FAIL=0
check() {  # check <이름> <참|거짓 명령…>
  local name="$1"; shift
  if "$@"; then PASS=$((PASS+1)); echo "OK   $name"; else FAIL=$((FAIL+1)); echo "FAIL $name"; fi
}
expect() {  # expect <fire|quiet> <문장>
  local out got; out=$(run_hook "$2" "s-expect")
  if printf '%s' "$out" | grep -q '자율 위임 감지'; then got=fire; else got=quiet; fi
  if [ "$got" = "$1" ]; then PASS=$((PASS+1)); echo "OK   $1: $2"; else FAIL=$((FAIL+1)); echo "FAIL $1 기대, $got: $2"; fi
}

expect fire  "알아서 진행해 주세요"
expect fire  "체크리스트 테스트 전권 위임합니다"
expect fire  "게이트 오픈합니다"
expect quiet "이 함수 이름을 고쳐 주세요"
expect quiet "푸시 권한 위임"
expect quiet "  푸시 권한 위임  "

rm -f "$METRICS"
run_hook "알아서 진행해 주세요" "sid-1" >/dev/null
check "발동하면 지표에 한 줄" test "$(wc -l <"$METRICS" | tr -d ' ')" = 1
check "지표에 갈래를 남긴다" grep -q '"matched":"delegation"' "$METRICS"
check "지표에 세션 식별자를 남긴다" grep -q '"session":"sid-1"' "$METRICS"
run_hook "이 함수 이름을 고쳐 주세요" "sid-2" >/dev/null
check "발동하지 않으면 지표를 쓰지 않는다" test "$(wc -l <"$METRICS" | tr -d ' ')" = 1
run_hook "알아서 진행해 주세요" '../x"y' >/dev/null
check "세션 식별자는 경로 · 따옴표 문자를 걷는다" grep -q '"session":"xy"' "$METRICS"
check "지표 줄은 모두 JSON 이다" python3 -c 'import json,sys;[json.loads(l) for l in open(sys.argv[1])]' "$METRICS"

echo "$PASS/$((PASS+FAIL)) 통과"
[ "$FAIL" -eq 0 ]
