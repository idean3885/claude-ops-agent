#!/usr/bin/env python3
"""Stop 훅: 대화 언어와 다른 언어로 나간 응답을 사용자 턴이 끝나기 전에 막는다 (#792).

한국어 대화에서 영어 응답이 반복됐다. 언어 규칙은 세션 맨 앞에 한 번 실리고, 세션이 길어지면
도구 결과 · 서브 에이전트 보고 · 시스템 알림(영어) 뒤에서 응답이 영어로 넘어간다. 한 번 넘어가면
다음 응답이 앞의 영어 응답을 따라가 계속 영어가 된다. 규칙을 읽는 단계는 있었고 결과를 재는
단계가 없었다.

판정:
  1. 대화 언어: 사람이 친 입력을 마지막부터 거슬러 올라가 글자가 있는 첫 입력의 언어. 한글이 있으면 한국어.
     사람 입력은 origin.kind 가 human 이거나 origin 이 없는(SDK 화면) 입력이다. 그중 시스템이 남긴 형태
     (중단 표시 · bash 모드 입출력 · 슬래시 명령 · 로컬 명령 출력 · 압축 요약 · `!` 명령)는 건너뛴다.
     작업 알림처럼 origin 이 human 이 아닌 자동 입력도 건너뛴다. 한국어 대화가 아니면 아무것도 하지 않는다.
  2. 이번 턴의 응답: 마지막 입력(사람 · 자동) 뒤 어시스턴트 글을 빈 줄로 나눈 문단 하나하나.
     코드 블록 · 인라인 코드 · URL · 경로 · `>` 인용은 원문 언어를 유지하므로 세지 않는다.
     표 줄 · 상자 그림 줄 · 마크다운 링크 · 들여쓴 코드 · ~~~ 블록도 원문으로 세지 않는다. JSON 문단은 데이터라 세지 않는다.
  3. 문단의 한글 비율 = 한글 음절 / (한글 음절 + 로마자). 글자가 MIN_LETTERS 미만이면 세지 않는다.
     비율이 THRESHOLD 미만이고 영어 문장(기능어를 품은 로마자 낱말 셋 이상 연속)이 있는 문단이
     하나라도 있으면 막는다. 기능어 조건은 식별자 · 명령 · 이름 나열을 문장과 가르는 장치다.

기준값 근거 (2026-11-17 실측): 한 세션의 글 블록 단위로 한국어 최소 0.57, 영어 최대 0.15 라
그 사이의 0.3 을 둔다(한국어 쪽 여유를 크게 둠). 비율만으로는 표 · 링크 목록 · JSON · 식별자 같은 원문도 막혀(재생에서 막힌 턴의 15%),
영어 문장 조건과 원문 형태 제외를 더했다. 그 뒤 최근 120개 세션(CLI · SDK 화면) 3,025턴을 이 훅으로
재생하면 314턴(10.4%)이 막히고, 막힌 문단 표본 20개는 모두 영어 문장이었다.
재생은 세션 기록을 읽어 공개 레포에 두지 않는다.

막는 방법: {"decision": "block", "reason": ...} 를 내면 어시스턴트가 멈추지 않고 이어서 쓴다.
같은 턴에서 이미 한 번 막았으면(stop_hook_active) 다시 막지 않는다. 무한 반복을 막는 장치다.
"""
from __future__ import annotations

import json
import re
import sys

THRESHOLD = 0.3
MIN_LETTERS = 20
# why: 영어 대화에 한글 고유명사 한 낱말이 끼어도 한국어 대화로 보지 않는다
KOREAN_INPUT_RATIO = 0.2
# why: 「ok」 같은 짧은 로마자 입력은 언어를 정하지 못한다. 그 앞 입력으로 잰다
MIN_INPUT_LETTERS = 10

