#!/usr/bin/env python3
"""표준 용어 목록 검사와 세션 교정 줄 수집 · 정답률 집계.

    python3 scripts/terms.py check [목록 경로]      항목 형식 · 문장 시험 예문 검사. 위반이면 종료 코드 1
    python3 scripts/terms.py collect <트랜스크립트>  어시스턴트 응답의 용어: · 차이: · 나눔: 줄을 JSON 으로 낸다
    python3 scripts/terms.py stats [목록 경로] [트랜스크립트 디렉토리]
                                                   항목별 사용 세션 · 오답 · 정답률과 제거 후보 · 누적 알림을 JSON 으로 낸다

규칙 정본: config/style-rules/base/terms.md
"""

from __future__ import annotations

import datetime
import glob
import json
import os
import re
import sys

DEFAULT_TERMS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "config", "style-rules", "base", "terms.md")
REQUIRED_FIELDS = ("섞어 쓴 말", "구분", "글", "말", "등재")
EXAMPLE_FIELDS = ("글", "말")
CORRECTION_LINE = re.compile(r"^(용어|차이|나눔):\s*\S")
FENCE_LINE = re.compile(r"^\s{0,3}(`{3,}|~{3,})(.*)$")
DEFAULT_TRANSCRIPTS = os.path.expanduser("~/.claude/projects")
# 등재 직후 한 번 맞게 쓴 것만으로 100% 가 되지 않게, 서로 다른 세션에서 이만큼 써야 제거 후보다
MIN_USE_SESSIONS = 3
# 항목당 6~7줄이라 약 100줄. 한 번에 훑어 판정할 수 있는 크기의 상한이다
LIST_LIMIT = 15
SYSTEM_BLOCK = re.compile(r"<(system-reminder|local-command-[a-z]+|command-[a-z]+)>.*?</\1>", re.S)
CORRECTION_TARGET = re.compile(r"→\s*「([^」]+)」")


def parse_entries(text: str) -> list[tuple[str, dict[str, str]]]:
    body = text.split("\n## 항목\n", 1)
    if len(body) < 2:
        return []
    entries: list[tuple[str, dict[str, str]]] = []
    for line in body[1].splitlines():
        if line.startswith("### "):
            entries.append((line[4:].strip(), {}))
        elif entries and line.startswith("- ") and ": " in line:
            key, value = line[2:].split(": ", 1)
            entries[-1][1][key.strip()] = value.strip()
    return entries


def check(text: str) -> list[str]:
    entries = parse_entries(text)
    if not entries:
        return ["「## 항목」 절에 항목이 없다"]
    problems = []
    for title, fields in entries:
        for name in REQUIRED_FIELDS:
            if not fields.get(name):
                problems.append(f"{title}: 「{name}」 없음")
        for name in EXAMPLE_FIELDS:
            example = fields.get(name, "")
            if not example:
                continue
            if not (example.startswith("「") and example.endswith("」")):
                problems.append(f"{title}: 「{name}」 예문은 「」 로 감싼 문장이다")
            for term in (t.strip() for t in title.split(" · ")):
                if term not in example:
                    problems.append(f"{title}: 「{name}」 예문에 「{term}」 이 없다 (문장 시험)")
        registered = fields.get("등재", "")
        if registered and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", registered):
            problems.append(f"{title}: 등재일 형식은 YYYY-MM-DD")
    return problems


def collect(transcript_path: str) -> list[dict[str, str]]:
    found = []
    with open(transcript_path, encoding="utf-8") as transcript:
        for raw in transcript:
            try:
                record = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if record.get("type") != "assistant":
                continue
            content = record.get("message", {}).get("content", [])
            if isinstance(content, str):
                content = [{"type": "text", "text": content}]
            for block in content:
                if block.get("type") != "text":
                    continue
                open_fence = ""
                for line in block.get("text", "").splitlines():
                    fence = FENCE_LINE.match(line)
                    if fence:
                        marker, rest = fence.groups()
                        if not open_fence:
                            open_fence = marker
                            continue
                        # 닫는 펜스: 연 펜스와 같은 문자이고 길이가 같거나 길며 뒤에 공백만 온다 (CommonMark)
                        if marker[0] == open_fence[0] and len(marker) >= len(open_fence) and not rest.strip():
                            open_fence = ""
                            continue
                    match = CORRECTION_LINE.match(line) if not open_fence else None
                    if match:
                        found.append({"kind": match.group(1), "line": line.strip(), "timestamp": record.get("timestamp", "")})
    return found


