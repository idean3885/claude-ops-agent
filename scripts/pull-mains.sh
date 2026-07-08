#!/bin/bash
# org-flow: 메인 클론 일괄 pull
#
# 사상: 프로젝트 루트 하위에 워크트리와 별도로 메인 클론(working tree) 디렉토리를 유지하는 org 가 있다.
# 그 메인 클론은 분석 참조용이므로, 작업·분석 시작 시 stale 본문은 잘못된 결론을 만든다.
# /org-flow start 직후 자동으로 일괄 pull 하여 stale 위험을 차단한다.
#
# 사용법:
#   ./pull-mains.sh [project-root]
#   project-root 미지정 시 cwd 에서 .ops-agent/project.json 위로 탐색
#
# 동작:
#   - .ops-agent/project.json 의 repos.* 순회
#   - 각 항목의 path 가 working tree(.git 디렉토리 보유) 인 경우만 처리
#   - dirty: 자동 stash 금지, "dirty-skip" 보고
#   - 현재 브랜치 ≠ base: git checkout base 후 ff-only pull
#   - bare clone, 미존재, 워크트리 디렉토리는 skip
#
# 출력: JSON ({"status":"ok","root":"...","results":[{"repo":...,"status":...}, ...]})

set -euo pipefail

find_project_root() {
  local dir="$1"
  while [ "$dir" != "/" ]; do
    [ -f "$dir/.ops-agent/project.json" ] && echo "$dir" && return
    dir="$(dirname "$dir")"
  done
  echo ""
}

ROOT="${1:-}"
if [ -z "$ROOT" ]; then
  ROOT="$(find_project_root "$(pwd)")"
fi

if [ -z "$ROOT" ] || [ ! -f "$ROOT/.ops-agent/project.json" ]; then
  echo '{"status":"error","message":".ops-agent/project.json 탐색 실패"}' >&2
  exit 1
fi

python3 - "$ROOT" <<'PY'
import json, os, subprocess, sys
root = sys.argv[1]
manifest = json.load(open(os.path.join(root, ".ops-agent/project.json")))
results = []
for name, info in manifest.get("repos", {}).items():
    path = os.path.join(root, info.get("path", name))
    base = info.get("base", "main")
    entry = {"repo": name, "path": path, "base": base}
    if not os.path.isdir(path):
        entry["status"] = "absent"
        results.append(entry)
        continue
    if not os.path.isdir(os.path.join(path, ".git")):
        entry["status"] = "no-working-tree"
        results.append(entry)
        continue
    porcelain = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=path, capture_output=True, text=True,
    )
    if porcelain.stdout.strip():
        entry["status"] = "dirty-skip"
        entry["dirty_count"] = len(porcelain.stdout.strip().splitlines())
        results.append(entry)
        continue
    fetch = subprocess.run(
        ["git", "fetch", "origin", "--quiet"],
        cwd=path, capture_output=True, text=True,
    )
    if fetch.returncode != 0:
        entry["status"] = "fetch-failed"
        entry["stderr"] = fetch.stderr.strip()[:200]
        results.append(entry)
        continue
    cur = subprocess.run(
        ["git", "symbolic-ref", "--short", "HEAD"],
        cwd=path, capture_output=True, text=True,
    ).stdout.strip()
    if cur != base:
        co = subprocess.run(
            ["git", "checkout", base],
            cwd=path, capture_output=True, text=True,
        )
        if co.returncode != 0:
            entry["status"] = "checkout-failed"
            entry["from"] = cur
            entry["stderr"] = co.stderr.strip()[:200]
            results.append(entry)
            continue
        entry["switched_from"] = cur
    pull = subprocess.run(
        ["git", "pull", "--ff-only", "origin", base],
        cwd=path, capture_output=True, text=True,
    )
    if pull.returncode != 0:
        entry["status"] = "pull-failed"
        entry["stderr"] = pull.stderr.strip()[:200]
    else:
        out = pull.stdout.strip()
        entry["status"] = "already-up-to-date" if "Already up to date" in out else "updated"
    results.append(entry)
print(json.dumps({"status": "ok", "root": root, "results": results}, ensure_ascii=False))
PY