HANGUL = re.compile(r"[가-힣]")
LATIN = re.compile(r"[A-Za-z]")
FENCE = re.compile(r"```.*?```", re.S)
INLINE = re.compile(r"``[^\n]*?``|`[^`\n]*`")
URL = re.compile(r"https?://\S+")
PATH = re.compile(r"(?:[A-Za-z0-9_.@~-]+/)+[A-Za-z0-9_.@-]+")
QUOTE = re.compile(r"^[ \t]*(?:[-*][ \t]+)?>.*$", re.M)
# why: 표 · 상자 그림 줄 · 링크 · 들여쓴 코드는 원문이라 영어 문장이 아니다. 재생에서 이것만으로 막힌 턴이 많았다
TABLE_ROW = re.compile(r"^[ \t]*\|.*$", re.M)
DIAGRAM_ROW = re.compile(r"^.*[─│┌┐└┘├┤┬┴┼▶◀▲▼→←↓↑].*$", re.M)
LINK = re.compile(r"\[[^\]\n]*\]\([^)\n]*\)")
INDENTED_CODE = re.compile(r"^(?: {4}|\t).*$", re.M)
ALT_FENCE = re.compile(r"(~~~|````+).*?(?:\1|\Z)", re.S)
OPEN_FENCE = re.compile(r"```.*\Z", re.S)
WORD_RUN = re.compile(r"[A-Za-z']+(?:[ \t]*,?[ \t]+[A-Za-z']+){2,}")
FUNCTION_WORDS = frozenset(
    "the a an is are was were be been being to of and or but in on at for with this that these those "
    "it its i i'll i've i'm i'd we we'll we're you you'll your will would can could should not no so "
    "as by from if then than there here what which who when where how also now first next let me my "
    "our they them their has have had do does did".split()
)
IMAGE_MARK = re.compile(r"\[Image #\d+\]")
PASTED = re.compile(r"<pasted_content[^>]*>.*?</pasted_content[^>]*>", re.S)
COMMAND_ARGS = re.compile(r"<command-args>(.*?)</command-args>", re.S)
SYSTEM_PREFIXES = (
    "[Request interrupted", "<bash-input>", "<bash-stdout>", "<bash-stderr>", "<command-name>",
    "<command-message>", "<command-args>", "<local-command-stdout>", "<local-command-stderr>",
    "<task-notification>", "<system-reminder>",
)


def strip_verbatim(text: str) -> str:
    # why: 백틱 넷 블록 안의 ``` 를 먼저 지우면 바깥 블록이 깨진다. 긴 울타리부터 지운다
    for pattern in (ALT_FENCE, FENCE, OPEN_FENCE, INDENTED_CODE, INLINE, LINK, URL, PATH, QUOTE,
                    TABLE_ROW, DIAGRAM_ROW):
        text = pattern.sub(" ", text)
    return text


def letters(text: str) -> tuple[int, int]:
    body = strip_verbatim(text)
    return len(HANGUL.findall(body)), len(LATIN.findall(body))


def hangul_ratio(text: str) -> float | None:
    hangul, latin = letters(text)
    if hangul + latin < MIN_LETTERS:
        return None
    return hangul / (hangul + latin)


def is_json(text: str) -> bool:
    # why: 헤드리스 판정 세션은 한국어 지시에 JSON 한 줄로 답한다. 응답 언어가 아니라 데이터다
    body = text.strip()
    if not body or body[0] not in "{[":
        return False
    try:
        json.loads(body)
    except ValueError:
        return False
    return True


def has_english_sentence(text: str) -> bool:
    """기능어를 품은 로마자 낱말 셋 이상의 연속. 식별자 나열 · 명령 · 이름에는 거의 없다."""
    for run in WORD_RUN.findall(strip_verbatim(text)):
        words = {w.lower() for w in re.findall(r"[A-Za-z']+", run)}
        if words & FUNCTION_WORDS:
            return True
    return False


