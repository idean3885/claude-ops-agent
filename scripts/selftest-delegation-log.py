#!/usr/bin/env python3
"""delegation-log.py 자체 점검. 임시 기록 파일로 돈다.

    python3 scripts/selftest-delegation-log.py
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "delegation-log.py")
fails = 0


def check(name, cond, detail=""):
    global fails
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else f"  {detail}"))
    fails += 0 if cond else 1


with tempfile.TemporaryDirectory() as tmp:
    env = {**os.environ, "DELEGATION_LOG": os.path.join(tmp, "m", "delegation.jsonl")}

    def run(*args):
        r = subprocess.run([sys.executable, SCRIPT, *args], env=env, capture_output=True, text=True)
        return r.returncode, json.loads(r.stdout)

    rc, out = run("report")
    check("기록이 없으면 정확도는 없음", rc == 0 and out["count"] == 0 and out["accuracy"] is None, out)
    rc, out = run("add", "--goal", "체크리스트 테스트", "--items", "10", "--done", "7", "--reverted", "2", "--missed", "1", "--session", "abc")
    check("add 는 한 줄을 쌓는다", rc == 0 and out["row"]["done"] == 7 and out["row"]["session"] == "abc", out)
    rc, out = run("add", "--goal", "문서 정리", "--items", "4", "--done", "4")
    rc, out = run("report")
    check("report 는 항목 합으로 정확도를 낸다 (11/14)", out["count"] == 2 and out["accuracy"] == round(11 / 14, 3), out)
    check("report 는 되돌림 · 누락을 따로 센다", out["reverted"] == 2 and out["missed"] == 1, out)
    check("report 는 최근 위임별 정확도를 낸다", out["recent"][0] == {"goal": "체크리스트 테스트", "accuracy": 0.7}, out)
    rc, out = run("add", "--goal", "x", "--items", "3", "--done", "4")
    check("done > items 는 거절", rc == 1 and out["status"] == "error", out)
    rc, out = run("add", "--goal", " ", "--items", "3", "--done", "1")
    check("빈 목표는 거절", rc == 1, out)
    for bad in (["--items", "0", "--done", "0"], ["--items", "3", "--done", "-1"], ["--items", "3", "--done", "1", "--reverted", "-1"], ["--items", "3", "--done", "1", "--missed", "-1"]):
        rc, out = run("add", "--goal", "x", *bad)
        check(f"값 오류 거절: {' '.join(bad)}", rc == 1, out)
    rc, out = run("report")
    check("거절된 add 는 쌓이지 않는다", out["count"] == 2, out)
    for i in range(5):
        run("add", "--goal", f"g{i}", "--items", "1", "--done", "1")
    rc, out = run("report")
    check("report 의 최근 목록은 5건까지", len(out["recent"]) == 5 and out["recent"][-1]["goal"] == "g4" and out["recent"][0]["goal"] == "g0", out)

with tempfile.TemporaryDirectory() as tmp:
    r = subprocess.run([sys.executable, SCRIPT, "add", "--goal", "g", "--items", "1", "--done", "1"],
                       env={**os.environ, "DELEGATION_LOG": "d.jsonl"}, cwd=tmp, capture_output=True, text=True)
    check("파일명만 준 기록 경로도 현재 디렉토리에 쌓는다", r.returncode == 0 and os.path.exists(os.path.join(tmp, "d.jsonl")), r.stderr)

print(f"\n{'PASS' if not fails else 'FAIL'} ({fails} failed)")
sys.exit(1 if fails else 0)
