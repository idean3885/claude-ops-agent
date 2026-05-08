#!/usr/bin/env bash
# Stop hook: 직전 어시스턴트 응답을 transcript에서 추출해 금지 표현 검출.
# 위반 발견 시 .pending 파일에 기록 (다음 UserPromptSubmit hook이 주입 후 삭제).
#
# 룰 머지: 플러그인 기본(${CLAUDE_PLUGIN_ROOT}/config/forbidden-words.json)
#         + 개인(~/.claude/forbidden-words.local.json)
set -euo pipefail

INPUT=$(cat)
PLUGIN_RULES="${CLAUDE_PLUGIN_ROOT}/config/forbidden-words.json"
LOCAL_RULES="$HOME/.claude/forbidden-words.local.json"
PENDING_FILE="$HOME/.claude/.forbidden-violations-pending"

[[ -f "$PLUGIN_RULES" ]] || exit 0

HOOK_INPUT="$INPUT" PLUGIN_RULES="$PLUGIN_RULES" LOCAL_RULES="$LOCAL_RULES" PENDING_FILE="$PENDING_FILE" python3 <<'PYEOF'
import json, os, re, sys

input_data = json.loads(os.environ.get("HOOK_INPUT", "{}"))
transcript = input_data.get("transcript_path", "")
if not transcript or not os.path.exists(transcript):
    sys.exit(0)

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

rules = list(plugin_rules) + list(local_rules)

last_text = ""
with open(transcript) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except Exception:
            continue
        if entry.get("type") != "assistant":
            continue
        msg = entry.get("message", {})
        content = msg.get("content", [])
        if isinstance(content, list):
            texts = [c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text"]
            if texts:
                last_text = "\n".join(texts)

if not last_text:
    sys.exit(0)

violations = []
for rule in rules:
    pat = rule["pattern"]
    matches = [m.group(0) for m in re.finditer(pat, last_text)]
    if matches:
        uniq = sorted(set(matches))
        violations.append(f"  - 패턴 `{pat}` 매칭: {', '.join(uniq)} → 대체 `{rule['replacement']}`")

if violations:
    with open(pending_path, "w") as f:
        f.write("\n".join(violations))
PYEOF
