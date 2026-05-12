#!/bin/bash
# claude-hud compact 모드 wrap/truncate 회피 패치
# 멱등성: 이미 적용됐으면 스킵, 원본 패턴 불일치 시 경고 (#81)
#
# 사용법: ./scripts/patch-hud.sh

set -euo pipefail

HUD_CACHE="$HOME/.claude/plugins/cache/claude-hud/claude-hud"

LATEST=$(ls -1 "$HUD_CACHE" 2>/dev/null | sort -V | tail -1)
if [ -z "$LATEST" ]; then
  echo "⚠️  claude-hud 캐시 없음 — 스킵"
  exit 0
fi

TARGET="$HUD_CACHE/$LATEST/src/render/index.ts"
if [ ! -f "$TARGET" ]; then
  echo "⚠️  render/index.ts 없음 — 스킵"
  exit 0
fi

MARKER="// Compact: single line, no wrap, no truncation"
if grep -q "$MARKER" "$TARGET" 2>/dev/null; then
  echo "✅ [compact-nowrap] 이미 적용됨 — 스킵"
  exit 0
fi

export PATCH_TARGET="$TARGET"
python3 << 'PYEOF'
import os, pathlib

target = pathlib.Path(os.environ["PATCH_TARGET"])
content = target.read_text()

original = "\n".join([
    "  const physicalLines = lines.flatMap(line => line.split('\\n'));",
    "  // Only wrap when terminal width is real (known). When width is the",
    "  // UNKNOWN_TERMINAL_WIDTH fallback, wrapping would use an arbitrary value",
    "  // and produce incorrect line breaks.",
    "  const wrapWidth = terminalWidth !== UNKNOWN_TERMINAL_WIDTH ? (terminalWidth ?? 0) : 0;",
    "  const visibleLines = physicalLines.flatMap(line => wrapLineToWidth(line, wrapWidth));",
    "",
    "  for (const line of visibleLines) {",
    "    const outputLine = `${RESET}${line}`;",
    "    console.log(outputLine);",
    "  }",
])

patched = "\n".join([
    "  const physicalLines = lines.flatMap(line => line.split('\\n'));",
    "  // Only wrap when terminal width is real (known). When width is the",
    "  // UNKNOWN_TERMINAL_WIDTH fallback, wrapping would use an arbitrary value",
    "  // and produce incorrect line breaks.",
    "  const wrapWidth = terminalWidth !== UNKNOWN_TERMINAL_WIDTH ? (terminalWidth ?? 0) : 0;",
    "",
    "  if (lineLayout === 'compact') {",
    "    // Compact: single line, no wrap, no truncation — terminal clips naturally",
    "    for (const line of physicalLines) {",
    "      console.log(`${RESET}${line}`);",
    "    }",
    "  } else {",
    "    const visibleLines = physicalLines.flatMap(line => wrapLineToWidth(line, wrapWidth));",
    "    for (const line of visibleLines) {",
    "      console.log(`${RESET}${line}`);",
    "    }",
    "  }",
])

if original not in content:
    print("⚠️  [compact-nowrap] 원본 패턴 불일치 — 수동 확인 필요")
    raise SystemExit(1)

content = content.replace(original, patched, 1)
target.write_text(content)
print("✅ [compact-nowrap] 패치 적용 완료")
PYEOF
