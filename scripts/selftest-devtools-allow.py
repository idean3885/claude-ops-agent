#!/usr/bin/env python3
"""devtools-allow.py 자체 점검. 가짜 설정 파일과 가짜 claude CLI 로 돈다.

    python3 scripts/selftest-devtools-allow.py

점검: 가장 가까운 로컬 등록 선택 · 사용자 범위 대체 · 중복 패턴 noop · scheme 없는 패턴 거부 ·
CLI 호출 순서(remove → add-json, 같은 범위 · 같은 디렉토리) · add 실패 시 원래 등록 복원 ·
격리 인자 보강 · --check 의 빠진 등록 보고와 고칠 명령.
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
case "$*" in *remove*) [ -n "$FAKE_REMOVE_FAIL" ] && exit 1 ;; esac
case "$*" in *add-json*) [ -n "$FAKE_ADD_FAIL_ALL" ] && exit 1; [ -n "$FAKE_ADD_FAIL" ] && [ ! -f "$FAKE_LOG.failed" ] && { touch "$FAKE_LOG.failed"; exit 1; } ;; esac
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
    env = {**os.environ, "CLAUDE_CONFIG_JSON": cpath, "FAKE_LOG": log, "DEVTOOLS_ALLOW_SELF": SCRIPT,
           "PATH": os.path.join(tmp, "bin") + os.pathsep + os.environ["PATH"]}
    env.update(env_extra or {})
    env = {k: v for k, v in env.items() if v is not None}
    r = subprocess.run(args if args and args[0] == sys.executable else [sys.executable, SCRIPT, *args],
                       cwd=cwd, env=env, capture_output=True, text=True)
    calls = open(log).read().splitlines() if os.path.exists(log) else []
    if not r.stdout.strip():
        raise SystemExit(f"no output: {args} {r.stderr}")
    return r.returncode, json.loads(r.stdout), calls


with tempfile.TemporaryDirectory() as tmp:
    tmp = os.path.realpath(tmp)
    os.makedirs(os.path.join(tmp, "bin"))
    fake = os.path.join(tmp, "bin", "claude")
    with open(fake, "w") as f:
        f.write(FAKE_CLAUDE)
    os.chmod(fake, 0o755)
    org = os.path.join(tmp, "org")
    repo = os.path.join(org, "repo")
    sub = os.path.join(repo, "pkg")
    os.makedirs(sub)
    entry = {"type": "stdio", "command": "npx", "args": BASE, "env": {"K": "v"}}
    conf = {"projects": {org: {"mcpServers": {"chrome-devtools": entry}}},
            "mcpServers": {"chrome-devtools": {**entry, "args": ["-y", "x"]}}}

    rc, out, calls = run(tmp, conf, ["http://127.0.0.1:*/*"], sub)
    check("하위 디렉토리에서 가장 가까운 로컬 등록을 고른다", out.get("scope") == "local" and out.get("project") == org, out)
    check("패턴을 뒤에 더한다", out["args"][-2:] == ["--allowedUrlPattern", "http://127.0.0.1:*/*"], out["args"])
    check("기존 인자를 보존한다", out["args"][:len(BASE)] == BASE)
    check("remove → add-json 순서로 같은 범위 · 등록 디렉토리에서 부른다",
          len(calls) == 2 and calls[0] == f"{org}|mcp remove chrome-devtools -s local"
          and calls[1].startswith(f"{org}|mcp add-json chrome-devtools ") and calls[1].endswith(" -s local"), calls)
    sent = json.loads(calls[1].split("|", 1)[1][len("mcp add-json chrome-devtools "):-len(" -s local")])
    check("CLI 에 넘긴 등록은 패턴을 더한 인자이고 type · command · env 를 보존한다",
          sent == {**entry, "args": BASE + ["--allowedUrlPattern", "http://127.0.0.1:*/*"]}, sent)
    check("성공 출력에 다시 연결 안내가 있다", out.get("next") == "/mcp → chrome-devtools → Reconnect", out)

    near = {**entry, "args": BASE + ["--allowedUrlPattern", "https://near/*"]}
    nested = {"projects": {org: {"mcpServers": {"chrome-devtools": entry}},
                           repo: {"mcpServers": {"chrome-devtools": near}}}}
    rc, out, calls = run(tmp, nested, ["http://n/*"], sub)
    check("상위에 등록이 둘이면 더 가까운 등록을 고친다",
          out.get("project") == repo and calls and calls[0].startswith(f"{repo}|"), (out, calls))
    rc, out, calls = run(tmp, nested, ["--project", org, "http://n/*"], sub)
    check("--project 로 시작 디렉토리를 지정한다", out.get("project") == org, out)

    other_srv = {"projects": {org: {"mcpServers": {"devtools-b": entry}}}}
    rc, out, calls = run(tmp, other_srv, ["--server", "devtools-b", "http://s/*"], sub)
    check("--server 로 다른 이름의 등록을 고치고 다시 연결 안내도 그 이름이다",
          out["status"] == "ok" and calls[0] == f"{org}|mcp remove devtools-b -s local"
          and out.get("next") == "/mcp → devtools-b → Reconnect", (out, calls))
    bare_b = {"projects": {org: {"mcpServers": {"devtools-b": {**entry, "args": ["-y", "chrome-devtools-mcp@1.9.0"]}}}}}
    rc, out, calls = run(tmp, bare_b, ["--check", "--server", "devtools-b"], sub)
    fixb = out["missing"][0]["fix"] if out.get("missing") else ""
    rc, out, calls = run(tmp, bare_b, [sys.executable, *__import__("shlex").split(fixb)[1:]], sub)
    check("--check 의 고칠 명령은 --server 를 담아 그 등록을 고친다",
          "--server devtools-b" in fixb and out.get("status") == "ok" and calls[0].endswith("remove devtools-b -s local"), (fixb, out))
    rc, out, calls = run(tmp, bare_b, ["--check", "--server", "devtools-b"], sub, {"DEVTOOLS_ALLOW_SELF": None})
    check("고칠 명령의 경로는 버전 없는 고정 경로다",
          out["missing"][0]["fix"].startswith("python3 ~/.claude/ops-agent/current/scripts/devtools-allow.py "), out)

    fixed = {"projects": {org: {"mcpServers": {"chrome-devtools": {**entry, "args": BASE + ["--userDataDir", "/p", "--user-data-dir=/q"]}}}}}
    rc, out, calls = run(tmp, fixed, ["--check"], sub)
    check("--check 는 격리 인자가 있어도 고정 프로필을 지정한 등록을 낸다",
          rc == 1 and out["missing"][0]["problem"] == "fixed-profile", (rc, out))
    rc, out, calls = run(tmp, fixed, [], sub)
    check("다시 등록하면 고정 프로필 인자를 걷고 걷은 인자를 출력한다",
          out["status"] == "ok" and out["args"] == BASE
          and out["profile_removed"] == ["--userDataDir", "/p", "--user-data-dir=/q"], out)

    conn = {"projects": {org: {"mcpServers": {"chrome-devtools": {**entry, "args": ["-y", "chrome-devtools-mcp@1.9.0", "--autoConnect"]}}}}}
    rc, out, calls = run(tmp, conn, ["--check"], sub)
    check("--check 는 떠 있는 브라우저에 붙는 등록에 제거 명령을 고칠 명령으로 낸다",
          rc == 1 and out["missing"][0]["problem"] == "connect"
          and out["missing"][0]["fix"] == f"cd '{org}' && claude mcp remove chrome-devtools -s local", (rc, out))
    for form in (["--browser-url=http://127.0.0.1:9222"], ["-u", "http://127.0.0.1:9222"],
                 ["--wsEndpoint", "ws://x"], ["-w", "ws://x"]):
        c = {"projects": {org: {"mcpServers": {"chrome-devtools": {**entry, "args": BASE + form}}}}}
        rc, out, calls = run(tmp, c, ["--check"], sub)
        check(f"붙는 등록 형태 {form[0]} 를 connect 로 판정한다",
              rc == 1 and out["missing"][0]["problem"] == "connect", (form, out))
    for form in (["--no-isolated"], ["--isolated=false"], ["--isolated", "false"]):
        c = {"projects": {org: {"mcpServers": {"chrome-devtools": {**entry, "args": ["-y", "chrome-devtools-mcp@1.9.0", *form]}}}}}
        rc, out, calls = run(tmp, c, ["--check"], sub)
        ok1 = rc == 1 and out["missing"][0]["problem"] == "disabled"
        rc, out, calls = run(tmp, c, [], sub)
        check(f"격리를 끈 형태 {' '.join(form)} 를 잡고 다시 등록하면 --isolated 로 바꾼다",
              ok1 and out["args"] == ["-y", "chrome-devtools-mcp@1.9.0", "--isolated"] and out["profile_removed"] == form, out)
    rc, out, calls = run(tmp, conn, ["http://c/*"], sub)
    check("떠 있는 브라우저에 붙는 등록에는 격리 인자를 넣지 않고 종료 2",
          rc == 2 and out.get("step") == "connect" and not calls, (rc, out, calls))

    blk = {"projects": {org: {"mcpServers": {"chrome-devtools": {**entry, "args": BASE + ["--blockedUrlPattern", "https://b/*"]}}}}}
    rc, out, calls = run(tmp, blk, ["http://c/*"], sub)
    check("차단 패턴이 있는 등록에는 허용 패턴을 더하지 않고 종료 2",
          rc == 2 and out.get("step") == "blocked" and not calls, (rc, out, calls))
    blk2 = {"projects": {org: {"mcpServers": {"chrome-devtools": {**entry, "args": ["-y", "chrome-devtools-mcp@1.9.0", "--blocked-url-pattern=https://b/*"]}}}}}
    rc, out, calls = run(tmp, blk2, ["http://c/*"], sub)
    check("차단 패턴의 --blocked-url-pattern= 형태도 막는다", rc == 2 and out.get("step") == "blocked", (rc, out))
    rc, out, calls = run(tmp, blk2, [], sub)
    check("차단 패턴이 있어도 패턴 없이 부르면 격리만 맞춘다", out["status"] == "ok" and out["isolated_added"] is True, out)

    eq = {"projects": {org: {"mcpServers": {"chrome-devtools": {**entry, "args": BASE + ["--allowedUrlPattern=https://e/*"]}}}}}
    rc, out, calls = run(tmp, eq, ["https://e/*"], sub)
    check("= 형태로 이미 있는 패턴도 noop", out["status"] == "noop" and not calls, (out, calls))
    kb = {"projects": {org: {"mcpServers": {"chrome-devtools": {**entry, "args": BASE + ["--allowed-url-pattern", "https://k/*"]}}}}}
    rc, out, calls = run(tmp, kb, ["https://k/*"], sub)
    check("--allowed-url-pattern 형태로 이미 있는 패턴도 noop", out["status"] == "noop" and not calls, (out, calls))

    rc, out, calls = run(tmp, conf, ["http://m/*"], sub, {"CLAUDE_CONFIG_JSON": os.path.join(tmp, "nope.json")})
    check("등록을 바꿀 때도 설정 파일이 없으면 JSON 오류로 종료 2", rc == 2 and out.get("step") == "config" and not calls, (rc, out))

    rc, out, calls = run(tmp, conf, ["http://r/*"], sub, {"FAKE_REMOVE_FAIL": "1"})
    check("제거가 실패하면 등록하지 않고 종료 2", rc == 2 and out.get("step") == "remove" and len(calls) == 1, (rc, out, calls))

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
    check("add 실패 시 원래 등록을 같은 범위 · 등록 디렉토리에 복원한다",
          rc == 2 and out.get("restored") is True and len(calls) == 3 and json.dumps(entry) in restored
          and calls[-1].startswith(f"{org}|") and calls[-1].endswith(" -s local"), (rc, out, calls))

    rc, out, calls = run(tmp, conf, ["http://z/*"], sub, {"FAKE_ADD_FAIL_ALL": "1"})
    check("복원도 실패하면 restored 가 거짓이고 원래 등록을 출력한다",
          rc == 2 and out.get("restored") is False and out.get("original") == entry, (rc, out))

    bare = {"type": "stdio", "command": "npx", "args": ["-y", "chrome-devtools-mcp@1.9.0", "--allowedUrlPattern", "https://a.example/*"], "env": {}}
    conf2 = {"projects": {org: {"mcpServers": {"chrome-devtools": bare}}}}
    rc, out, calls = run(tmp, conf2, ["http://w/*"], sub)
    check("격리 인자가 없으면 패키지 바로 뒤에 넣는다",
          out.get("isolated_added") is True and out["args"][:3] == ["-y", "chrome-devtools-mcp@1.9.0", "--isolated"], out)
    rc, out, calls = run(tmp, conf2, [], sub)
    check("패턴 없이 부르면 격리 인자만 맞추고 다시 등록한다",
          out["status"] == "ok" and out["added"] == [] and out["isolated_added"] is True and len(calls) == 2, (out, calls))
    rc, out, calls = run(tmp, conf, [], sub)
    check("격리 인자가 있고 패턴이 없으면 noop", out["status"] == "noop" and not calls, (out, calls))

    conf3 = {"projects": {org: {"mcpServers": {"chrome-devtools": entry}},
                          os.path.join(tmp, "other"): {"mcpServers": {"chrome-devtools": bare}}},
             "mcpServers": {"chrome-devtools": {**bare}}}
    os.makedirs(os.path.join(tmp, "other"))
    rc, out, calls = run(tmp, conf3, ["--check"], sub)
    miss = {(m["scope"], m["project"]) for m in out.get("missing", [])}
    check("--check 는 격리 인자가 빠진 등록만 모두 낸다 (종료 1, CLI 를 부르지 않음)",
          rc == 1 and miss == {("local", os.path.join(tmp, "other")), ("user", None)} and not calls, (rc, out, calls))
    out_missing = out["missing"]
    fix = next(m["fix"] for m in out_missing if m["scope"] == "local")
    rc, out, calls = run(tmp, conf3, [sys.executable, *__import__("shlex").split(fix)[1:]], sub)
    check("--check 가 낸 고칠 명령은 그 등록에 격리 인자를 넣는다",
          out["status"] == "ok" and out["project"] == os.path.join(tmp, "other") and out["isolated_added"] is True, (fix, out))
    fix = next(m["fix"] for m in out_missing if m["scope"] == "user")
    rc, out, calls = run(tmp, conf3, [sys.executable, *__import__("shlex").split(fix)[1:]], org)
    check("사용자 범위의 고칠 명령은 로컬 등록이 있는 디렉토리에서도 사용자 범위를 고친다",
          out["status"] == "ok" and out["scope"] == "user" and calls[0].endswith("-s user"), (fix, out, calls))
    conf4 = {"projects": conf["projects"], "mcpServers": {"chrome-devtools": entry}}
    rc, out, calls = run(tmp, conf4, ["--check"], sub)
    check("--check 는 모두 격리면 통과 (종료 0)", rc == 0 and out["status"] == "ok" and out["checked"] == 2, (rc, out))
    only_gone = {"projects": {os.path.join(tmp, "gone"): {"mcpServers": {"chrome-devtools": bare}}}}
    rc, out, calls = run(tmp, only_gone, ["--check"], sub)
    check("--check 는 지워진 디렉토리 등록만 있으면 쓸 수 있는 등록이 없어 종료 2",
          rc == 2 and out["status"] == "none", (rc, out))
    gone = {"projects": {os.path.join(tmp, "gone"): {"mcpServers": {"chrome-devtools": bare}},
                         org: {"mcpServers": {"chrome-devtools": entry}}}}
    rc, out, calls = run(tmp, gone, ["--check"], sub)
    check("--check 는 지워진 디렉토리의 등록을 막지 않고 stale 로 알린다",
          rc == 0 and out["status"] == "ok" and out.get("stale") == [{"scope": "local", "project": os.path.join(tmp, "gone")}], (rc, out))
    rc, out, calls = run(tmp, gone, ["--project", os.path.join(tmp, "gone")], sub)
    check("등록 디렉토리가 지워졌으면 CLI 를 부르지 않고 종료 2", rc == 2 and out.get("step") == "cwd" and not calls, (rc, out, calls))
    rc, out, calls = run(tmp, {"projects": {}}, ["--check"], sub, {"CLAUDE_CONFIG_JSON": os.path.join(tmp, "nope.json")})
    check("설정 파일이 없으면 JSON 오류로 종료 2", rc == 2 and out["status"] == "error", (rc, out))
    rc, out, calls = run(tmp, {"projects": {}}, ["--check"], sub)
    check("--check 는 등록이 없으면 종료 2", rc == 2 and out["status"] == "none", (rc, out))

    rc, out, calls = run(tmp, {"projects": {}}, ["http://z/*"], sub)
    check("등록이 없으면 종료 코드 2", rc == 2 and out["status"] == "error", (rc, out))

print(f"\n{'PASS' if not fails else 'FAIL'} ({fails} failed)")
sys.exit(1 if fails else 0)
