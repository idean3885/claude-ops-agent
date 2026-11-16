#!/usr/bin/env python3
"""DevTools MCP 허용 URL 추가.

DevTools MCP(chrome-devtools-mcp) 등록의 `--allowedUrlPattern` 에 패턴을 더한다.
다시 등록할 때 격리 인자(`--isolated`)가 없으면 함께 넣는다. 세션마다 MCP 서버가 따로
브라우저를 띄우므로 고정 프로필은 한 세션만 잡을 수 있다.
설정 파일을 직접 고치지 않고 Claude Code 공식 CLI(`claude mcp remove` → `claude mcp add-json`)
로 같은 범위에 다시 등록한다. 실행과 다시 연결(`/mcp` → chrome-devtools → Reconnect)은
사용자 몫이다. 에이전트는 이 명령을 만들어 건넨다 (docs/working-principles.md
「브라우저는 DevTools MCP 로만 쓴다」).

사용법:
  devtools-allow.py [--project <dir>] [--server <name>] [--dry-run] [<pattern>...]
  devtools-allow.py --check [--server <name>]
  devtools-allow.py --lang <code> [--project <dir>] [--server <name>] [--dry-run]
  사용자에게 건네는 경로: ~/.claude/ops-agent/current/scripts/devtools-allow.py
    pattern    예: 'http://127.0.0.1:*/*'  'https://*.example.com/*'
               생략하면 격리 인자만 맞춘다
    --check    로컬 · 사용자 범위 등록을 모두 훑어 격리가 아닌 등록(격리 인자 없음 ·
               고정 프로필 지정 · 떠 있는 브라우저에 붙음)과 고칠 명령을 낸다.
               지워진 디렉토리의 등록은 stale 로만 알린다.
               등록을 바꾸지 않는다 (의존 확인 bootstrap 의 check)
    --project  등록을 찾을 시작 디렉토리 (기본: 현재 디렉토리). 위로 올라가며
               그 서버를 로컬 범위로 등록한 가장 가까운 프로젝트를 쓴다.
               없으면 사용자 범위 등록을 쓴다.
    --server   MCP 서버 이름 (기본: chrome-devtools)
    --user     로컬 범위를 보지 않고 사용자 범위 등록을 고친다
    --dry-run  바꿀 내용만 출력하고 등록은 바꾸지 않는다
    --lang     다국어 화면 테스트용으로, 기존 등록을 복사해 브라우저 언어를 <code>(예: en · ja)로
               띄우는 서버 `<server>-<code>` 를 같은 범위에 등록한다. 기존 등록은 바꾸지 않는다.
               DevTools MCP 는 chrome:// 이동을 막고 에뮬레이션에 언어 옵션이 없어, 브라우저 언어
               (Accept-Language · navigator.language)는 Chrome 실행 인자로만 바꿀 수 있다.
               쿠키 · 요청 헤더 · navigator 덮어쓰기로 판정하면 서버가 언어 쿠키를 다시 심어 틀린다.
               세션 시작 뒤 등록하면 /reload-plugins 뒤 /mcp 에서 그 서버를 연결한다.
               쓰지 않을 때는 등록 디렉토리에서 `claude mcp remove <server>-<code> -s <범위>` 로 지운다

출력: JSON {status, scope, project, added[], already[], isolated_added, args}
  status: ok | noop | dry-run | error
  profile_removed: 격리를 맞추며 걷은 인자(고정 프로필 지정 · 격리 끄기)
  --check: JSON {status: ok | missing | none, checked, missing[{scope, project, problem, fix, message?}], stale[]}
    problem: missing(격리 인자 없음) · disabled(격리 끔) · fixed-profile · connect(떠 있는 브라우저에 붙음,
             fix 는 제거 명령)
    지워진 디렉토리의 등록만 있으면 none 이다
종료 코드: 0 성공 · noop · dry-run · check 통과, 1 scheme 없는 패턴 · 고정되지 않은 호스트 · check 에서 격리 빠짐,
          2 argparse 인자 오류 · 설정 파일 없음 · 등록 없음 · 등록 디렉토리 없음 · CLI 실패 ·
            떠 있는 브라우저에 붙는 등록 · 차단 패턴이 있는 등록에 허용 패턴 추가

패턴 넓이: 호스트는 고정 이름이어야 한다. 와일드카드는 `*.` 뒤에 고정 라벨이 둘 이상일 때만 받는다
(https://*.example.com/*). https://*/* · https://*.com/* 와 URLPattern 의 이름 그룹(https://:host/*) ·
정규식 그룹 · 수식어처럼 호스트를 여는 표기는 거부한다. 포트의 숫자 · * 는 상관없다.

범위: 로컬 범위(~/.claude.json 의 projects)와 사용자 범위만 다룬다. 프로젝트 범위(.mcp.json)는
레포에 커밋되는 공유 설정이라 이 스크립트가 고치지 않는다.

설정 파일 위치는 CLAUDE_CONFIG_JSON, 고칠 명령에 넣는 자기 경로는 DEVTOOLS_ALLOW_SELF 로
바꿀 수 있다 (테스트용).
"""

