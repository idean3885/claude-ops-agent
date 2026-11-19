#!/usr/bin/env bash
# UserPromptSubmit hook: 세션 마무리 신호를 받은 턴에 종결 절차를 주입한다 (#873).
#
# 원칙은 docs/working-principles.md 「세션 마무리는 종결로 끝낸다」에 있다. 원칙이 있어도 마무리 때
# 처리 목록만 내고 남은 일을 다음으로 넘기는 실패가 반복돼, 그 시점에 읽는 단계를 둔다.
# 본문은 복제하지 않고 가리킨다. 차단이 아니라 알림이다.
#
# 대상 이슈는 세션 인덱스(~/.claude/ops-agent/.cache/session-issues/<session_id>.jsonl)가 정한다.
# 이슈 어댑터(scripts/gh-issue.sh)가 생성 · 시작 때 쓴 줄을 목록으로 주입하고 파일을 지운다 (#1050).
# 어시스턴트가 판단해서 쓰는 목록이 아니라서 오염 경로가 없다.
#
# 입력: stdin 의 hook JSON (`prompt` · `session_id` 필드)
# 지표: ~/.claude/ops-agent/metrics/session-wrap-prompt.jsonl (발동마다 한 줄)
set -euo pipefail

INPUT=$(cat)
PROMPT=$(printf '%s' "$INPUT" | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("prompt",""))
except Exception:
    pass' 2>/dev/null || true)
SESSION_ID=$(printf '%s' "$INPUT" | python3 -c 'import json,re,sys
try:
    print(re.sub(r"[^A-Za-z0-9_-]", "", str(json.load(sys.stdin).get("session_id") or "")))
except Exception:
    pass' 2>/dev/null || true)

[[ -n "$PROMPT" ]] || exit 0

# 마무리 신호의 정의는 원칙 문서 「세션 마무리는 종결로 끝낸다」의 「신호」 항목이다.
# 마지막 비어 있지 않은 줄에서 공백과 끝의 마침표 · 느낌표를 빼고 아래 목록과 완전히 같을 때만 발동한다.
# 목록 밖의 문장은 판정하지 않는다. 놓친 말투는 지표를 보고 목록에 더한다.
LAST=$(printf '%s\n' "$PROMPT" | awk 'NF{l=$0} END{print l}' | tr -d '[:space:]' | sed -E 's/[.!]+$//')
ENDINGS='(합니다|하겠습니다|할게요|합시다|하자|하죠|해요|해주세요|해줘|부탁합니다|부탁드립니다|하고끝냅니다|갑니다|가겠습니다)'
MATCHED=""
if printf '%s' "$LAST" | grep -qE "^세션(을|를)?(마무리|종료|정리)${ENDINGS}?$"; then
  MATCHED="session"
elif printf '%s' "$LAST" | grep -qE "^(이제|여기서|오늘은여기까지)?마무리${ENDINGS}$"; then
  MATCHED="line-end"
fi
[[ -n "$MATCHED" ]] || exit 0

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
METRICS_FILE="$HOME/.claude/ops-agent/metrics/session-wrap-prompt.jsonl"
mkdir -p "$(dirname "$METRICS_FILE")"
# 컴팩트 재료: 압축 직전 훅(hooks/precompact-state.py)이 구간마다 이어 쓰는 사용자 발화 · 명령 기록이다.
# 압축 요약의 「마무리 때 할 것」과 함께 대상 출처로 가리킨다. 이슈 목록만 보이면 그 목록이 대상이 된다 (#1148)
COMPACT=""
[[ -n "$SESSION_ID" && -s "$HOME/.claude/state/compact/$SESSION_ID.md" ]] && COMPACT="$HOME/.claude/state/compact/$SESSION_ID.md"
printf '{"ts":"%s","matched":"%s","compact":%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$MATCHED" "$([[ -n "$COMPACT" ]] && echo true || echo false)" >>"$METRICS_FILE" 2>/dev/null || true

cat <<EOF
[세션 마무리 감지] 종결로 끝낸다. 절차는 $PLUGIN_ROOT/docs/working-principles.md 「세션 마무리는 종결로 끝낸다」를 읽고 따른다.
단계: 1 대상 수집 → 2 잔여 처리 · 묶음 → 3 막힌 것의 자리 결정 → 4 판결(첫 줄 「종결」 · 「미종결」)
1 대상 수집의 출처는 넷이고 모두 본다: 세션 인덱스(아래 이슈 목록) · 압축 요약에 적힌 「마무리 때 할 것」 · 컴팩트 재료 · 지금 대화. 이슈 목록은 최소 목록이지 대상 전체가 아니다.
EOF
if [[ -n "$COMPACT" ]]; then
  echo "컴팩트 재료: $COMPACT (세션 중 「마무리 때」로 미룬 지시 · 합의를 여기와 압축 요약에서 찾는다)"
fi

# 세션 인덱스: 이슈별로 묶어 한 줄씩 낸다. 주입한 뒤 지운다(대상 확정).
INDEX=""
[[ -n "$SESSION_ID" ]] && INDEX="$HOME/.claude/ops-agent/.cache/session-issues/$SESSION_ID.jsonl"
if [[ -n "$INDEX" && -s "$INDEX" ]]; then
  echo "대상 이슈(세션 인덱스 · 어댑터 기록). 최소 목록이다. 인덱스 쓰기는 실패해도 어댑터가 성공하므로 생성 · 시작도 대화와 대조하고, 어댑터를 거치지 않은 변경(본문 수정 · 닫기)을 더한다:"
  python3 - "$INDEX" <<'PY' 2>/dev/null || true
import json, sys
seen = {}
for line in open(sys.argv[1], encoding="utf-8"):
    try:
        r = json.loads(line)
    except Exception:
        continue
    key = (r.get("repo", ""), str(r.get("number", "")))
    if not key[1]:
        continue
    e = seen.setdefault(key, {"title": "", "actions": []})
    if r.get("title"):
        e["title"] = r["title"]
    a = r.get("action", "")
    if a and a not in e["actions"]:
        e["actions"].append(a)
for (repo, num), e in seen.items():
    print(f"- {repo}#{num} {e['title']} ({' · '.join(e['actions'])})")
PY
  rm -f "$INDEX"
else
  echo "세션 인덱스 없음: 어댑터로 만들거나 시작한 이슈가 없다. 대상 이슈는 대화에서 모은다."
fi
