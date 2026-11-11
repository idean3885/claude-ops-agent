#!/usr/bin/env python3
"""금지 표현 룰 자체 점검.

패턴을 고치면 오탐을 줄이면서 정탐까지 함께 빠질 수 있다. 응답 검사는 걸린 것만 알리므로
빠진 정탐은 신호가 없다. 잡혀야 하는 문장과 통과해야 하는 문장을 고정해 그 붕괴를 잡는다.

    python3 scripts/selftest-forbidden-words.py [룰 파일]

룰 파일을 주면 그 파일을 시험한다. 고치기 전 룰로 실패하는지 볼 때 쓴다.
"""

from __future__ import annotations

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RULES = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    ROOT, "config", "style-rules", "forbidden-words.json")

conf = json.load(open(RULES, encoding="utf-8"))
# 응답 검사 훅(hooks/forbidden-words-stop.sh)과 같은 방식으로 어미 묶음을 펼친다
endings = conf.get("_endingClass") or "(?:다|는|고|서|면|지|기|은|을|었|았)"
patterns = [re.compile(r["pattern"].replace("%E%", endings)) for r in conf["rules"]]


def caught(sentence: str) -> bool:
    return any(p.search(sentence) for p in patterns)


MUST_CATCH = [
    "요청이 외부로 나간다.",
    "메일이 나갔다.",
    "상태 전이가 일어난다.",
    "값을 뺀다.",
    "이 항목은 뺄 수 있다.",
    "배선 테스트가 통과했다.",
    "무인증 접근이 가능하다.",
    "모니터링 경로가 무인증으로 열려 있다.",
    "셀렉터가 라벨로 파드를 고른다.",
    "후보 중 하나를 골라 적용한다.",
    "방안을 고를 때 대조군을 둔다.",
    "어느 쪽을 고르는지 적는다.",
    "하나를 고르고 근거를 댄다.",
    "후보가 여럿이면 하나를 고르면 된다.",
    "이름 고르기가 어렵다.",
    "대상을 고르며 기준을 적는다.",
    "후보를 고르려 한다.",
    "하나를 고르자.",
    "하나를 고르세요.",
    "하나를 고르십시오.",
    "방안 하나를 골랐다.",
    "이 안을 고릅니다.",
]

MUST_PASS = [
    "예측이 빗나간 경우다.",
    "시간이 지나가면 만료된다.",
    "릴리스 확정 전이라 보류한다.",
    "회신 전이면 기다린다.",
    "뺄셈으로 잔여를 구한다.",
    "부하가 노드에 고르게 퍼진다.",
    "응답 시간이 고르지 않다.",
    "고른 분포를 기대한다.",
    "되고 안되고를 우리가 어떻게 압니까?",
]

failures = 0
for s in MUST_CATCH:
    ok = caught(s)
    print(("OK  " if ok else "FAIL") + " 잡힘: " + s)
    failures += not ok
for s in MUST_PASS:
    ok = not caught(s)
    print(("OK  " if ok else "FAIL") + " 통과: " + s)
    failures += not ok

total = len(MUST_CATCH) + len(MUST_PASS)
print(f"{total - failures}/{total} 통과")
sys.exit(1 if failures else 0)