import argparse
import json
import re
import os
import subprocess
import sys

FLAG = "--allowedUrlPattern"
FLAGS = (FLAG, "--allowed-url-pattern")
ISOLATED = "--isolated"
# 격리를 끄는 형태. 걷고 --isolated 를 넣는다
ISOLATED_OFF = ("--no-isolated", "--isolated=false")
# 고정 프로필을 지정하는 인자. --isolated 와 상호 배타라 함께 두면 서버가 시작하지 못한다 (1.9.0)
FIXED_PROFILE = ("--userDataDir", "--user-data-dir")
# 이미 떠 있는 브라우저에 붙는 인자(별칭 포함). 격리 프로필을 쓰지 않는다
CONNECT = ("--autoConnect", "--auto-connect", "--browserUrl", "--browser-url", "-u",
           "--wsEndpoint", "--ws-endpoint", "-w")
# 허용 패턴과 함께 쓸 수 없다고 선언된 인자 (1.9.0 mcp-options.js conflicts)
BLOCKED = ("--blockedUrlPattern", "--blocked-url-pattern")


def has_flag(args, names):
    return any(a == n or a.startswith(n + "=") for a in args for n in names)


def isolation_problem(args):
    """격리 프로필이 아닌 이유. 격리면 None."""
    if has_flag(args, CONNECT):
        return "connect"
    if has_flag(args, FIXED_PROFILE):
        return "fixed-profile"
    if any(a in ISOLATED_OFF for a in args) or any(
            a == ISOLATED and i + 1 < len(args) and args[i + 1] == "false" for i, a in enumerate(args)):
        return "disabled"
    if ISOLATED not in args:
        return "missing"
    return None


HOST_LABEL = re.compile(r"[A-Za-z0-9-]+")
IPV6 = re.compile(r"\[[0-9A-Fa-f:.]+\]")
PORT = re.compile(r":(\d+|\*)$")


def too_broad(pattern):
    """호스트가 고정 이름이 아니면 True.

    받는 것은 고정 라벨(`a.example.com` · `localhost` · IP) · IPv6 리터럴 · `*.` 뒤 고정 라벨 둘 이상뿐이다.
    URLPattern 의 이름 그룹(`:host`) · 정규식 그룹 · 수식어처럼 `*` 없이 호스트를 여는 표기도 거부한다.
    포트(`:숫자` · `:*`)는 상관없다.
    """
    host = pattern.split("://", 1)[1].split("/", 1)[0].rsplit("@", 1)[-1]
    host = PORT.sub("", host)
    if IPV6.fullmatch(host):
        return False
    labels = host.split(".")
    if labels[0] == "*":
        labels = labels[1:]
        if len(labels) < 2:
            return True
    return not all(HOST_LABEL.fullmatch(l) for l in labels)


