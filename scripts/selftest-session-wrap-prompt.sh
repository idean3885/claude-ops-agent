#!/usr/bin/env bash
# hooks/session-wrap-prompt.sh 발동 조건 셀프테스트 (#873).
#
# 마무리 신호에서만 종결 절차를 주입하고, 「마무리」가 다른 뜻으로 쓰인 문장에서는 조용해야 한다.
#   bash scripts/selftest-session-wrap-prompt.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$ROOT/hooks/session-wrap-prompt.sh"
export HOME="$(mktemp -d)"   # 지표 파일을 실제 홈에 남기지 않는다

# 훅 출력을 다 받은 뒤 본다. grep -q 로 바로 물리면 여러 줄을 내는 훅이 SIGPIPE 로 끝나 pipefail 에 걸린다
run_hook() {  # run_hook <문장> [session_id]
  python3 -c 'import json,sys;print(json.dumps({"prompt":sys.argv[1],"session_id":sys.argv[2]}))' "$1" "${2:-}" | bash "$HOOK"
}
fires() {
  local out; out=$(run_hook "$1")
  printf '%s' "$out" | grep -q '세션 마무리 감지'
}

PASS=0; FAIL=0
expect() {  # expect <fire|quiet> <문장>
  if fires "$2"; then got=fire; else got=quiet; fi
  if [ "$got" = "$1" ]; then PASS=$((PASS+1)); echo "OK   $1: $2"; else FAIL=$((FAIL+1)); echo "FAIL $1 기대, $got: $2"; fi
}

# 신호 목록과 완전히 같은 마지막 줄만 발동한다
expect fire  "세션 마무리"
expect fire  "세션 정리"
expect fire  "세션 종료하겠습니다"
expect fire  "세션 정리하고 끝냅니다"
expect fire  "세션을 마무리하죠"
expect fire  "세션 마무리 하겠습니다"
expect fire  "세션 마무리해 주세요"
expect fire  "세션 마무리해주세요"
expect fire  "세션 마무리 부탁합니다"
expect fire  "세션 마무리합시다."
expect fire  "이제 마무리합니다"
expect fire  "마무리합니다"
expect fire  "세션 마무리!"
expect fire  "세션 마무리 갑니다."
expect fire  "세션 정리 가겠습니다"
expect quiet "세션 마무리…"
expect fire  "오늘은 여기까지 마무리하겠습니다."
expect fire  "정리 끝났으면
세션 마무리"
# 명사 앞 · 다른 낱말이 붙은 문장
expect quiet "세션 종료 훅"
expect quiet "세션 정리 스크립트"
expect quiet "세션 마무리 절차"
expect quiet "세션 종료 훅 부탁합니다"
expect quiet "세션 마무리 단계에서 볼트 수정하겠습니다"
expect quiet "세션 정리하고 나서 훅 코드 고쳐 주세요"
expect quiet "세션 마무리라는 말의 뜻이 뭐죠"
# 부정 · 질문
expect quiet "세션 마무리 하나요"
expect quiet "세션 마무리할까요"
expect quiet "세션 종료하고싶지않아요"
expect quiet "세션 마무리 안 합니다"
# 「마무리」가 다른 뜻 · 대상이 세션이 아닌 줄
expect quiet "마무리 단계 문서 정리"
expect quiet "PR 마무리했습니다 확인 부탁"
expect quiet "PR 리뷰 마무리합니다"
expect quiet "구현을 마무리하고 테스트를 돌립니다 결과 알려주세요"
# 붙여 넣은 글 안의 줄
expect quiet "아래 글을 교정해 주세요
이 절은 결론으로 마무리합니다.
다음 절은 부록입니다"
expect quiet "교정 부탁
세션 마무리
위 두 줄은 제목 후보입니다"

