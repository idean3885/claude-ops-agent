#!/usr/bin/env bash
# patch-hud.sh 가 claude-hud 0.15 렌더 구조에 compact 무줄바꿈을 걸고, 재적용은 건너뛰고, 모르는 구조는 경고하는지 확인한다(#1238).
set -uo pipefail
S="$(cd "$(dirname "$0")" && pwd)/patch-hud.sh"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mk() { mkdir -p "$T/$1/0.15.4/src/render"; printf '%s\n' "$2" > "$T/$1/0.15.4/src/render/index.ts"; }
NEW="export function renderLines(ctx: RenderContext, columns: number | null, now: number): string[] {
  const frame = createFrame(ctx, columns, now);
  const lines = (ctx.config?.lineLayout ?? 'expanded') === 'expanded' ? expandedLines(frame) : compactLines(frame);
  return lines
    .flatMap((line) => line.split('\n'))
    .flatMap((line) => wrapToWidth(line, frame.width ?? 0))
    .map((line) => \`\${RESET}\${line}\`);
}"
fail=0
mk new "$NEW"; F="$T/new/0.15.4/src/render/index.ts"
out=$(PATCH_HUD_CACHE="$T/new" bash "$S"); rc=$?
[ $rc = 0 ] && echo "$out" | grep -q '패치 적용 완료' || { echo "FAIL: 새 구조에 적용 안 됨 ($out)"; fail=1; }
grep -q "=== 'compact' ? \[line\] : wrapToWidth" "$F" || { echo "FAIL: compact 분기 없음"; fail=1; }
grep -q '^    .flatMap((line) => wrapToWidth(line, frame.width ?? 0))$' "$F" && { echo "FAIL: 원래 줄바꿈 줄이 남음"; fail=1; }
before=$(cat "$F")
out=$(PATCH_HUD_CACHE="$T/new" bash "$S")
echo "$out" | grep -q '이미 적용됨' && [ "$before" = "$(cat "$F")" ] || { echo "FAIL: 재적용이 파일을 바꿈"; fail=1; }
mk old "  const visibleLines = physicalLines.flatMap(line => wrapLineToWidth(line, wrapWidth));"
out=$(PATCH_HUD_CACHE="$T/old" bash "$S"); rc=$?
[ $rc != 0 ] && echo "$out" | grep -q '원본 패턴 불일치' || { echo "FAIL: 모르는 구조에서 경고 안 함"; fail=1; }
[ $fail = 0 ] && echo "selftest-patch-hud: ok"
exit $fail
