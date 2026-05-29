#!/usr/bin/env bash
# PostToolUse hook (opt-in): 콘텐츠 파일 편집 직후 content-verify 자가 수행을 유도한다.
# 수기 호출 없이도 AI 티·가독성·톤·구두점 검증이 걸리게 하는 것이 목적이다.
#
# opt-in 방식: 프로젝트 루트(또는 상위)에 .devex/content-verify.json 마커가 있을 때만 작동한다.
# 마커가 없으면 조용히 종료한다 (모든 프로젝트 .md 편집마다 리마인더가 뜨는 노이즈 방지).
#
# 마커 스키마 (.devex/content-verify.json):
#   {
#     "include": ["**/*.md", "resume/*.html"],   // glob (생략 시 ["**/*.md"])
#     "exclude": ["node_modules/**", "CHANGELOG.md"],
#     "note": "프로젝트 추가 안내 (선택)"           // 리마인더에 함께 출력
#   }
#
# 비차단(exit 0) + additionalContext 주입. 차단/재작성은 하지 않는다.
set -euo pipefail

INPUT=$(cat)

command -v jq >/dev/null 2>&1 || exit 0

FP=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -z "$FP" ] && exit 0

# --- 마커 탐색: FP 디렉토리부터 위로 올라가며 .devex/content-verify.json 을 찾는다 ---
dir=$(dirname "$FP")
marker=""
while [ "$dir" != "/" ] && [ -n "$dir" ]; do
  if [ -f "$dir/.devex/content-verify.json" ]; then
    marker="$dir/.devex/content-verify.json"
    root="$dir"
    break
  fi
  dir=$(dirname "$dir")
done
[ -z "$marker" ] && exit 0

# --- include/exclude glob 매칭 (마커 기준 상대 경로) ---
rel="${FP#"$root"/}"

MATCH=$(MARKER="$marker" REL="$rel" python3 <<'PYEOF'
import json, os, fnmatch, sys
marker = os.environ["MARKER"]
rel = os.environ["REL"]
try:
    with open(marker) as f:
        cfg = json.load(f)
except Exception:
    print("no"); sys.exit(0)
include = cfg.get("include") or ["**/*.md"]
exclude = cfg.get("exclude") or []
def m(globs):
    for g in globs:
        if fnmatch.fnmatch(rel, g) or fnmatch.fnmatch(rel, g.replace("**/", "")):
            return True
    return False
print("yes" if (m(include) and not m(exclude)) else "no")
PYEOF
)
[ "$MATCH" != "yes" ] && exit 0

NOTE=$(MARKER="$marker" python3 -c 'import json,os;print(json.load(open(os.environ["MARKER"])).get("note","") or "")' 2>/dev/null || true)
BASE="${FP##*/}"

# --- 기계 검출 (즉시 잡히는 표현 위반) ---
viol=""
if grep -q "—" "$FP" 2>/dev/null; then
  viol="${viol} em dash(—) 발견: 마침표/쉼표로 분리."
fi
if grep -qE "을 통해|를 통해|활용하여|활용한|포괄적|체계적|효율적|원활(한|히|하게|함)" "$FP" 2>/dev/null; then
  viol="${viol} AI 슬롭 표현 의심(을/를 통해, 활용, 포괄적, 효율적, 원활 등): 직접 동사로."
fi

msg="[content-verify 하네스] ${BASE} 편집됨. 수기 호출 없이 content-verify 관점으로 자가 점검하라: "
msg="${msg}AI 티(style-rules base/ai-tells), 가독성(readability), 저자 톤(tone), 한국어 구두점(punctuation). "
msg="${msg}SSOT: ~/.claude/devex/style-rules/. 위반은 즉시 교정, 사실/주장/코드 로직은 보존."
[ -n "$NOTE" ] && msg="${msg} [프로젝트 노트] ${NOTE}"
[ -n "$viol" ] && msg="${msg} [기계 검출]${viol}"

jq -cn --arg ctx "$msg" \
  '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$ctx}}'
exit 0
