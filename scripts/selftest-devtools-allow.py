#!/usr/bin/env python3
"""devtools-allow.py 자체 점검. 가짜 설정 파일과 가짜 claude CLI 로 돈다.

    python3 scripts/selftest-devtools-allow.py

점검: 가장 가까운 로컬 등록 선택 · 사용자 범위 대체 · 중복 패턴 noop · scheme 없는 패턴 거부 ·
CLI 호출 순서(remove → add-json, 같은 범위 · 같은 디렉토리) · add 실패 시 원래 등록 복원 ·
격리 인자 보강 · --check 의 빠진 등록 보고와 고칠 명령.
"""

import json
import os
import re
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


# 받아야 하는 패턴. 소비 측(chrome-devtools-mcp 의 URLPattern)이 스크립트가 판정한 scheme · 호스트와 같게 해석하는지 아래에서 대조한다
ACCEPTED = ["https://*.example.com/*", "http://localhost:*/*", "http://127.0.0.1:8080/*", "https://a_b.example.com/*",
            "https://xn--bj0bj06e.example.com/*", "https://a.example.com", "https://a.example.com/path/*",
            "https://XN--BJ0BJ06E.example.com/*", "chrome-extension://abc/*", "https://a.example.com/%7Ea~b/*",
            "HTTPS://A.EXAMPLE.COM/*", "https://a.example.com:443/*", "http://a.example.com:80/*"]
# 형식은 통과하지만 소비 측 URLPattern 이 만들지 못하는 패턴. 스크립트가 같은 해석기로 확인해 거부해야 한다 (#1021 2회차)
CONSUMER_REJECTED = ["https://a.example.com:080/*", "https://a.example.com:\u0668\u0660/*", "https://a.example.com:\uff18\uff10/*",
                     "https://a_b.3/*", "https://*.1_2.3/*", "https://XN--A.com/*",
                     # 예외 없이 다르게 해석되는 것: 호스트가 127.0.0.1 로 접힘 · 포트가 1 로 접힘
                     "https://0x7F000001/*", "https://a.example.com:1\uff12/*"]
# 거부해야 하는 패턴. 스크립트 판정과 소비 측 해석이 어긋나 우회가 되던 표기를 포함한다 (#1014 · #1018 · #1021)
REJECTED = ["https://*/*", "https://*.com/*", "https://*", "http://a*.example.com/*", "https://*.*.example.com/*",
            "https://*ab.example.com/*", "https://a*b.example.com/*", "https://*..com/*", "https://u:p@*/*",
            "https://:host/*", "https://:sub.example.com/*", "https://(.*)/*", "https://{a.}?example.com/*",
            "https://a+.example.com/*", "https://([a-z]+).example.com/*", "https://a?.example.com/*", "https://{a}.example.com/*",
            "https://a..com/*", "https://a\\.example.com/*", "http://[::1]:*/*",
            "https:*://a.example.com/*", "https:(.*)://a.example.com/*", "*://a.example.com/*", "http+://a.example.com/*",
            "http*://a.example.com/*", "h(.*)://a.example.com/*", "1http://a.example.com/*",
            "https://*#@a.example.com/*", "https://evil.test?@a.example.com/*", "https://u:p@a.example.com/*",
            "https://{@a.example.com/*", "https://a.example.com/(", "https://a.example.com:99999/*",
            "https://한글.example.com/*", "https://a.example.com/*?x", "https://a.example.com/#*",
            "https://a.example.com/a:b", "https://a.example.com/{a}", "https://a.example.com/a+", "https://a.example.com/a\\b",
            "https://a.example.com:65536/*", "https://a.example.com:0/*"]


