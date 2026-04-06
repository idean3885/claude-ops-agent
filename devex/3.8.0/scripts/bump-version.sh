#!/usr/bin/env bash
# bump-version.sh — 4곳 동시 버전 업데이트 (VERSION, CHANGELOG.md, plugin.json, marketplace.json)
# Usage: ./scripts/bump-version.sh <new_version> <changelog_entry>
# Example: ./scripts/bump-version.sh 3.7.4 "fix: 버전 동기화 스크립트 추가"
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ $# -lt 2 ]; then
  echo "Usage: $0 <version> <changelog_entry>"
  echo "Example: $0 3.7.4 'fix: 버전 동기화 스크립트 추가'"
  exit 1
fi

NEW_VERSION="$1"
CHANGELOG_ENTRY="$2"
TODAY=$(date +%Y-%m-%d)

# 1. VERSION
echo "$NEW_VERSION" > "$ROOT_DIR/VERSION"

# 2. plugin.json
python3 -c "
import json, pathlib
p = pathlib.Path('$ROOT_DIR/.claude-plugin/plugin.json')
d = json.loads(p.read_text())
d['version'] = '$NEW_VERSION'
p.write_text(json.dumps(d, indent=2, ensure_ascii=False) + '\n')
"

# 3. marketplace.json
python3 -c "
import json, pathlib
p = pathlib.Path('$ROOT_DIR/.claude-plugin/marketplace.json')
d = json.loads(p.read_text())
d['plugins'][0]['version'] = '$NEW_VERSION'
p.write_text(json.dumps(d, indent=2, ensure_ascii=False) + '\n')
"

# 4. CHANGELOG.md (prepend new entry after header)
python3 -c "
import pathlib
p = pathlib.Path('$ROOT_DIR/CHANGELOG.md')
content = p.read_text()
marker = '형식: [Semantic Versioning](https://semver.org/)'
entry = '''

## [$NEW_VERSION] - $TODAY

### Fixed
- $CHANGELOG_ENTRY'''
content = content.replace(marker, marker + entry, 1)
p.write_text(content)
"

# Verify all 4 files have the same version
V1=$(cat "$ROOT_DIR/VERSION")
V2=$(python3 -c "import json; print(json.load(open('$ROOT_DIR/.claude-plugin/plugin.json'))['version'])")
V3=$(python3 -c "import json; print(json.load(open('$ROOT_DIR/.claude-plugin/marketplace.json'))['plugins'][0]['version'])")
V4=$(grep -m1 '^\## \[' "$ROOT_DIR/CHANGELOG.md" | sed 's/.*\[\(.*\)\].*/\1/')

if [ "$V1" = "$NEW_VERSION" ] && [ "$V2" = "$NEW_VERSION" ] && [ "$V3" = "$NEW_VERSION" ] && [ "$V4" = "$NEW_VERSION" ]; then
  echo "✔ All 4 files updated to $NEW_VERSION"
else
  echo "✘ Version mismatch detected!"
  echo "  VERSION:          $V1"
  echo "  plugin.json:      $V2"
  echo "  marketplace.json: $V3"
  echo "  CHANGELOG.md:     $V4"
  exit 1
fi
