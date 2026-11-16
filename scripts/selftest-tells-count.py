#!/usr/bin/env python3
"""tells_count.py 진단 앵커 자체 점검.

진단 앵커는 숫자만 내므로 탐지가 무너져도 0 을 내며 조용히 통과한다.
잡혀야 하는 문장과 잡히면 안 되는 문장을 고정해 그 붕괴를 잡는다.

    python3 scripts/selftest-tells-count.py
"""

from __future__ import annotations

import os
import sys

sys.path.insert(
    0,
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "config", "style-rules", "metrics"),
)

import tells_count as tc  # noqa: E402

# D-13 동작 명사를 행위 주체로 둔 문장 (#724)
ACTION_NOUN_HIT = [
    "활성화가 처리 중인 프로젝트",       # 이슈 원 사례
    "다음 검증이 읽지 못해 경고가 다시 난다",
    "판정이 만들지 않는다",
    "위 설치가 쓰는 기본 방식",
    "토큰이 빠지면 검증이 막도록 했다",
    "동기화가 값을 만든다",               # 목적어 어절 하나를 사이에 둔 꼴
    "비활성화가 결정한다",
    "변환이 정한 순서",
]
ACTION_NOUN_MISS = [
    "요청이 처리된다",                   # 피동
    "삭제가 수행되지 않고 닫힌다",
    "어느 쪽이든 늦으면 배포가 막히므로",
    "브라우저 자동화가 막힌다",
    "생성이 완료되었다",                 # 자동사
    "검증이 정해진 순서로 돈다",         # 정해지다 (피동)
    "문화가 만든 습관",                  # 2음절 + 화 는 동작 명사가 아니다
    "관리자가 처리한다",                 # 사람 주어
    "조회가 쓰기를 넘으면",              # 목록 밖 동사
]


# T8 물리 동사 「집다」 (#910). 집은 · 집고는 명사와 겹쳐 세지 않는다
PHYSICAL_VERB_HIT = ["작업을 집어 실행한다", "작업을 먼저 집습니다", "폴러가 작업을 집는다"]
PHYSICAL_VERB_MISS = ["값을 집어넣는다", "항목을 집어서 넣는다", "집계 결과를 본다", "집은 서울에 있다"]


def main() -> int:
    failures = []
    for s in ACTION_NOUN_HIT:
        if tc.action_noun_agent_count(s) != 1:
            failures.append(f"잡혀야 함: {s!r} → {tc.action_noun_agent_count(s)}")
    for s in ACTION_NOUN_MISS:
        if tc.action_noun_agent_count(s) != 0:
            failures.append(f"잡히면 안 됨: {s!r} → {tc.action_noun_agent_count(s)}")

    for s in PHYSICAL_VERB_HIT:
        if tc.physical_verb_count(s) != 1:
            failures.append(f"잡혀야 함: {s!r} → {tc.physical_verb_count(s)}")
    for s in PHYSICAL_VERB_MISS:
        if tc.physical_verb_count(s) != 0:
            failures.append(f"잡히면 안 됨: {s!r} → {tc.physical_verb_count(s)}")

    result = tc.compute_all("본문. 검증이 읽지 못한다.\n```\n검증이 읽지 못한다\n```\n")
    if result["metrics"].get("action_noun_agent_count") != 1:
        failures.append("compute_all: 코드 블록을 빼고 1건이어야 함")
    if "D-13" not in result["covers"]:
        failures.append("compute_all: covers 에 D-13 이 없음")

    total = len(ACTION_NOUN_HIT) + len(ACTION_NOUN_MISS) + len(PHYSICAL_VERB_HIT) + len(PHYSICAL_VERB_MISS) + 2
    for f in failures:
        print("FAIL", f)
    print(f"{total - len(failures)}/{total} 통과")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
