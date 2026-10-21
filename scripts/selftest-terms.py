#!/usr/bin/env python3
"""terms.py 자체 점검.

문장 시험 예문이 빠진 항목을 통과시키면 검사가 있는 것만으로 등재가 끝난 것처럼 보인다.
잡혀야 하는 항목과 통과해야 하는 항목을 고정해 그 붕괴를 잡는다.

    python3 scripts/selftest-terms.py
"""

from __future__ import annotations

import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import terms  # noqa: E402

HEAD = "# 표준 용어\n\n## 항목\n\n"
VALID = HEAD + """### 스키마 · 테이블 정의
- 섞어 쓴 말: 스키마
- 구분: 그릇과 구조
- 글: 「두 스키마에 같은 테이블 정의를 적용했다.」
- 말: 「스키마 둘 다 테이블 정의를 맞춰 놨어요.」
- 등재: 2026-10-21
"""

failures = 0


def expect(name: str, ok: bool) -> None:
    global failures
    print(("OK  " if ok else "FAIL") + " " + name)
    if not ok:
        failures += 1


expect("정상 항목은 통과", terms.check(VALID) == [])
expect("말 예문 없음은 실패", any("「말」 없음" in p for p in terms.check(VALID.replace("- 말: 「스키마 둘 다 테이블 정의를 맞춰 놨어요.」\n", ""))))
expect("글 예문 없음은 실패", any("「글」 없음" in p for p in terms.check(VALID.replace("- 글: 「두 스키마에 같은 테이블 정의를 적용했다.」\n", ""))))
expect("말 예문에 표준 용어 하나가 빠지면 실패", any("「말」 예문에 「테이블 정의」" in p for p in terms.check(VALID.replace("테이블 정의를 맞춰", "구조를 맞춰"))))
expect("예문이 「」 로 감싸지 않으면 실패", any("「」 로 감싼" in p for p in terms.check(VALID.replace("「두 스키마에 같은 테이블 정의를 적용했다.」", "두 스키마에 같은 테이블 정의를 적용했다."))))
expect("등재일 형식 오류는 실패", any("등재일" in p for p in terms.check(VALID.replace("2026-10-21", "10/21"))))
expect("항목 없는 목록은 실패", terms.check(HEAD) != [])

real = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "config", "style-rules", "base", "terms.md")
with open(real, encoding="utf-8") as handle:
    expect("저장소의 terms.md 가 통과", terms.check(handle.read()) == [])

records = [
    {"type": "user", "message": {"content": "용어: 사용자 발화는 세지 않는다"}},
    {"type": "assistant", "timestamp": "t1", "message": {"content": [{"type": "text", "text": "용어: 스키마(테이블 구조) · 스키마(그릇) → 「테이블 정의」 · 「스키마」\n\n본론"}]}},
    {"type": "assistant", "timestamp": "t2", "message": {"content": [{"type": "text", "text": "```markdown\n용어: 코드 블록 안 예시는 세지 않는다\n```\n차이: 회고에는 답 검산이 없다"}]}},
    {"type": "assistant", "timestamp": "t3", "message": {"content": [{"type": "tool_use", "name": "Bash"}]}},
    {"type": "assistant", "timestamp": "t4", "message": {"content": [{"type": "text", "text": "~~~markdown\n용어: 물결 펜스 안은 세지 않는다\n~~~"}]}},
    {"type": "assistant", "timestamp": "t5", "message": {"content": [{"type": "text", "text": "````\n```\n용어: 네 백틱 펜스 안의 세 백틱 줄은 닫지 않는다\n```\n````\n나눔: 회고 ← 되돌아보기(검산) · 포스트모템(장애 원인)"}]}},
]
with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False, encoding="utf-8") as handle:
    handle.write("\n".join(json.dumps(r, ensure_ascii=False) for r in records) + "\nnot json\n")
    fixture = handle.name
collected = terms.collect(fixture)
os.unlink(fixture)
expect("어시스턴트의 교정 줄만 모은다 (코드 펜스 안 제외)", [c["kind"] for c in collected] == ["용어", "차이", "나눔"])
expect("수집 줄에 타임스탬프가 붙는다", [c["timestamp"] for c in collected] == ["t1", "t2", "t5"])

print(f"\n{'전부 통과' if not failures else f'{failures}건 실패'}")
sys.exit(1 if failures else 0)
