#!/usr/bin/env python3
"""terms.py 자체 점검.

문장 시험 예문이 빠진 항목을 통과시키면 검사가 있는 것만으로 등재가 끝난 것처럼 보인다.
잡혀야 하는 항목과 통과해야 하는 항목을 고정해 그 붕괴를 잡는다.

    python3 scripts/selftest-terms.py
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
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
ENTRY = VALID[len(HEAD):]
OUTSIDE = "# 표준 용어\n\n## 제거 조건\n\n" + ENTRY + "\n" + VALID
expect("「## 항목」 밖 절에 놓인 항목은 실패", any("「## 제거 조건」 절에 있다" in p for p in terms.check(OUTSIDE)))
INLINE = "# 표준 용어\n\n## 제거 조건\n\n- 다 익힌 항목은 「" + ENTRY + "## 익힌 항목」 절로 옮긴다\n\n" + VALID
expect("문장 안에 끼어든 항목 제목은 실패", any("문장 안에 항목 제목" in p for p in terms.check(INLINE)))
FENCED = "# 표준 용어\n\n## 항목 형식\n\n```markdown\n### 표준 용어\n- 섞어 쓴 말: x\n```\n\n" + VALID
expect("코드 펜스 안의 예시 제목은 통과", terms.check(FENCED) == [])
INLINE_CODE = "# 표준 용어\n\n## 등재 조건\n\n- 항목 제목은 `### 표준 용어` 로 쓴다\n\n" + VALID
expect("줄 안 코드 표기 속 제목 예시는 통과", terms.check(INLINE_CODE) == [])
OTHER = VALID + """
### 리더 · 팔로워
- 섞어 쓴 말: 마스터
- 구분: 합의 그룹의 쓰기 노드와 따르는 노드
- 글: 「리더가 내려가면 팔로워 중 하나가 리더가 된다.」
- 말: 「리더 죽으면 팔로워가 넘겨받아요.」
- 다른 세트: 「프라이머리 · 레플리카」(RDB) 쓰기 노드를 프라이머리라 부른다.
- 등재: 2026-11-19

### 프라이머리 · 레플리카
- 섞어 쓴 말: 리더
- 구분: 쓰기 노드와 읽기 전용 노드
- 글: 「조회는 레플리카로, 쓰기는 프라이머리로 보낸다.」
- 말: 「쓰기는 프라이머리, 조회는 레플리카예요.」
- 다른 세트: 「리더 · 팔로워」(Raft) 합의로 리더를 고른다. 「소스 · 레플리카」(MySQL 엔진) 엔진 안의 이름이다.
- 등재: 2026-11-19
"""
expect("서로 가리키는 다른 세트는 통과", terms.check(OTHER) == [])
ONE_WAY = OTHER.replace("- 다른 세트: 「프라이머리 · 레플리카」(RDB) 쓰기 노드를 프라이머리라 부른다.\n", "")
expect("한쪽에서만 가리키는 다른 세트는 실패", any("(양방향)" in p for p in terms.check(ONE_WAY)))
expect("목록 밖 다른 세트는 한쪽이어도 통과", not any("소스 · 레플리카" in p for p in terms.check(ONE_WAY)))
expect("다른 세트 형식 오류는 실패", any("으로 시작한다" in p for p in terms.check(OTHER.replace("「리더 · 팔로워」(Raft)", "리더 · 팔로워(Raft)"))))
LEARNED_ONE_WAY = HEAD + OTHER.split("### 프라이머리 · 레플리카", 1)[1].join(["### 프라이머리 · 레플리카", ""]) + """
## 익힌 항목