def config_path():
    return os.environ.get("CLAUDE_CONFIG_JSON") or os.path.expanduser("~/.claude.json")


def load_config():
    try:
        with open(config_path()) as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        print(json.dumps({"status": "error", "step": "config", "message": f"설정 파일을 읽지 못했다: {e}"}, ensure_ascii=False))
        return None


def find_entry(conf, start, server, user_only=False):
    """가장 가까운 로컬 범위 등록, 없으면 사용자 범위 등록을 찾는다."""
    projects = {} if user_only else conf.get("projects", {})
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
    pats = [args[i + 1] for i, a in enumerate(args[:-1]) if a in FLAGS]
    return pats + [a.split("=", 1)[1] for a in args if any(a.startswith(f + "=") for f in FLAGS)]


def ensure_isolated(args):
    """고정 프로필 · 격리 끄기 인자를 걷고 격리 인자가 없으면 패키지 인자 바로 뒤에 넣는다.
    (새 인자, 바꿨는가, 걷은 인자)
    이미 떠 있는 브라우저에 붙는 등록은 호출 전에 거른다."""
    new_args, removed, i = [], [], 0
    while i < len(args):
        a = args[i]
        if a in FIXED_PROFILE or (a == ISOLATED and i + 1 < len(args) and args[i + 1] in ("false", "true")):
            removed += args[i:i + 2]
            i += 2
            continue
        if a in ISOLATED_OFF or any(a.startswith(n + "=") for n in FIXED_PROFILE):
            removed.append(a)
            i += 1
            continue
        new_args.append(a)
        i += 1
    if ISOLATED in new_args:
        return new_args, bool(removed), removed
    pkg = next((i for i, a in enumerate(new_args) if "chrome-devtools-mcp" in a), None)
    new_args.insert(pkg + 1 if pkg is not None else len(new_args), ISOLATED)
    return new_args, True, removed


def all_entries(conf, server):
    """(scope, project, entry) 를 로컬 범위 전부, 사용자 범위 순으로 낸다."""
    for d, p in sorted(conf.get("projects", {}).items()):
        entry = p.get("mcpServers", {}).get(server)
        if entry:
            yield "local", d, entry
    entry = conf.get("mcpServers", {}).get(server)
    if entry:
        yield "user", None, entry


# 사용자에게 건네는 경로는 버전 없는 고정 경로다. 캐시 경로는 갱신 뒤 낡고, 플러그인 경로 변수는
# 셸에 없다. 고정 경로는 SessionStart 가 활성 버전으로 유지한다 (scripts/pre-tool-use.mjs 와 같음)
SELF = os.environ.get("DEVTOOLS_ALLOW_SELF") or "~/.claude/ops-agent/current/scripts/devtools-allow.py"


def check(conf, server):
    entries = list(all_entries(conf, server))
    if not entries:
        print(json.dumps({"status": "none", "message": f"{server} 등록이 없다"}, ensure_ascii=False))
        return 2
    missing, stale = [], []
    for scope, project, entry in entries:
        problem = isolation_problem(entry.get("args", []))
        if not problem:
            continue
        if project and not os.path.isdir(project):
            # 지워진 디렉토리의 등록은 어느 세션도 띄우지 않는다. 고칠 명령도 통하지 않으므로 막지 않는다
            stale.append({"scope": scope, "project": project})
            continue
        item = {"scope": scope, "project": project, "problem": problem}
        if problem == "connect":
            where = f"cd '{project}' && " if project else ""
            item["fix"] = f"{where}claude mcp remove {server} -s {scope}"
            item["message"] = "이미 떠 있는 브라우저에 붙는 등록이다. 지운 뒤 의존 확인의 install 명령으로 격리 등록을 다시 만든다"
        else:
            target = f"--project '{project}'" if project else "--user"
            item["fix"] = f"python3 {SELF} {target} --server {server}"
        missing.append(item)
    out = {"checked": len(entries)}
    if len(stale) == len(entries):
        print(json.dumps({"status": "none", "message": f"쓸 수 있는 {server} 등록이 없다", "stale": stale}, ensure_ascii=False))
        return 2
    if stale:
        out["stale"] = stale
    if missing:
        print(json.dumps({"status": "missing", "missing": missing, **out}, ensure_ascii=False))
        return 1
    print(json.dumps({"status": "ok", **out}, ensure_ascii=False))
    return 0


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


