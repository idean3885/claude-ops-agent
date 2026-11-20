#!/usr/bin/env bash
# UserPromptSubmit hook: 자율 위임 문구를 받은 턴에 계획 · 권한 선취 절차를 주입한다 (#649).
#
# 규칙은 flow SKILL.md GATE 3 0단계에 있다. 규칙이 컨텍스트에 있어도 위임 문장을 받은
# 순간 편집부터 들어가는 실패가 재발해, 그 시점에 읽는 단계를 둔다. 본문은 복제하지 않고
# 가리킨다. 차단이 아니라 알림이다 (편집은 되돌릴 수 있다).
#
# 입력: stdin 의 hook JSON (`prompt` 필드)
# 지표: ~/.claude/ops-agent/metrics/autonomy-prompt.jsonl (발동마다 한 줄, 세션 식별자 포함)
set -euo pipefail

INPUT=$(cat)
PROMPT=$(printf '%s' "$INPUT" | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("prompt",""))
except Exception:
    pass' 2>/dev/null || true)

[[ -n "$PROMPT" ]] || exit 0

# 대화창 위임 문장(#1046)은 권한을 여는 호출이지 작업 위임 지시가 아니다 (#1048).
# 메시지 전체가 그 문장이면 알리지 않는다. 문장 정의는 scripts/push-delegation.mjs 의 DELEGATION_PHRASE.
TRIMMED=$(printf '%s' "$PROMPT" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' | tr -d '\n')
[[ "$TRIMMED" == "푸시 권한 위임" ]] && exit 0

# 위임 문장: 「자율」 또는 「위임」 과 진행 동사가 함께 오거나, 게이트 개방 선언이 온다.
MATCHED=""
if printf '%s' "$PROMPT" | grep -qE '(자율|알아서|일괄).{0,12}(진행|처리|위임)|위임'; then
  MATCHED="delegation"
elif printf '%s' "$PROMPT" | grep -qE '게이트.{0,6}(오픈|개방|열)'; then
  MATCHED="gate-phrase"
fi

[[ -n "$MATCHED" ]] || exit 0

# 세션 식별자는 발동한 턴에만 뽑는다 (#1154). 지표를 그 세션의 정답률과 잇는 열쇠이고, 영숫자 · - · _ 밖은 걷는다
SESSION_ID=$(printf '%s' "$INPUT" | python3 -c 'import json,re,sys
try:
    print(re.sub(r"[^A-Za-z0-9_-]", "", str(json.load(sys.stdin).get("session_id") or "")))
except Exception:
    pass' 2>/dev/null || true)

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
METRICS_FILE="$HOME/.claude/ops-agent/metrics/autonomy-prompt.jsonl"
mkdir -p "$(dirname "$METRICS_FILE")"
printf '{"ts":"%s","matched":"%s","session":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$MATCHED" "$SESSION_ID" >>"$METRICS_FILE" 2>/dev/null || true

cat <<EOF
[자율 위임 감지] 편집 · 실행 전에 계획과 권한을 한 번에 받는다 (flow SKILL.md GATE 3 0단계, $PLUGIN_ROOT/skills/flow/SKILL.md).
1. 끝까지의 단계를 표로 펼친다: 단계 · 명령 · 하네스 허용 규칙 유무(~/.claude/settings.json) · 게이트 갈래
2. 막히는 구간을 실측한다: bash ~/.claude/ops-agent/current/scripts/action-gate-allow.sh status
3. 빠진 권한과 개방 명령(\`! bash … action-gate-allow.sh on <갈래>\`)을 같은 요청에 싣는다. \`!\` 를 실행하지 않는 대화창이면 같은 한 줄을 메시지로 입력하게 안내한다. 갈래 이름은 스크립트 머리의 목록에서 고른다
4. 승인 전에는 편집하지 않는다. 승인 뒤에는 묻지 않고 끝까지 간다. 권한 프롬프트가 뜨면 그 자리에서 멈추고 다시 싣는다
「게이트 오픈합니다」는 승인 문장이지 개방이 아니다. 개방은 사용자가 위 명령을 실행했을 때만이다.
EOF
