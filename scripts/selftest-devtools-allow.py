#!/usr/bin/env python3
"""devtools-allow.py 자체 점검. 가짜 설정 파일과 가짜 claude CLI 로 돈다.

    python3 scripts/selftest-devtools-allow.py

점검: 가장 가까운 로컬 등록 선택 · 사용자 범위 대체 · 중복 패턴 noop · scheme 없는 패턴 거부 ·
CLI 호출 순서(remove → add-json, 같은 범위 · 같은 디렉토리) · add 실패 시 원래 등록 복원.
"""

import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "devtools-allow.py")
BASE = ["-y", "chrome-devtools-mcp@1.9.0", "--isolated", "--allowedUrlPattern", "https://a.example/*"]

FAKE_CLAUDE = """#!/bin/sh
echo "$(pwd -P)|$*" >> "$FAKE_LOG"
case "$*" in *add-json*) [ -n "$FAKE_ADD_FAIL" ] && [ ! -f "$FAKE_LOG.failed" ] && { touch "$FAKE_LOG.failed"; exit 1; } ;; esac
exit 0
"""

fails = 0


def check(name, cond, detail=""):
    global fails
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else f"  {detail}"))
    if not cond:
        fails += 1


def run(tmp, conf, args, cwd, env_extra=None):
    cpath = os.path.join(tmp, "claude.json")
    with open(cpath, "w") as f:
        json.dump(conf, f)
    log = os.path.join(tmp, "cli.log")
    for p in (log, log + ".failed"):
        if os.path.exists(p):
            os.remove(p)
    env = {**os.environ, "CLAUDE_CONFIG_JSON": cpath, "FAKE_LOG": log,
           "PATH": os.path.join(tmp, "bin") + os.pathsep + os.environ["PATH"]}
    env.update(env_extra or {})
    r = subprocess.run([sys.executable, SCRIPT, *args], cwd=cwd, env=env, capture_output=True, text=True)
    calls = open(log).read().splitlines() if os.path.exists(log) else []
    return r.returncode, json.loads(r.stdout), calls


with tempfile.TemporaryDirectory() as tmp:
    tmp = os.path.realpath(tmp)
    os.makedirs(os.path.join(tmp, "bin"))
    fake = os.path.join(tmp, "bin", "claude")
    with open(fake, "w") as f:
        f.write(FAKE_CLAUDE)
    os.chmod(fake, 0o755)
    org = os.path.join(tmp, "org")
    sub = os.path.join(org, "repo", "pkg")
    os.makedirs(sub)
    entry = {"type": "stdio", "command": "npx", "args": BASE, "env": {}}
    conf = {"projects": {org: {"mcpServers": {"chrome-devtools": entry}}},
            "mcpServers": {"chrome-devtools": {**entry, "args": ["-y", "x"]}}}

    rc, out, calls = run(tmp, conf, ["http://127.0.0.1:*/*"], sub)
    check("하위 디렉토리에서 가장 가까운 로컬 등록을 고른다", out.get("scope") == "local" and out.get("project") == org, out)
    check("패턴을 뒤에 더한다", out["args"][-2:] == ["--allowedUrlPattern", "http://127.0.0.1:*/*"], out["args"])
    check("기존 인자를 보존한다", out["args"][:len(BASE)] == BASE)
    check("remove → add-json 순서로 같은 범위 · 등록 디렉토리에서 부른다",
          len(calls) == 2 and calls[0] == f"{org}|mcp remove chrome-devtools -s local"
          and calls[1].startswith(f"{org}|mcp add-json chrome-devtools ") and calls[1].endswith(" -s local"), calls)

    rc, out, calls = run(tmp, conf, ["https://a.example/*"], sub)
    check("이미 있는 패턴은 noop 이고 CLI 를 부르지 않는다", out["status"] == "noop" and not calls, (out, calls))

    rc, out, calls = run(tmp, conf, ["http://127.0.0.1:*/*", "http://127.0.0.1:*/*"], sub, )
    check("같은 패턴을 두 번 넘겨도 한 번만 더한다", out["added"] == ["http://127.0.0.1:*/*"], out)

    rc, out, calls = run(tmp, conf, ["http://x/*"], tmp)
    check("로컬 등록이 없으면 사용자 범위를 쓴다", out.get("scope") == "user" and calls[0].endswith("-s user"), (out, calls))

    rc, out, calls = run(tmp, conf, ["127.0.0.1:*/*"], sub)
    check("scheme 없는 패턴은 거부한다", rc == 1 and out["status"] == "error" and not calls, (rc, out))

    rc, out, calls = run(tmp, conf, ["http://y/*", "--dry-run"], sub)
    check("dry-run 은 CLI 를 부르지 않는다", out["status"] == "dry-run" and not calls, (out, calls))

    rc, out, calls = run(tmp, conf, ["http://z/*"], sub, {"FAKE_ADD_FAIL": "1"})
    restored = calls[-1].split("|", 1)[1] if calls else ""
    check("add 실패 시 원래 등록으로 복원한다",
          rc == 2 and out.get("restored") and len(calls) == 3 and json.dumps(entry) in restored, (rc, out, calls))

    rc, out, calls = run(tmp, {"projects": {}}, ["http://z/*"], sub)
    check("등록이 없으면 종료 코드 2", rc == 2 and out["status"] == "error", (rc, out))

print(f"\n{'PASS' if not fails else 'FAIL'} ({fails} failed)")
sys.exit(1 if fails else 0)