LANG_ARGS = ("--chromeArg=--lang=", "--chromeArg=--accept-lang=")


def with_lang(args, code):
    """언어 인자를 걷고 code 로 다시 넣는다. accept-lang 은 지역 부호가 있으면 언어 부호도 함께 둔다."""
    base = [a for a in args if not a.startswith(LANG_ARGS)]
    accept = code if "-" not in code else f"{code},{code.split('-')[0]}"
    return base + [f"--chromeArg=--lang={code}", f"--chromeArg=--accept-lang={accept}"]


def register_lang(a, conf):
    import re
    if not re.fullmatch(r"[a-z]{2,3}(-[A-Z]{2})?", a.lang):
        print(json.dumps({"status": "error", "message": f"언어 부호 형식이 아니다: {a.lang} (예: en · ja · en-US)"}, ensure_ascii=False))
        return 1
    scope, project, entry = find_entry(conf, a.project, a.server, a.user)
    if not entry:
        print(json.dumps({"status": "error", "message": f"{a.server} 등록을 찾지 못했다 (로컬 · 사용자 범위)"}, ensure_ascii=False))
        return 2
    if has_flag(entry.get("args", []), CONNECT):
        print(json.dumps({"status": "error", "step": "connect", "message": "이미 떠 있는 브라우저에 붙는 등록은 언어를 바꿀 수 없다"}, ensure_ascii=False))
        return 2
    name = f"{a.server}-{a.lang}"
    args, _, _ = ensure_isolated(entry.get("args", []))
    new_entry = {**entry, "args": with_lang(args, a.lang)}
    if scope == "local":
        current = conf.get("projects", {}).get(project, {}).get("mcpServers", {}).get(name)
    else:
        current = conf.get("mcpServers", {}).get(name)
    out = {"scope": scope, "project": project, "server": name, "args": new_entry["args"]}
    if current == new_entry:
        print(json.dumps({"status": "noop", **out}, ensure_ascii=False))
        return 0
    if a.dry_run:
        print(json.dumps({"status": "dry-run", **out}, ensure_ascii=False))
        return 0
    cwd = project or os.path.expanduser("~")
    if not os.path.isdir(cwd):
        print(json.dumps({"status": "error", "step": "cwd", "message": f"등록 디렉토리가 없다: {cwd}"}, ensure_ascii=False))
        return 2
    if current is not None:
        rc, msg = run_cli(["claude", "mcp", "remove", name, "-s", scope], cwd)
        if rc != 0:
            print(json.dumps({"status": "error", "step": "remove", "message": msg}, ensure_ascii=False))
            return 2
    rc, msg = run_cli(["claude", "mcp", "add-json", name, json.dumps(new_entry), "-s", scope], cwd)
    if rc != 0:
        err = {"status": "error", "step": "add", "message": msg}
        if current is not None:
            # 지운 언어 등록을 원래 값으로 되돌린다 (일반 경로와 같다)
            rrc, _ = run_cli(["claude", "mcp", "add-json", name, json.dumps(current), "-s", scope], cwd)
            err["restored"] = rrc == 0
            if rrc != 0:
                err["original"] = current
        print(json.dumps(err, ensure_ascii=False))
        return 2
    print(json.dumps({"status": "ok", **out, "next": f"/reload-plugins → /mcp → {name} → Reconnect"}, ensure_ascii=False))
    return 0