# 세션 인덱스 (#1050): 어댑터가 쓴 줄을 이슈별로 묶어 주입하고, 주입한 뒤 지운다
check() {  # check <이름> <참|거짓 명령…>
  local name="$1"; shift
  if "$@"; then PASS=$((PASS+1)); echo "OK   인덱스: $name"; else FAIL=$((FAIL+1)); echo "FAIL 인덱스: $name"; fi
}
IDX_DIR="$HOME/.claude/ops-agent/.cache/session-issues"
mkdir -p "$IDX_DIR"
cat > "$IDX_DIR/sid-a.jsonl" <<'J'
{"ts":"2026-11-17T00:00:00Z","repo":"o/r","number":"7","title":"첫 이슈","action":"생성"}
{"ts":"2026-11-17T00:00:01Z","repo":"o/r","number":"7","title":"첫 이슈","action":"시작"}
{"ts":"2026-11-17T00:00:02Z","repo":"ghe.example/o/s","number":"9","title":"둘째 이슈","action":"시작"}
{"ts":"2026-11-17T00:00:03Z","repo":"o/r","number":"7","title":"첫 이슈","action":"시작"}
J
cp "$IDX_DIR/sid-a.jsonl" "$IDX_DIR/sid-other.jsonl"
OUT=$(run_hook "세션 마무리" "sid-a")
check "이슈 하나는 한 줄, 같은 동작은 한 번만 적는다" grep -qxF -- "- o/r#7 첫 이슈 (생성 · 시작)" <<<"$OUT"
check "다른 호스트 레포도 낸다" grep -qxF -- "- ghe.example/o/s#9 둘째 이슈 (시작)" <<<"$OUT"
check "같은 이슈를 두 줄로 내지 않는다" test "$(grep -c '#7 ' <<<"$OUT")" = 1
check "주입한 뒤 그 세션 파일을 지운다" test ! -e "$IDX_DIR/sid-a.jsonl"
check "다른 세션 파일은 남긴다" test -e "$IDX_DIR/sid-other.jsonl"
OUT=$(run_hook "세션 마무리" "sid-a")
check "파일이 없으면 대화에서 모으라고 알린다" grep -q '세션 인덱스 없음' <<<"$OUT"
OUT=$(run_hook "세션 마무리 절차" "sid-other")
check "마무리 신호가 아닌 턴은 파일을 건드리지 않는다" test -e "$IDX_DIR/sid-other.jsonl"
check "마무리 신호가 아닌 턴은 아무것도 내지 않는다" test -z "$OUT"
echo '{"repo":"o/r","number":"1","title":"밖","action":"생성"}' > "$IDX_DIR/../outside.jsonl"
OUT=$(run_hook "세션 마무리" "../outside")
check "세션 번호의 경로 문자는 걷는다 (인덱스 밖 파일을 지우지 않는다)" test -e "$IDX_DIR/../outside.jsonl"

# 대상 출처 (#1148): 이슈 목록만이 아니라 압축 요약 · 컴팩트 재료 · 대화를 함께 가리킨다
OUT=$(run_hook "세션 마무리" "sid-none")
check "출처 넷을 모두 본다고 알린다" grep -q '출처는 넷이고 모두 본다' <<<"$OUT"
check "재료 파일이 없으면 재료 경로 줄을 내지 않는다" test -z "$(grep '컴팩트 재료:' <<<"$OUT")"
mkdir -p "$HOME/.claude/state/compact"
echo "## 구간 1" > "$HOME/.claude/state/compact/sid-c.md"
OUT=$(run_hook "세션 마무리" "sid-c")
check "재료 파일이 있으면 그 경로를 낸다" grep -qF "컴팩트 재료: $HOME/.claude/state/compact/sid-c.md" <<<"$OUT"
check "지표에 재료 유무를 남긴다" grep -q '"compact":true' "$HOME/.claude/ops-agent/metrics/session-wrap-prompt.jsonl"

echo "$PASS/$((PASS+FAIL)) 통과"
[ "$FAIL" -eq 0 ]