### 리더 · 팔로워
- 섞어 쓴 말: 마스터
- 구분: 합의 그룹의 쓰기 노드와 따르는 노드
- 글: 「리더가 내려가면 팔로워 중 하나가 리더가 된다.」
- 말: 「리더 죽으면 팔로워가 넘겨받아요.」
- 등재: 2026-11-19
- 익힘: 2026-11-19
"""
expect("익힌 항목과도 양방향을 검사한다", any("(양방향)" in p for p in terms.check(LEARNED_ONE_WAY)))
# 반대 방향: 익힌 항목만 학습 중 항목을 가리킨다
LEARNED_POINTS = (HEAD + OTHER.split("### 프라이머리 · 레플리카", 1)[1].join(["### 프라이머리 · 레플리카", ""])
                  .replace("- 다른 세트: 「리더 · 팔로워」(Raft) 합의로 리더를 고른다. 「소스 · 레플리카」(MySQL 엔진) 엔진 안의 이름이다.\n", "")
                  + "\n## 익힌 항목\n\n" + OTHER.split("### 리더 · 팔로워", 1)[1].split("### 프라이머리", 1)[0].join(["### 리더 · 팔로워", ""]).rstrip("\n") + "\n- 익힘: 2026-11-19\n")
expect("익힌 항목에서 한쪽만 가리켜도 실패", any(p.startswith("리더 · 팔로워:") and "(양방향)" in p for p in terms.check(LEARNED_POINTS)))
expect("자기 제목을 다른 세트로 적으면 실패", any("자기 제목" in p for p in terms.check(OTHER.replace("「리더 · 팔로워」(Raft)", "「프라이머리 · 레플리카」(RDB)"))))

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
expect("두 용어로 된 항목은 두 용어가 모두 나와야 사용이고, 섞어 쓴 말만 쓰고 교정받은 세션은 사용 1 · 오답 1 (교정 두 줄도 1)",
       by_title["도메인 · 애그리거트 루트"]["useSessions"] == 1 and by_title["도메인 · 애그리거트 루트"]["wrong"] == 1)
expect("정답률은 0 과 1 사이", all(r["rate"] is None or 0 <= r["rate"] <= 1 for r in report["entries"]))
expect("사용 세션이 셋 미만이면 정답률 100% 여도 제거 후보가 아니다",
       by_title["포트 계약 · HTTP 상태"]["useSessions"] == 2 and not by_title["포트 계약 · HTTP 상태"]["removable"])
expect("제거 후보 목록", report["removable"] == ["플러시 · 커밋"])

LEARNED = VALID + """
## 익힌 항목

