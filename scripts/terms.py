#!/usr/bin/env python3
"""표준 용어 목록 검사와 세션 교정 줄 수집.

    python3 scripts/terms.py check [목록 경로]      항목 형식 · 문장 시험 예문 검사. 위반이면 종료 코드 1
    python3 scripts/terms.py collect <트랜스크립트>  어시스턴트 응답의 용어: · 차이: · 나눔: 줄을 JSON 으로 낸다

규칙 정본: config/style-rules/base/terms.md
"""

from __future__ import annotations

import json
import os
import re
import sys

DEFAULT_TERMS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "config", "style-rules", "base", "terms.md")
REQUIRED_FIELDS = ("섞어 쓴 말", "구분", "글", "말", "등재")
EXAMPLE_FIELDS = ("글", "말")
CORRECTION_LINE = re.compile(r"^(용어|차이|나눔):\s*\S")
FENCE_LINE = re.compile(r"^\s{0,3}(`{3,}|~{3,})(.*)$")


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


def main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[1] == "check":
        path = argv[2] if len(argv) > 2 else DEFAULT_TERMS
        with open(path, encoding="utf-8") as terms:
            problems = check(terms.read())
        for problem in problems:
            print(problem)
        return 1 if problems else 0
    if len(argv) == 3 and argv[1] == "collect":
        print(json.dumps(collect(argv[2]), ensure_ascii=False, indent=2))
        return 0
    print(__doc__.strip())
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
