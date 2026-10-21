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


def entry(title: str, first: str, second: str) -> str:
    return f"### {title}\n- 섞어 쓴 말: x\n- 구분: x\n- 글: 「{first} {second}」\n- 말: 「{first} {second}」\n- 등재: 2026-10-01\n"


def user(text: str) -> dict:
    return {"type": "user", "timestamp": "", "message": {"content": text}}


STATS_LIST = HEAD + entry("플러시 · 커밋", "플러시", "커밋") + entry("envelope", "envelope", "") \
    + entry("도메인 · 애그리거트 루트", "도메인", "애그리거트 루트") + entry("포트 계약 · HTTP 상태", "포트 계약", "HTTP 상태")
SESSIONS = {
    # 등재 당일: 등재를 만든 교정이 섞이므로 세지 않는다
    "2026-10-01": [user("플러시 커밋 envelope 포트 계약 HTTP 상태")],
    "2026-10-02": [user("플러시하고 커밋 envelope 포트 계약은 HTTP 상태를 모른다 도메인")],
    "2026-10-03": [user("플러시 다음 커밋 envelope 포트 계약 HTTP 상태 도메인"),
                   {"type": "user", "message": {"content": [{"type": "tool_result", "content": "envelope"}]}}],
    "2026-10-04": [user("플러시 커밋 envelope 도메인"),
                   {"type": "assistant", "message": {"content": [{"type": "text", "text": "용어: 봉투 → 「envelope」"}]}}],
    # 한쪽(커밋)만 사용자 발화에 있고 플러시는 시스템 블록 안에만 있다.
    # 섞어 쓴 말(도메인)만 쓰고 같은 세션에서 두 번 교정받았다
    "2026-10-05": [user("커밋만 <system-reminder>플러시</system-reminder> 도메인"),
                   {"type": "assistant", "message": {"content": [{"type": "text", "text": "용어: 도메인 → 「도메인 · 애그리거트 루트」"}]}},
                   {"type": "assistant", "message": {"content": [{"type": "text", "text": "용어: 루트 → 「애그리거트 루트」"}]}}],
}
with tempfile.TemporaryDirectory() as transcripts:
    for day, session in SESSIONS.items():
        with open(os.path.join(transcripts, f"{day}.jsonl"), "w", encoding="utf-8") as handle:
            for record in [{"type": "summary", "timestamp": f"{day}T03:00:00Z"}] + session:
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    report = terms.stats(STATS_LIST, transcripts)
by_title = {r["title"]: r for r in report["entries"]}
expect("등재 다음 날부터 세 세션 · 오답 0 이면 제거 후보 (당일 · 시스템 블록 · 한쪽만 제외)",
       by_title["플러시 · 커밋"]["useSessions"] == 3 and by_title["플러시 · 커밋"]["removable"])
expect("오답이 하나라도 있으면 제거 후보가 아니다 (도구 결과는 사용이 아니다)",
       by_title["envelope"]["useSessions"] == 3 and by_title["envelope"]["wrong"] == 1 and not by_title["envelope"]["removable"])
expect("쌍 항목은 두 용어가 모두 나와야 사용이고, 섞어 쓴 말만 쓰고 교정받은 세션은 사용 1 · 오답 1 (교정 두 줄도 1)",
       by_title["도메인 · 애그리거트 루트"]["useSessions"] == 1 and by_title["도메인 · 애그리거트 루트"]["wrong"] == 1)
expect("정답률은 0 과 1 사이", all(r["rate"] is None or 0 <= r["rate"] <= 1 for r in report["entries"]))
expect("사용 세션이 셋 미만이면 정답률 100% 여도 제거 후보가 아니다",
       by_title["포트 계약 · HTTP 상태"]["useSessions"] == 2 and not by_title["포트 계약 · HTTP 상태"]["removable"])
expect("제거 후보 목록", report["removable"] == ["플러시 · 커밋"])

many = HEAD + "".join(entry(f"용어{i}", f"용어{i}", "") for i in range(terms.LIST_LIMIT))
with tempfile.TemporaryDirectory() as empty:
    expect("상한 이하면 누적 알림 없음", not terms.stats(many, empty)["overLimit"])
    expect("상한을 넘으면 누적 알림", terms.stats(many + entry("하나 더", "하나 더", ""), empty)["overLimit"])

print(f"\n{'전부 통과' if not failures else f'{failures}건 실패'}")
sys.exit(1 if failures else 0)
