#!/usr/bin/env bash
# UserPromptSubmit hook: 기본 금지 표현 룰 + 사용자 추가 룰을 머지하여
# 매 턴마다 system-reminder로 주입. 직전 응답 위반이 .pending 파일에
# 기록돼 있으면 함께 주입 후 삭제.
#
# 데이터 소스 (머지 우선순위):
#   1. ${CLAUDE_PLUGIN_ROOT}/config/forbidden-words.json   (플러그인 기본, 필수)
#   2. ~/.claude/forbidden-words.local.json                 (개인 추가, 선택)
set -euo pipefail

PLUGIN_RULES="${CLAUDE_PLUGIN_ROOT}/config/forbidden-words.json"
LOCAL_RULES="$HOME/.claude/forbidden-words.local.json"
PENDING_FILE="$HOME/.claude/.forbidden-violations-pending"

[[ -f "$PLUGIN_RULES" ]] || exit 0

PLUGIN_RULES="$PLUGIN_RULES" LOCAL_RULES="$LOCAL_RULES" PENDING_FILE="$PENDING_FILE" python3 <<'PYEOF'
import json, os

plugin_path = os.environ["PLUGIN_RULES"]
local_path = os.environ["LOCAL_RULES"]
pending_path = os.environ["PENDING_FILE"]

with open(plugin_path) as f:
    plugin_rules = json.load(f).get("rules", [])

local_rules = []
if os.path.exists(local_path):
    try:
        with open(local_path) as f:
            local_rules = json.load(f).get("rules", [])
    except Exception:
        local_rules = []

merged = list(plugin_rules) + list(local_rules)

lines = [
    "[금지 표현 강제 — 어시스턴트 응답에 포함 금지]",
    "  ※ 이 hook은 출력을 막거나 재작성하지 않는다. 출력 직전 패턴 자가 대조는 어시스턴트의 의무다.",
]
for rule in merged:
    pat = rule.get("pattern", "")
    rep = rule.get("replacement", "")
    rsn = rule.get("reason", "")
    lines.append(f"  - 패턴 `{pat}` → 대체 `{rep}` ({rsn})")

if os.path.exists(pending_path):
    with open(pending_path) as f:
        violations = f.read().strip()
    if violations:
        lines.append("")
        lines.append("[직전 응답에서 검출된 위반]")
        lines.append(violations)
        lines.append("→ 다음 응답 작성 시 위 패턴을 먼저 자가 점검하라. 사용자에게 사과 1회만, 반복 금지.")
    os.remove(pending_path)

print("\n".join(lines))
PYEOF