def user_text(entry: dict) -> str | None:
    """사람이 친 입력의 텍스트. 도구 결과 · 메타 항목이면 None."""
    if entry.get("type") != "user" or entry.get("isMeta"):
        return None
    content = entry.get("message", {}).get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        if any(isinstance(c, dict) and c.get("type") == "tool_result" for c in content):
            return None
        texts = [c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text"]
        return "\n".join(texts) if texts else None
    return None


def read_entries(path: str) -> list[dict]:
    entries = []
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return entries


def is_human(entry: dict, text: str) -> bool:
    """사람이 친 말인가. 시스템이 남긴 입력 형태와 자동 입력은 아니다."""
    origin = entry.get("origin")
    # why: CLI 는 사람 입력에도 origin.kind=human 을 붙인다. SDK 화면은 origin 을 붙이지 않는다
    if origin and (not isinstance(origin, dict) or origin.get("kind") != "human"):
        return False
    if entry.get("isCompactSummary"):
        return False
    head = text.lstrip()
    if head.startswith(("<command-message>", "<command-name>")):
        # why: 인자를 붙인 슬래시 명령은 인자가 사람이 쓴 말이다
        return bool(COMMAND_ARGS.search(text))
    return not head.startswith(("!", "/")) and not head.startswith(SYSTEM_PREFIXES)


def spoken_text(text: str) -> str:
    """사람 입력에서 사람이 쓴 말만. 이미지 표식 · 붙여넣은 원문 · 명령 틀은 뺀다."""
    args = COMMAND_ARGS.findall(text)
    if args and text.lstrip().startswith(("<command-message>", "<command-name>")):
        text = " ".join(args)
    return strip_verbatim(PASTED.sub(" ", IMAGE_MARK.sub(" ", text)))


def conversation_is_korean(entries: list[dict]) -> bool:
    for entry in reversed(entries):
        text = user_text(entry)
        if text is None:
            continue
        # why: 백그라운드 작업 알림 같은 자동 입력은 사람이 쓴 말이 아니다. 영어라 이것으로 재면
        # 영어 응답이 가장 잦은 자리(알림 직후)에서 검사가 꺼진다
        if not is_human(entry, text):
            continue
        body = spoken_text(text)
        hangul, latin = len(HANGUL.findall(body)), len(LATIN.findall(body))
        if hangul == 0 and latin < MIN_INPUT_LETTERS:
            continue
        return hangul / (hangul + latin) >= KOREAN_INPUT_RATIO
    return False


def split_paragraphs(text: str) -> list[str]:
    # why: 글 블록 하나에 한국어 문단과 영어 문단이 섞이면 합쳐 재서 영어 문단이 통과한다.
    # 코드 블록 안의 빈 줄로 나누지 않도록 코드 블록을 먼저 지운다
    return [p for p in re.split(r"\n[ \t]*\n", FENCE.sub(" ", ALT_FENCE.sub(" ", text))) if p.strip()]


def turn_paragraphs(entries: list[dict]) -> list[str]:
    last_user = max((i for i, e in enumerate(entries) if user_text(e) is not None), default=-1)
    paragraphs = []
    for entry in entries[last_user + 1:]:
        if entry.get("type") != "assistant":
            continue
        for block in entry.get("message", {}).get("content", []) or []:
            if isinstance(block, dict) and block.get("type") == "text":
                paragraphs.extend(split_paragraphs(block.get("text", "")))
    return paragraphs


def verdict(entries: list[dict]) -> dict | None:
    if not conversation_is_korean(entries):
        return None
    off = []
    for text in turn_paragraphs(entries):
        if is_json(text):
            continue
        ratio = hangul_ratio(text)
        if ratio is not None and ratio < THRESHOLD and has_english_sentence(text):
            off.append((ratio, text.strip().splitlines()[0][:60] if text.strip() else ""))
    if not off:
        return None
    lines = "\n".join(f"  - 한글 비율 {r:.2f}: {head}" for r, head in off)
    return {
        "decision": "block",
        "reason": (
            "[응답 언어] 대화 언어는 한국어인데 이번 턴에 한국어가 아닌 문단이 있다.\n"
            f"{lines}\n"
            "→ 그 문단들의 내용을 한국어로 다시 써서 이번 응답을 끝낸다. "
            "도구 결과 · 보고가 영어여도 응답은 한국어다. 원문(코드 · 명령 · 식별자 · 오류 문구)을 옮길 때는 "
            "백틱이나 `>` 인용으로 감싼다. 감싼 원문은 언어를 세지 않는다."
        ),
    }


def main() -> int:
    # why: 훅이 죽으면 검사만 빠지는 게 아니라 오류가 화면에 남는다. 예상 밖 입력은 통과로 둔다
    try:
        data = json.load(sys.stdin)
        if not isinstance(data, dict) or data.get("stop_hook_active"):
            return 0
        entries = [e for e in read_entries(data.get("transcript_path") or "") if isinstance(e, dict)]
        result = verdict(entries)
    except (OSError, ValueError, TypeError, AttributeError):
        return 0
    if result:
        print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