def urlpattern_hosts(patterns):
    """node 의 URLPattern 으로 patterns 를 만들어 [protocol, hostname] 또는 None(예외)을 돌려준다. 쓸 수 없으면 None"""
    js = ("const ps=JSON.parse(process.argv[1]);if(typeof URLPattern!=='function'){console.log('null');process.exit(0)}"
          "console.log(JSON.stringify(ps.map(p=>{try{const u=new URLPattern(p);return [u.protocol,u.hostname]}catch(e){return null}})))")
    try:
        r = subprocess.run(["node", "-e", js, json.dumps(patterns)], capture_output=True, text=True, timeout=30)
        return json.loads(r.stdout) if r.returncode == 0 else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def same_as_consumer(pattern, consumer):
    """스크립트가 판정한 scheme · 호스트와 소비 측 해석이 같으면 True"""
    m = re.fullmatch(r"([^:/]+)://([^:/]+).*", pattern)
    return consumer is not None and m is not None and consumer == [m[1].lower(), m[2].lower()]


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
    check("패턴을 뒤에 더한다", out["args"][-3:-1] == ["--allowedUrlPattern", "http://127.0.0.1:*/*"], out["args"])
    check("기존 인자를 보존한다", out["args"][:len(BASE)] == BASE)
    check("remove → add-json 순서로 같은 범위 · 등록 디렉토리에서 부른다",
          len(calls) == 2 and calls[0] == f"{org}|mcp remove chrome-devtools -s local"
          and calls[1].startswith(f"{org}|mcp add-json chrome-devtools ") and calls[1].endswith(" -s local"), calls)
    sent = json.loads(calls[1].split("|", 1)[1][len("mcp add-json chrome-devtools "):-len(" -s local")])
    check("CLI 에 넘긴 등록은 패턴을 더한 인자이고 type · command · env 를 보존한다",
          sent == {**entry, "args": BASE + ["--allowedUrlPattern", "http://127.0.0.1:*/*", "--chromeArg=--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable"]}, sent)
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

    for wide in REJECTED:
        rc, out, calls = run(tmp, conf, [wide], sub)
        check(f"받는 형식 밖의 패턴은 거부한다: {wide}", rc == 1 and out.get("step") == "broad" and not calls, (rc, out, calls))
    for odd in CONSUMER_REJECTED:
        rc, out, calls = run(tmp, conf, [odd], sub)
        check(f"URLPattern 이 만들지 못하는 패턴은 거부한다: {odd}", rc == 1 and out.get("step") == "consumer" and not calls, (rc, out, calls))
    rc, out, calls = run(tmp, conf, ["https://a.example.com/*"], sub, {"DEVTOOLS_ALLOW_NODE": os.path.join(tmp, "no-node")})
    check("node 가 없으면 패턴을 받지 않고 종료 2", rc == 2 and out.get("step") == "node" and not calls, (rc, out, calls))
    for name, body in (("node3", "exit 3"), ("nodee", "echo '[]'"), ("nodeg", "echo 'not json'")):
        fake = os.path.join(tmp, name)
        with open(fake, "w") as f:
            f.write(f"#!/bin/sh\n{body}\n")
        os.chmod(fake, 0o755)
        rc, out, calls = run(tmp, conf, ["https://a.example.com/*", "https://b.example.com/*"], sub, {"DEVTOOLS_ALLOW_NODE": fake})
        check(f"URLPattern 확인이 비정상이면 받지 않고 종료 2: {body}", rc == 2 and out.get("step") == "node" and not calls, (rc, out, calls))
    # URLPattern 이 없는 node: 전역을 지운 뒤 실제 node 로 실행한다
    nourl = os.path.join(tmp, "nourl.js")
    with open(nourl, "w") as f:
        f.write("delete globalThis.URLPattern;\n")
    fake = os.path.join(tmp, "node-nourl")
    with open(fake, "w") as f:
        f.write(f'#!/bin/sh\nexec node -r "{nourl}" "$@"\n')
    os.chmod(fake, 0o755)
    rc, out, calls = run(tmp, conf, ["https://a.example.com/*"], sub, {"DEVTOOLS_ALLOW_NODE": fake})
    check("node 에 URLPattern 이 없으면 받지 않고 종료 2", rc == 2 and out.get("step") == "node" and not calls, (rc, out, calls))
    # scheme 만 다르게 해석하는 소비 측: 실제 node 에서는 나오지 않아 가짜 응답으로 비교 자체를 시험한다
    fake = os.path.join(tmp, "node-scheme")
    with open(fake, "w") as f:
        f.write("#!/bin/sh\necho '[[\"http\",\"a.example.com\",\"\"]]'\n")
    os.chmod(fake, 0o755)
    rc, out, calls = run(tmp, conf, ["https://a.example.com/*"], sub, {"DEVTOOLS_ALLOW_NODE": fake})
    check("소비 측이 scheme 을 다르게 해석하면 거부한다", rc == 1 and out.get("step") == "consumer" and not calls, (rc, out, calls))
    rc, out, calls = run(tmp, conf, ACCEPTED + ["--dry-run"], sub)
    check("고정 호스트 · 도메인이 고정된 와일드카드 · 포트(기본 포트 포함) · IPv4 · 밑줄 · punycode · 대문자 · 경로 생략은 받는다", rc == 0 and out["status"] == "dry-run", (rc, out))

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

    # --lang (#1001): 기존 등록을 복사해 언어 인자를 단 서버를 같은 범위에 더하고, 기존 등록은 건드리지 않는다
    rc, out, calls = run(tmp, conf, ["--lang", "en-US"], sub)
    check("--lang 은 <server>-<code> 를 같은 범위 · 등록 디렉토리에 add-json 만 부른다",
          rc == 0 and out["server"] == "chrome-devtools-en-US" and len(calls) == 1
          and calls[0].startswith(f"{org}|mcp add-json chrome-devtools-en-US ") and calls[0].endswith(" -s local"), (rc, out, calls))
    sent = json.loads(calls[0].split("|", 1)[1][len("mcp add-json chrome-devtools-en-US "):-len(" -s local")]) if calls else {}
    check("--lang 은 기존 인자 뒤에 Chrome 언어 · Accept-Language 인자를 단다",
          sent.get("args", [])[:len(BASE)] == BASE
          and sent.get("args", [])[-2:] == ["--chromeArg=--lang=en-US", "--chromeArg=--accept-lang=en-US,en"]
          and sent.get("env") == {"K": "v"}, sent)
    same = {**conf, "projects": {org: {"mcpServers": {"chrome-devtools": entry, "chrome-devtools-ja": {**entry, "args": BASE + ["--chromeArg=--lang=ja", "--chromeArg=--accept-lang=ja"]}}}}}
    rc, out, calls = run(tmp, same, ["--lang", "ja"], sub)
    check("--lang 은 같은 등록이 있으면 noop", rc == 0 and out["status"] == "noop" and not calls, (rc, out, calls))
    stale_lang = {**conf, "projects": {org: {"mcpServers": {"chrome-devtools": entry, "chrome-devtools-ja": {**entry, "args": ["-y", "old"]}}}}}
    rc, out, calls = run(tmp, stale_lang, ["--lang", "ja"], sub)
    check("--lang 은 낡은 언어 등록이면 지우고 다시 단다",
          rc == 0 and len(calls) == 2 and calls[0] == f"{org}|mcp remove chrome-devtools-ja -s local" and "add-json chrome-devtools-ja" in calls[1], (rc, calls))
    rc, out, calls = run(tmp, stale_lang, ["--lang", "ja"], sub, {"FAKE_ADD_FAIL": "1"})
    check("--lang 은 다시 달기가 실패하면 낡은 언어 등록을 복원한다",
          rc == 2 and out.get("restored") is True and len(calls) == 3 and '"old"' in calls[2], (rc, out, calls))
    rc, out, calls = run(tmp, conf, ["--lang", "English"], sub)
    check("--lang 은 언어 부호 형식이 아니면 CLI 없이 종료 1", rc == 1 and not calls, (rc, out, calls))
    rc, out, calls = run(tmp, conf, ["--lang", "en", "--dry-run"], sub)
    check("--lang --dry-run 은 CLI 를 부르지 않는다", rc == 0 and out["status"] == "dry-run" and not calls, (rc, out, calls))

    # #1123: http 패턴이면 https 자동 전환(HttpsUpgrades)을 끄는 인자를 함께 둔다
    OFF = "--chromeArg=--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable"
    rc, out, calls = run(tmp, conf, ["http://127.0.0.1:*/*"], sub)
    check("http 패턴을 더하면 https 자동 전환을 끄는 인자를 함께 단다",
          rc == 0 and out["args"][-3:] == ["--allowedUrlPattern", "http://127.0.0.1:*/*", OFF]
          and out["https_upgrade_off_added"] is True and OFF in calls[1], (rc, out["args"]))
    rc, out, calls = run(tmp, conf, ["https://b.example.com/*"], sub)
    check("https 패턴만이면 그 인자를 달지 않는다", OFF not in out["args"] and out["https_upgrade_off_added"] is False, out["args"])
    with_off = {"projects": {org: {"mcpServers": {"chrome-devtools": {**entry, "args": BASE + ["--allowedUrlPattern", "http://h/*", OFF]}}}}}
    rc, out, calls = run(tmp, with_off, ["http://h/*"], sub)
    check("이미 http 패턴과 그 인자가 있으면 noop", rc == 0 and out["status"] == "noop" and not calls, (rc, out))
    only_http = {"projects": {org: {"mcpServers": {"chrome-devtools": {**entry, "args": BASE + ["--allowedUrlPattern", "http://h/*"]}}}}}
    rc, out, calls = run(tmp, only_http, [], sub)
    check("http 패턴은 있고 인자가 없는 등록은 인자만 맞춘다", rc == 0 and out["status"] == "ok" and out["args"][-1] == OFF, (rc, out))
    merged = {"projects": {org: {"mcpServers": {"chrome-devtools": {**entry, "args": BASE + ["--chromeArg=--disable-features=Foo"]}}}}}
    rc, out, calls = run(tmp, merged, ["http://h/*"], sub)
    check("기존 --disable-features 인자가 있으면 그 목록에 더한다",
          out["args"].count("--chromeArg=--disable-features=Foo,HttpsUpgrades,HttpsFirstBalancedModeAutoEnable") == 1
          and not any(a == OFF for a in out["args"]), out["args"])
    # 실측: HttpsUpgrades 하나만 끄면 Chrome 157 은 여전히 https 로 바꾼다. 한쪽만 꺼진 등록은 빠진 이름을 더한다
    half = {"projects": {org: {"mcpServers": {"chrome-devtools": {**entry, "args": BASE + ["--allowedUrlPattern", "http://h/*", "--chromeArg=--disable-features=HttpsUpgrades"]}}}}}
    rc, out, calls = run(tmp, half, [], sub)
    check("https 전환 기능이 하나만 꺼진 등록은 빠진 이름을 더한다",
          rc == 0 and out["status"] == "ok" and OFF in out["args"] and out["args"].count(OFF) == 1, (rc, out["args"]))
    # #1147: --check 가 한쪽만 꺼진 옛 등록을 잡고 다시 등록하는 명령을 낸다
    rc, out, calls = run(tmp, half, ["--check"], sub)
    item = (out.get("missing") or [{}])[0]
    check("--check 는 https 전환 기능이 하나만 꺼진 등록을 https-upgrade 로 낸다",
          rc == 1 and out["status"] == "missing" and item.get("problem") == "https-upgrade"
          and item.get("fix", "").endswith("--server chrome-devtools") and not calls, (rc, out))
    full = {"projects": {org: {"mcpServers": {"chrome-devtools": {**entry, "args": BASE + ["--allowedUrlPattern", "http://h/*", OFF]}}}}}
    rc, out, calls = run(tmp, full, ["--check"], sub)
    check("--check 는 두 기능을 모두 끈 http 등록을 통과시킨다", rc == 0 and out["status"] == "ok", (rc, out))
    # #1147: 더한 패턴만 걷는 복구 명령과 --remove
    rc, out, calls = run(tmp, conf, ["http://h/*"], sub)
    check("패턴을 더하면 그 패턴만 걷는 복구 명령을 낸다",
          rc == 0 and out.get("restore", "").endswith("--remove 'http://h/*'") and "--server chrome-devtools" in out["restore"], out)
    both = {"projects": {org: {"mcpServers": {"chrome-devtools": {**entry, "args": BASE + ["--allowedUrlPattern", "http://h/*", "--allowedUrlPattern", "http://g/*", OFF]}}}}}
    rc, out, calls = run(tmp, both, ["--remove", "http://h/*"], sub)
    check("--remove 는 지목한 패턴만 걷고 http 패턴이 남으면 https 전환 끄기를 둔다",
          rc == 0 and out["status"] == "ok" and out["removed"] == ["http://h/*"] and "http://g/*" in out["args"]
          and "http://h/*" not in out["args"] and OFF in out["args"] and len(calls) == 2, (rc, out, calls))
    rc, out, calls = run(tmp, full, ["--remove", "http://h/*"], sub)
    check("마지막 http 패턴을 걷으면 https 전환 끄기도 걷고 기존 인자는 보존한다",
          rc == 0 and out["args"] == BASE, (rc, out["args"]))
    merged_off = {"projects": {org: {"mcpServers": {"chrome-devtools": {**entry, "args": BASE + ["--allowedUrlPattern", "http://h/*", "--chromeArg=--disable-features=Foo,HttpsUpgrades,HttpsFirstBalancedModeAutoEnable"]}}}}}
    rc, out, calls = run(tmp, merged_off, ["--remove", "http://h/*"], sub)
    check("https 전환 끄기를 걷을 때 다른 기능 이름은 남긴다",
          out["args"] == BASE + ["--chromeArg=--disable-features=Foo"], out["args"])
    rc, out, calls = run(tmp, both, ["--remove", "http://h/*"], sub, {"FAKE_ADD_FAIL": "1"})
    check("--remove 의 다시 등록이 실패하면 원래 등록으로 되돌리고 종료 2",
          rc == 2 and out.get("step") == "add" and out.get("restored") is True and len(calls) == 3, (rc, out, calls))
    rc, out, calls = run(tmp, both, ["--remove", "http://h/*", "--dry-run"], sub)
    check("--remove --dry-run 은 CLI 를 부르지 않는다", rc == 0 and out["status"] == "dry-run" and not calls, (rc, out, calls))
    eq = {"projects": {org: {"mcpServers": {"chrome-devtools": {**entry, "args": BASE + ["--allowed-url-pattern=http://h/*", OFF]}}}}}
    rc, out, calls = run(tmp, eq, ["--remove", "http://h/*"], sub)
    check("= 형태로 등록된 패턴도 걷는다", rc == 0 and out["removed"] == ["http://h/*"] and out["args"] == BASE, (rc, out))
    user_only = {"mcpServers": {"chrome-devtools": {**entry, "args": BASE}}}
    rc, out, calls = run(tmp, user_only, ["http://u/*"], tmp)
    check("사용자 범위 등록의 복구 명령은 --user 를 담는다",
          rc == 0 and out.get("scope") == "user" and " --user " in out.get("restore", ""), out)
    none = {"projects": {org: {"mcpServers": {"chrome-devtools": {**entry, "args": ["-y", "chrome-devtools-mcp@1.9.0", "--isolated"]}}}}}
    rc, out, calls = run(tmp, none, ["http://h/*"], sub)
    check("더하기 전 허용 패턴이 없으면 복구 명령 대신 사유를 낸다",
          rc == 0 and "restore" not in out and "restore_note" in out, out)
    only = {"projects": {org: {"mcpServers": {"chrome-devtools": {**entry, "args": ["-y", "chrome-devtools-mcp@1.9.0", "--isolated", "--allowedUrlPattern", "http://h/*", OFF]}}}}}
    rc, out, calls = run(tmp, only, ["--remove", "http://h/*"], sub)
    check("마지막 허용 패턴은 걷지 않고 종료 1 (이동 제한이 사라지지 않게)",
          rc == 1 and out.get("step") == "last-pattern" and not calls, (rc, out, calls))
    off_only = {"projects": {org: {"mcpServers": {"chrome-devtools": {**entry, "args": BASE + [OFF]}}}}}
    rc, out, calls = run(tmp, off_only, ["--remove", "http://none/*"], sub)
    check("걷은 패턴이 없으면 https 전환 끄기도 그대로 두고 CLI 를 부르지 않는다",
          rc == 0 and out["status"] == "noop" and OFF in out["args"] and not calls, (rc, out, calls))
    rc, out, calls = run(tmp, both, ["http://new/*", "--remove", "http://h/*"], sub)
    check("--remove 와 추가 패턴을 함께 쓰면 종료 1", rc == 1 and not calls, (rc, out, calls))
    rc, out, calls = run(tmp, full, ["--remove", "http://none/*"], sub)
    check("없는 패턴을 걷으면 noop 이고 CLI 를 부르지 않는다",
          rc == 0 and out["status"] == "noop" and out["missing"] == ["http://none/*"] and not calls, (rc, out, calls))
    # #1123: 셸 글로빙이 끝 `*` 를 지운 패턴
    for bad in ["http://127.0.0.1:8080/", "http://127.0.0.1:*/", "https://*.example.com/"]:
        rc, out, calls = run(tmp, conf, [bad], sub)
        check(f"끝이 / 인 패턴은 CLI 없이 종료 1 로 거부하고 작은따옴표 안내를 한다: {bad}",
              rc == 1 and out.get("step") == "glob" and "작은따옴표" in out["message"] and not calls, (rc, out))

CONTROL = "https://*#@a.example.com/*"  # 스크립트가 a.example.com 으로 보던 우회 표본. 대조가 이것을 잡아야 의미가 있다
hosts = urlpattern_hosts(ACCEPTED + [CONTROL])
if hosts is None:
    print("skip 받은 패턴의 URLPattern 대조 (node 또는 URLPattern 없음)")
else:
    for p, h in zip(ACCEPTED, hosts):
        check(f"받은 패턴은 URLPattern 에서도 같은 scheme · 호스트다: {p}", same_as_consumer(p, h), h)
    check("대조군: 우회 표본은 URLPattern 대조에서 어긋난다", not same_as_consumer(CONTROL, hosts[-1]), hosts[-1])

print(f"\n{'PASS' if not fails else 'FAIL'} ({fails} failed)")
sys.exit(1 if fails else 0)