### RACI
- 섞어 쓴 말: RaCI
- 구분: 책임 배정표
- 글: 「역할은 RACI 로 나눴다.」
- 말: 「역할은 RACI 로 나눴어요.」
- 등재: 2026-10-22
- 익힘: 2026-10-30
"""
expect("익힌 항목은 학습 중 항목으로 읽지 않는다", [t for t, _ in terms.parse_entries(LEARNED)] == ["스키마 · 테이블 정의"])
expect("익힌 항목 절을 따로 읽는다", [t for t, _ in terms.parse_entries(LEARNED, "익힌 항목")] == ["RACI"])
expect("익힌 항목도 형식 검사를 받는다", any("RACI: 「말」 없음" in p for p in terms.check(LEARNED.replace("- 말: 「역할은 RACI 로 나눴어요.」\n", ""))))
expect("익힘 날짜 형식", any("익힘" in p for p in terms.check(LEARNED.replace("익힘: 2026-10-30", "익힘: 10/30"))))
expect("학습 중 항목에 익힘 날짜가 있으면 실패 (옮기지 않음)", any("「## 익힌 항목」으로 옮긴다" in p for p in terms.check(VALID + "- 익힘: 2026-10-30\n")))
ONLY_LEARNED = LEARNED.replace(VALID[len(HEAD):], "")
expect("학습 중 항목이 비어도 익힌 항목만 있으면 통과", terms.check(ONLY_LEARNED) == [])
expect("학습 중 항목이 비어도 익힌 항목은 형식 검사를 받는다", any("RACI: 「말」 없음" in p for p in terms.check(ONLY_LEARNED.replace("- 말: 「역할은 RACI 로 나눴어요.」\n", ""))))
expect("익힌 항목은 익힘 날짜가 있어야 한다", any("RACI: 「익힘」 없음" in p for p in terms.check(LEARNED.replace("- 익힘: 2026-10-30\n", ""))))
with tempfile.TemporaryDirectory() as empty:
    expect("익힌 항목은 집계하지 않는다", [r["title"] for r in terms.stats(LEARNED, empty)["entries"]] == ["스키마 · 테이블 정의"])
    expect("개수 상한 표시는 없다", not {"limit", "overLimit"} & terms.stats(LEARNED, empty).keys())

# 세션 시작 주입은 실제 진입점을 실행해 본다. 주입되는 것은 원천의 학습 중 항목이다
# 훅은 플러그인 루트의 git 설정을 맞추므로 저장소가 아니라 임시 사본에서 실행한다
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
with open(os.path.join(root, "config", "style-rules", "base", "terms.md"), encoding="utf-8") as source:
    source_text = source.read()
with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as plugin:
    for rel in (("scripts", "session-start.mjs"), ("config", "style-rules", "base", "terms.md")):
        os.makedirs(os.path.join(plugin, *rel[:-1]), exist_ok=True)
        shutil.copy(os.path.join(root, *rel), os.path.join(plugin, *rel))
    run = subprocess.run(["node", os.path.join(plugin, "scripts", "session-start.mjs")],
                         input=json.dumps({"cwd": home}), capture_output=True, text=True,
                         env={**os.environ, "HOME": home}, timeout=60)
context = json.loads(run.stdout)["hookSpecificOutput"]["additionalContext"] if run.returncode == 0 else ""
section = context.split("[표준 용어", 1)[1].split("\n\n", 1)[0] if "[표준 용어" in context else ""
learning = terms.parse_entries(source_text)
expect("머리줄은 걸리면 원천의 항목을 읽고 교정하라고 안내한다", "원천의 그 항목(구분 · 예문)을 읽고 교정한다" in section)
expect("주입은 항목마다 「표준 용어: 섞어 쓴 말」 한 줄",
       bool(learning) and all(f"- {t}: {f['섞어 쓴 말']}" in section for t, f in learning))
expect("주입에 구분은 넣지 않는다 (교정할 때 원천에서 연다)",
       bool(section) and not any(f["구분"] in section for _, f in learning))
# 줄 전체를 맞춘다. 포함 비교면 갈리는 지점이 뒤에 붙거나 빈 「다른 세트」가 붙어도 통과한다
section_lines = section.splitlines()
def expected_line(t: str, f: dict) -> str:
    names = " ".join(f"「{n}」({w})" for n, w in terms.OTHER_SET.findall(f.get("다른 세트", "")))
    return f"- {t}: {f['섞어 쓴 말']}" + (f" / 다른 세트: {names}" if names else "")
expect("다른 세트가 있는 항목은 같은 줄에 이름과 쓰는 곳만 붙는다",
       any(f.get("다른 세트") for _, f in learning) and all(expected_line(t, f) in section_lines for t, f in learning if f.get("다른 세트")))
expect("다른 세트가 없는 항목의 줄은 섞어 쓴 말로 끝난다",
       bool(section_lines) and all(expected_line(t, f) in section_lines for t, f in learning if not f.get("다른 세트")))
expect("인덱스는 머리줄 아래 항목 줄만 싣는다 (갈리는 지점 · 다른 줄 없음)",
       section_lines[1:] == [expected_line(t, f) for t, f in learning])
expect("머리줄은 인덱스가 다른 세트를 싣는다고 알린다", "「표준 용어: 섞어 쓴 말 / 다른 세트」 인덱스다" in section)
expect("익힌 항목은 주입하지 않는다",
       bool(section) and not any(f"- {t}: " in section for t, _ in terms.parse_entries(source_text, "익힌 항목")))

# 검출 칸: 응답 검사 훅이 읽는 자리라 깨지면 신호 없이 검출이 빠진다
DETECT = VALID.replace("- 등재: 2026-10-21", "- 검출: `스키마\\s?정의` → 「테이블 정의」\n- 등재: 2026-10-21")
expect("검출 칸이 맞으면 통과", terms.check(DETECT) == [])
expect("검출 칸은 룰로 나온다",
       terms.detection_rules(DETECT) == [{"title": "스키마 · 테이블 정의", "pattern": r"스키마\s?정의", "replacement": "테이블 정의"}])
expect("검출 칸 형식 오류는 실패", any("「검출」은" in p for p in terms.check(DETECT.replace(" → 「테이블 정의」", ""))))
expect("검출 정규식이 컴파일되지 않으면 실패", any("컴파일" in p for p in terms.check(DETECT.replace(r"스키마\s?정의", "스키마(정의"))))
expect("검출 대체어가 제목의 표준 용어가 아니면 실패", any("대체어" in p for p in terms.check(DETECT.replace("→ 「테이블 정의」", "→ 「구조」"))))
expect("깨진 검출 칸은 룰로 나오지 않는다", terms.detection_rules(DETECT.replace(r"스키마\s?정의", "스키마(정의")) == [])
LEARNED_DETECT = HEAD.replace("## 항목\n\n", "## 항목\n\n## 익힌 항목\n\n") + DETECT[len(HEAD):].replace("- 등재: 2026-10-21", "- 등재: 2026-10-21\n- 익힘: 2026-11-01")
expect("익힌 항목의 검출 칸도 룰로 나온다 (다시 섞이면 되돌릴 신호)", len(terms.detection_rules(LEARNED_DETECT)) == 1)
expect("검출 칸 없는 항목은 룰이 없다", terms.detection_rules(VALID) == [])

print(f"\n{'전부 통과' if not failures else f'{failures}건 실패'}")
sys.exit(1 if failures else 0)
