#!/usr/bin/env bash
# Stop hook: 직전 어시스턴트 응답을 transcript에서 추출해 금지 표현 검출.
# 위반 발견 시 .pending 파일에 기록 (다음 UserPromptSubmit hook이 주입 후 삭제).
#
# 룰: ${CLAUDE_PLUGIN_ROOT}/config/style-rules/forbidden-words.json (ADR-0026)
#     + 표준 용어 목록(config/style-rules/base/terms.md)의 「검출」 칸. 원천은 목록 하나이고
#       칸 해석은 scripts/terms.py 가 맡는다 (selftest 와 같은 해석을 쓰기 위해).
set -euo pipefail

INPUT=$(cat)
PLUGIN_RULES="${CLAUDE_PLUGIN_ROOT}/config/style-rules/forbidden-words.json"
PENDING_FILE="$HOME/.claude/.forbidden-violations-pending"

[[ -f "$PLUGIN_RULES" ]] || exit 0

HOOK_INPUT="$INPUT" PLUGIN_RULES="$PLUGIN_RULES" PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}" PENDING_FILE="$PENDING_FILE" python3 <<'PYEOF'
import json, os, re, sys

input_data = json.loads(os.environ.get("HOOK_INPUT", "{}"))
transcript = input_data.get("transcript_path", "")
if not transcript or not os.path.exists(transcript):
    sys.exit(0)

plugin_path = os.environ["PLUGIN_RULES"]
pending_path = os.environ["PENDING_FILE"]

with open(plugin_path) as f:
    plugin_conf = json.load(f)
plugin_rules = plugin_conf.get("rules", [])
ending_class = plugin_conf.get("_endingClass", "")

rules = list(plugin_rules)

# 표준 용어의 검출 칸. 목록이나 해석기가 없으면 금지 표현 검사만 한다
try:
    sys.path.insert(0, os.path.join(os.environ["PLUGIN_ROOT"], "scripts"))
    import terms
    with open(os.path.join(os.environ["PLUGIN_ROOT"], "config", "style-rules", "base", "terms.md"), encoding="utf-8") as f:
        for term_rule in terms.detection_rules(f.read()):
            rules.append({"pattern": term_rule["pattern"], "replacement": term_rule["replacement"],
                          "label": f"표준 용어 「{term_rule['title']}」"})
except Exception:
    pass

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

# %E% 는 어미 묶음 참조다. 활용형을 항목마다 열거하지 않기 위한 자리이고,
# 묶음 자체는 룰 파일이 한 번만 선언한다.
ENDINGS = ending_class or "(?:다|는|고|서|면|지|기|은|을|었|았)"

violations = []
for rule in rules:
    pat = rule["pattern"].replace("%E%", ENDINGS)
    matches = [m.group(0) for m in re.finditer(pat, last_text)]
    if matches:
        uniq = sorted(set(matches))
        label = f" ({rule['label']})" if rule.get("label") else ""
        violations.append(f"  - 패턴 `{rule['pattern']}` 매칭: {', '.join(uniq)} → 대체 `{rule['replacement']}`{label}")

if violations:
    with open(pending_path, "w") as f:
        f.write("\n".join(violations))
PYEOF
