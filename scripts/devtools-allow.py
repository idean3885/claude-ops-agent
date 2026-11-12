#!/usr/bin/env python3
"""DevTools MCP 허용 URL 추가.

DevTools MCP(chrome-devtools-mcp) 등록의 `--allowedUrlPattern` 에 패턴을 더한다.
설정 파일을 직접 고치지 않고 Claude Code 공식 CLI(`claude mcp remove` → `claude mcp add-json`)
로 같은 범위에 다시 등록한다. 실행과 다시 연결(`/mcp` → chrome-devtools → Reconnect)은
사용자 몫이다. 에이전트는 이 명령을 만들어 건넨다 (docs/working-principles.md
「브라우저는 DevTools MCP 로만 쓴다」).

사용법:
  devtools-allow.py [--project <dir>] [--server <name>] [--dry-run] <pattern>...
    pattern    예: 'http://127.0.0.1:*/*'  'https://*.example.com/*'
    --project  등록을 찾을 시작 디렉토리 (기본: 현재 디렉토리). 위로 올라가며
               그 서버를 로컬 범위로 등록한 가장 가까운 프로젝트를 쓴다.
               없으면 사용자 범위 등록을 쓴다.
    --server   MCP 서버 이름 (기본: chrome-devtools)
    --dry-run  바꿀 내용만 출력하고 등록은 바꾸지 않는다

출력: JSON {status, scope, project, added[], already[], args}
  status: ok | noop | dry-run | error
종료 코드: 0 성공 · noop · dry-run, 1 인자 오류, 2 등록 없음 · CLI 실패

설정 파일 위치는 CLAUDE_CONFIG_JSON 으로 바꿀 수 있다 (테스트용).
"""

import argparse
import json
import os
import subprocess
import sys

FLAG = "--allowedUrlPattern"


def config_path():
    return os.environ.get("CLAUDE_CONFIG_JSON") or os.path.expanduser("~/.claude.json")


def find_entry(conf, start, server):
    """가장 가까운 로컬 범위 등록, 없으면 사용자 범위 등록을 찾는다."""
    projects = conf.get("projects", {})
    d = os.path.abspath(start)
    while True:
        entry = projects.get(d, {}).get("mcpServers", {}).get(server)
        if entry:
            return "local", d, entry
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    entry = conf.get("mcpServers", {}).get(server)
    if entry:
        return "user", None, entry
    return None, None, None


def existing_patterns(args):
    return [args[i + 1] for i, a in enumerate(args[:-1]) if a == FLAG]


def add_patterns(args, patterns):
    have = existing_patterns(args)
    added, already = [], []
    new_args = list(args)
    for p in patterns:
        if p in have or p in added:
            already.append(p)
            continue
        new_args += [FLAG, p]
        added.append(p)
    return new_args, added, already


def run_cli(cmd, cwd):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    return r.returncode, (r.stdout + r.stderr).strip()


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("patterns", nargs="+")
    ap.add_argument("--project", default=os.getcwd())
    ap.add_argument("--server", default="chrome-devtools")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    bad = [p for p in a.patterns if "://" not in p]
    if bad:
        print(json.dumps({"status": "error", "message": f"패턴은 scheme 을 포함해야 한다: {bad}"}, ensure_ascii=False))
        return 1

    with open(config_path()) as f:
        conf = json.load(f)
    scope, project, entry = find_entry(conf, a.project, a.server)
    if not entry:
        print(json.dumps({"status": "error", "message": f"{a.server} 등록을 찾지 못했다 (로컬 · 사용자 범위)"}, ensure_ascii=False))
        return 2

    new_args, added, already = add_patterns(entry.get("args", []), a.patterns)
    out = {"scope": scope, "project": project, "added": added, "already": already, "args": new_args}
    if not added:
        print(json.dumps({"status": "noop", **out}, ensure_ascii=False))
        return 0
    if a.dry_run:
        print(json.dumps({"status": "dry-run", **out}, ensure_ascii=False))
        return 0

    new_entry = {**entry, "args": new_args}
    cwd = project or os.path.expanduser("~")
    rc, msg = run_cli(["claude", "mcp", "remove", a.server, "-s", scope], cwd)
    if rc != 0:
        print(json.dumps({"status": "error", "step": "remove", "message": msg}, ensure_ascii=False))
        return 2
    rc, msg = run_cli(["claude", "mcp", "add-json", a.server, json.dumps(new_entry), "-s", scope], cwd)
    if rc != 0:
        # 지운 등록을 원래 값으로 되돌린다
        run_cli(["claude", "mcp", "add-json", a.server, json.dumps(entry), "-s", scope], cwd)
        print(json.dumps({"status": "error", "step": "add", "message": msg, "restored": True}, ensure_ascii=False))
        return 2
    print(json.dumps({"status": "ok", **out, "next": "/mcp → " + a.server + " → Reconnect"}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