def user_texts(transcript_path: str) -> tuple[str, list[str]]:
    """세션 시작 시각(로컬 날짜)과 사용자가 직접 쓴 발화를 낸다. 도구 결과 · 메타 · 시스템 블록은 제외한다."""
    started = ""
    texts = []
    with open(transcript_path, encoding="utf-8") as transcript:
        for raw in transcript:
            try:
                record = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not started and record.get("timestamp"):
                started = record["timestamp"]
            if record.get("type") != "user" or record.get("isMeta"):
                continue
            content = record.get("message", {}).get("content", [])
            if isinstance(content, str):
                content = [{"type": "text", "text": content}]
            for block in content:
                if block.get("type") == "text":
                    texts.append(SYSTEM_BLOCK.sub("", block.get("text", "")))
    return local_date(started), texts


def local_date(timestamp: str) -> str:
    if not timestamp:
        return ""
    moment = datetime.datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    return moment.astimezone().date().isoformat()


def stats(text: str, transcript_dir: str) -> dict:
    entries = parse_entries(text)
    earliest = min((fields.get("등재", "") for _, fields in entries), default="")
    sessions = []
    for path in glob.glob(os.path.join(transcript_dir, "**", "*.jsonl"), recursive=True):
        modified = datetime.date.fromtimestamp(os.path.getmtime(path)).isoformat()
        if earliest and modified <= earliest:
            continue
        started, texts = user_texts(path)
        targets = [CORRECTION_TARGET.search(c["line"]) for c in collect(path) if c["kind"] == "용어"]
        sessions.append((started, "\n".join(texts), [t.group(1).strip() for t in targets if t]))
    report = []
    for title, fields in entries:
        registered = fields.get("등재", "")
        terms = [t.strip() for t in title.split(" · ")]
        # 등재일 당일 세션은 등재를 만든 교정이 섞이므로 다음 날부터 집계한다
        after = [s for s in sessions if s[0] > registered]
        used = wrong = 0
        for _, joined, targets in after:
            # 쌍 항목은 두 용어가 모두 나와야 그 구분을 다룬 세션이다. 한쪽이 일반어면 한쪽만 집계하면 부풀려진다
            mentioned = all(t.lower() in joined.lower() for t in terms)
            # 섞어 쓴 말만 쓰고 교정받은 세션은 표준 용어가 발화에 없다. 버리면 틀린 기록이 사라진다
            corrected = any(target == title or target in terms for target in targets)
            if mentioned or corrected:
                used += 1
                wrong += corrected
        rate = (used - wrong) / used if used else None
        report.append({
            "title": title,
            "registered": registered,
            "useSessions": used,
            "wrong": wrong,
            "rate": rate,
            "removable": used >= MIN_USE_SESSIONS and wrong == 0,
        })
    return {
        "entries": report,
        "count": len(entries),
        "limit": LIST_LIMIT,
        "overLimit": len(entries) > LIST_LIMIT,
        "removable": [r["title"] for r in report if r["removable"]],
    }


def main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[1] == "check":
        path = argv[2] if len(argv) > 2 else DEFAULT_TERMS
        with open(path, encoding="utf-8") as terms:
            problems = check(terms.read())
        for problem in problems:
            print(problem)
        return 1 if problems else 0
    if len(argv) >= 2 and argv[1] == "stats":
        path = argv[2] if len(argv) > 2 else DEFAULT_TERMS
        transcript_dir = argv[3] if len(argv) > 3 else DEFAULT_TRANSCRIPTS
        with open(path, encoding="utf-8") as terms:
            print(json.dumps(stats(terms.read(), transcript_dir), ensure_ascii=False, indent=2))
        return 0
    if len(argv) == 3 and argv[1] == "collect":
        print(json.dumps(collect(argv[2]), ensure_ascii=False, indent=2))
        return 0
    print(__doc__.strip())
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
