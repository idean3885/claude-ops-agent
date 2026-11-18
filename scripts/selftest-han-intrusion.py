#!/usr/bin/env python3
"""han-intrusion.mjs 자체 점검 (#1090). 실제 CLI 진입점을 격리 디렉토리에서 실행한다.

    python3 scripts/selftest-han-intrusion.py

스펙
  HI-1  한글 음절에 붙은 한자는 6, 섞임 없는 글 · 띄어 쓴 한자 낱말은 0, 읽지 못한 파일은 1
  HI-2  .json 은 문자열 값을 풀어서 본다. \\uXXXX 로 이스케이프된 섞임도 잡는다
  HI-3  OPS_AGENT_HAN_GUARD_DISABLE=1 이면 통과한다
  HI-4  이슈 생성 어댑터가 섞인 제목 · 본문을 생성 전에 멈추는 것은 selftest-issue-adapter.mjs 가 본다
"""

import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.join(HERE, "han-intrusion.mjs")
MIXED = "남은 일은 외部 대기"

fails = 0


def check(name, ok, detail=""):
    global fails
    if not ok:
        fails += 1
    print(f"{'  OK' if ok else '  XX'}  {name}{'' if ok else f' · {detail}'}")


def run(args, env=None):
    e = dict(os.environ)
    e.pop("OPS_AGENT_HAN_GUARD_DISABLE", None)
    e.update(env or {})
    return subprocess.run(["node", LIB, *args], text=True, capture_output=True, env=e)


with tempfile.TemporaryDirectory() as d:
    def write(name, content):
        path = os.path.join(d, name)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        return path

    # HI-1
    r = run([write("a.md", "남은 일은 외부 대기")])
    check("HI-1 섞임 없는 글은 0", r.returncode == 0, r.stderr)
    r = run([write("b.md", "회의 메모 部長 참석")])
    check("HI-1 띄어 쓴 한자 낱말은 0", r.returncode == 0, r.stderr)
    r = run([write("c.md", MIXED)])
    check("HI-1 한글 뒤에 붙은 한자는 6", r.returncode == 6 and "han-intrusion" in r.stderr, (r.returncode, r.stderr))
    r = run(["--text", "部분 완료"])
    check("HI-1 한글 앞에 붙은 한자(--text)는 6", r.returncode == 6, (r.returncode, r.stderr))
    r = run([os.path.join(d, "none.md")])
    check("HI-1 읽지 못한 파일은 1", r.returncode == 1 and "han-intrusion" in r.stderr, (r.returncode, r.stderr))

    # HI-2
    p = write("p.json", json.dumps({"body": {"content": MIXED}}))
    with open(p, encoding="utf-8") as f:
        escaped = "部" not in f.read()
    r = run([p])
    check("HI-2 이스케이프된 JSON 문자열의 섞임도 6", escaped and r.returncode == 6, (escaped, r.returncode))

    # HI-3
    r = run([write("e.md", MIXED)], {"OPS_AGENT_HAN_GUARD_DISABLE": "1"})
    check("HI-3 비활성 환경변수면 0", r.returncode == 0, (r.returncode, r.stderr))

print(f"\n{'PASS' if not fails else 'FAIL'} ({fails} failed)")
sys.exit(1 if fails else 0)
