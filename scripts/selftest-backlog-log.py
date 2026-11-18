#!/usr/bin/env python3
"""backlog-log.py 자체 점검 (#1134). 임시 기록 파일로 add · report · 값 검사를 본다.

사용: python3 scripts/selftest-backlog-log.py
종료 코드: 실패 1, 전부 통과 0
"""
import json
import os
import subprocess
import sys
import tempfile

here = os.path.dirname(os.path.abspath(__file__))
log = os.path.join(tempfile.mkdtemp(prefix="backlog-log-"), "b.jsonl")
env = {**os.environ, "BACKLOG_LOG": log}
failed = 0


def run(*args):
    r = subprocess.run([sys.executable, os.path.join(here, "backlog-log.py"), *args], env=env, capture_output=True, text=True)
    return r.returncode, json.loads(r.stdout)


def check(name, ok, detail=""):
    global failed
    failed += 0 if ok else 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}{'' if ok else f' · {detail}'}")


base = ["--open-before", "32", "--closed", "9", "--bundled", "4", "--debated", "11", "--waiting", "3", "--reversed", "0"]
rc, out = run("add", *base)
check("add 는 한 줄을 남긴다", rc == 0 and out["row"]["closed"] == 9 and os.path.exists(log), out)
rc, out = run("add", *[v if v != "9" else "40" for v in base])
check("닫은 수 + 묶음 수가 정리 전 수보다 크면 거부", rc == 1 and out["status"] == "error", out)
rc, out = run("add", *[v if v != "0" else "12" for v in base])
check("뒤집힌 수가 토론 수보다 크면 거부", rc == 1, out)
rc, out = run("report")
check("report 는 줄어든 비율과 뒤집힘률을 낸다", rc == 0 and out["count"] == 1 and out["reduced"] == round(13 / 32, 3) and out["reversed_rate"] == 0.0, out)
print(f"\n실패 {failed}건" if failed else "\n전부 통과")
sys.exit(1 if failed else 0)
