#!/usr/bin/env python3
"""transcribe cleanup.py 자체 점검.

교정은 수집할 때 한 번에 끝낸다 (#807). 치환이 단어 일부를 바꾸거나, 원문을 건드리거나,
정리본을 덮어쓰면 그 한 번이 틀린 채로 굳는다. 실제 진입점(명령줄)을 돌려 그 붕괴를 잡는다.

    python3 scripts/selftest-transcribe-cleanup.py
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.environ.get("CLEANUP", os.path.join(ROOT, "skills/transcribe/cleanup.py"))

RAW = """[00:00:01] 화자00:
  리터링이 늦게 들어와요
  위터링 데이터는 웹북으로 받습니다
  피리터링은 바꾸면 안 된다
[00:00:09] 화자01:
  크로즈 트레일 로그를 같이 봐요
"""
TABLE = """# 공용 대응표
리터링\t미터링
위터링\t미터링
웹북\t웹훅
크로즈 트레일\tCloudTrail
크로즈\t클로즈
"""
SPEAKERS = "화자00\t발표자\n"

failures = 0


def expect(name: str, ok: bool) -> None:
    global failures
    print(("OK  " if ok else "FAIL") + " " + name)
    if not ok:
        failures += 1


def run(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-I", SCRIPT, *args], capture_output=True, text=True)


with tempfile.TemporaryDirectory() as d:
    raw, table, spk, out = (os.path.join(d, n) for n in ("a.speakers.txt", "t.tsv", "s.tsv", "a.md"))
    for p, body in ((raw, RAW), (table, TABLE), (spk, SPEAKERS)):
        open(p, "w", encoding="utf-8").write(body)

    pre = run("preview", raw, table)
    expect("preview 는 치환 건수를 낸다", pre.returncode == 0 and "리터링 → 미터링 1건" in pre.stdout)
    expect("preview 는 화자별 대표 발화를 낸다", "화자01\n  크로즈 트레일 로그를 같이 봐요" in pre.stdout)
    expect("preview 는 정리본을 쓰지 않는다", not os.path.exists(out))

    r = run("apply", raw, out, table, spk)
    text = open(out, encoding="utf-8").read() if os.path.exists(out) else ""
    expect("apply 성공", r.returncode == 0)
    expect("조사가 붙은 말도 바꾼다", "미터링이 늦게" in text)
    expect("단어 앞이 이어진 말은 바꾸지 않는다", "피리터링은" in text)
    expect("긴 말부터 맞춘다", "CloudTrail 로그" in text and "클로즈" not in text)
    expect("대응표 여럿을 합친다 (화자 이름)", "[00:00:01] 발표자:" in text)
    expect("원문은 바뀌지 않는다", open(raw, encoding="utf-8").read() == RAW)

    again = run("apply", raw, out, table)
    expect("정리본이 있으면 덮어쓰지 않는다", again.returncode != 0 and open(out, encoding="utf-8").read() == text)

    bad = os.path.join(d, "bad.tsv")
    open(bad, "w", encoding="utf-8").write("탭 없는 줄\n")
    b = run("preview", raw, bad)
    expect("형식이 틀린 대응표는 줄 번호와 함께 멈춘다", b.returncode != 0 and "bad.tsv:1" in b.stderr)

print(f"\n{'실패 ' + str(failures) + '건' if failures else '전부 통과'}")
sys.exit(1 if failures else 0)