def run_cli(cmd, cwd):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    return r.returncode, (r.stdout + r.stderr).strip()


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("patterns", nargs="*")
    ap.add_argument("--project", default=os.getcwd())
    ap.add_argument("--server", default="chrome-devtools")
    ap.add_argument("--user", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--lang")
    a = ap.parse_args()

    if a.lang:
        conf = load_config()
        return 2 if conf is None else register_lang(a, conf)

    if a.check:
        conf = load_config()
        return 2 if conf is None else check(conf, a.server)

    bad = [p for p in a.patterns if "://" not in p]
    if bad:
        print(json.dumps({"status": "error", "message": f"패턴은 scheme 을 포함해야 한다: {bad}"}, ensure_ascii=False))
        return 1
    broad = [p for p in a.patterns if too_broad(p)]
    if broad:
        print(json.dumps({"status": "error", "step": "broad",
                          "message": f"호스트가 고정되지 않은 패턴은 받지 않는다(예: https://*.example.com/* 는 된다): {broad}"},
                         ensure_ascii=False))
        return 1

    conf = load_config()
    if conf is None:
        return 2
    scope, project, entry = find_entry(conf, a.project, a.server, a.user)
    if not entry:
        print(json.dumps({"status": "error", "message": f"{a.server} 등록을 찾지 못했다 (로컬 · 사용자 범위)"}, ensure_ascii=False))
        return 2

    args = entry.get("args", [])
    if has_flag(args, CONNECT):
        print(json.dumps({"status": "error", "step": "connect", "message": "이미 떠 있는 브라우저에 붙는 등록이라 격리 프로필로 바꿀 수 없다. 지우고 다시 등록한다"}, ensure_ascii=False))
        return 2
    if a.patterns and has_flag(args, BLOCKED):
        print(json.dumps({"status": "error", "step": "blocked", "message": "차단 패턴이 있는 등록에는 허용 패턴을 함께 쓸 수 없다"}, ensure_ascii=False))
        return 2
    new_args, added, already = add_patterns(args, a.patterns)
    new_args, isolated_added, profile_removed = ensure_isolated(new_args)
    out = {"scope": scope, "project": project, "added": added, "already": already,
           "isolated_added": isolated_added, "profile_removed": profile_removed, "args": new_args}
    if not added and not isolated_added:
        print(json.dumps({"status": "noop", **out}, ensure_ascii=False))
        return 0
    if a.dry_run:
        print(json.dumps({"status": "dry-run", **out}, ensure_ascii=False))
        return 0

    new_entry = {**entry, "args": new_args}
    cwd = project or os.path.expanduser("~")
    if not os.path.isdir(cwd):
        # 공식 CLI 는 로컬 범위를 실행 디렉토리로 고른다. 지워진 프로젝트에는 다시 등록할 수 없다
        print(json.dumps({"status": "error", "step": "cwd", "message": f"등록 디렉토리가 없다: {cwd}"}, ensure_ascii=False))
        return 2
    rc, msg = run_cli(["claude", "mcp", "remove", a.server, "-s", scope], cwd)
    if rc != 0:
        print(json.dumps({"status": "error", "step": "remove", "message": msg}, ensure_ascii=False))
        return 2
    rc, msg = run_cli(["claude", "mcp", "add-json", a.server, json.dumps(new_entry), "-s", scope], cwd)
    if rc != 0:
        # 지운 등록을 원래 값으로 되돌린다
        rrc, _ = run_cli(["claude", "mcp", "add-json", a.server, json.dumps(entry), "-s", scope], cwd)
        out = {"status": "error", "step": "add", "message": msg, "restored": rrc == 0}
        if rrc != 0:
            out["original"] = entry
        print(json.dumps(out, ensure_ascii=False))
        return 2
    print(json.dumps({"status": "ok", **out, "next": "/mcp → " + a.server + " → Reconnect"}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
