#!/usr/bin/env python3
"""응답 언어 훅: 한국어 대화에서 영어로 넘어간 글을 답변을 만드는 중에 알아채게 한다 (#792, #1080).

한국어 대화에서 영어 응답이 반복됐다. 언어 규칙은 세션 맨 앞에 한 번 실리고, 세션이 길어지면
도구 결과 · 서브 에이전트 보고 · 시스템 알림(영어) 뒤에서 응답이 영어로 넘어간다.

이미 내보낸 글은 고칠 수 없다. 턴 끝(Stop)에서 막고 다시 쓰게 하면 사용자가 읽고 지나간 문단의
번역이 응답 끝에 덧붙을 뿐이다 (#1080). 그래서 두 자리에서 다르게 다룬다.

  PostToolUse (답변을 만드는 중): 도구 호출 하나가 끝날 때마다 그 호출 앞에 쓴 글을 잰다.
    - 한 문단뿐인 글은 도구 호출 전 진행 문장 · 스킬 호출 문구로 보고 막지 않는다. 영어면 그 턴에서
      처음 한 번만 「다음 글부터 한국어로」를 알린다. 지나간 문장은 다시 쓰지 않게 한다.
    - 여러 문단인 글에 영어 문단이 있으면 바로 다음 글에서 그 내용을 한국어로 다시 내게 한다.
    병렬 호출은 그 묶음의 첫 호출에서만 잰다.
  Stop (턴 끝): 마지막 글(입력의 last_assistant_message)을 잰다. Stop 시점에는 그 글이 세션 기록에
    아직 없다. 영어 문단이 있어도 막지 않는다.
    사용자에게 「작업을 마친 뒤 새 세션에서 이어 가라」는 안내 한 줄(systemMessage)만 낸다.

진행 문장을 한 문단으로 가른 근거 (2026-11-18 실측): 최근 120개 세션에서 도구 호출 전 영어 글
319건이 모두 한 문단(최대 230자)이었고, 턴 끝 영어 답변 25건 중 17건은 여러 문단이었다.
PostToolUse 시점에 그 호출 앞의 글이 세션 기록에 있고, PreToolUse · Stop 시점에는 없다(같은 날 헤드리스 세션 실측).

문단 판정:
  1. 대화 언어: 사람이 친 입력을 마지막부터 거슬러 올라가 글자가 있는 첫 입력의 언어. 한글이 있으면 한국어.
     사람 입력은 origin.kind 가 human 이거나 origin 이 없는(SDK 화면) 입력이다. 그중 시스템이 남긴 형태
     (중단 표시 · bash 모드 입출력 · 슬래시 명령 · 로컬 명령 출력 · 압축 요약 · `!` 명령)는 건너뛴다.
     작업 알림처럼 origin 이 human 이 아닌 자동 입력도 건너뛴다. 한국어 대화가 아니면 아무것도 하지 않는다.
  2. 어시스턴트 글을 빈 줄로 나눈 문단 하나하나를 잰다.
     코드 블록 · 인라인 코드 · URL · 경로 · `>` 인용은 원문 언어를 유지하므로 세지 않는다.
     표 줄(줄 머리 `|` 없는 표 포함) · 상자 · 화살표 그림 줄 · 마크다운 링크 · 들여쓴 코드 · ~~~ 블록도 원문으로 세지 않는다.
     `>` 인용에 이어 붙은 줄(빈 줄 전까지)은 인용의 일부다. JSON 문단과 문단 안의 JSON 줄은 데이터라 세지 않는다 (#1076).
  3. 문단의 한글 비율 = 한글 음절 / (한글 음절 + 로마자). 글자가 MIN_LETTERS 미만이면 세지 않는다.
     비율이 THRESHOLD 미만이고 영어 문장(기능어를 품은 로마자 낱말 셋 이상 연속)이 있는 문단을 영어 문단으로 본다.
     기능어 조건은 식별자 · 명령 · 이름 나열을 문장과 가르는 장치다. 하이픈 · 밑줄 식별자와 `-x` 옵션은 낱말로 세지 않는다.
     한글이 없는 문단은 낱말 셋 이상에 기능어가 하나만 있어도, 또는 대문자로 시작해 마침표로 끝나는 소문자 낱말 문장이면
     영어로 본다 (「Next, #811 (...)」 같은 기능어 없는 짧은 진행 서술, #1076).

기준값 근거 (2026-11-17 실측): 한 세션의 글 블록 단위로 한국어 최소 0.57, 영어 최대 0.15 라
그 사이의 0.3 을 둔다(한국어 쪽 여유를 크게 둠). 비율만으로는 표 · 링크 목록 · JSON · 식별자 같은 원문도 걸려,
영어 문장 조건과 원문 형태 제외를 더했다. 재생은 세션 기록을 읽어 공개 레포에 두지 않는다.
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
# why: 인용 줄 바로 뒤에 `>` 없이 이어지는 줄도 마크다운에서는 인용의 일부다 (빈 줄이나 새 블록 전까지)
QUOTE = re.compile(r"^[ \t]*(?:[-*][ \t]+)?>.*(?:\n(?![ \t]*(?:\n|[#>|`~]|[-*+][ \t]|\d+[.)][ \t]))[^\n]+)*", re.M)
# why: 표 · 상자 그림 줄 · 링크 · 들여쓴 코드는 원문이라 영어 문장이 아니다. 재생에서 이것만으로 막힌 턴이 많았다
TABLE_ROW = re.compile(r"^[ \t]*\|.*$", re.M)
DIAGRAM_ROW = re.compile(r"^.*[─│┌┐└┘├┤┬┴┼▶◀▲▼→←↓↑].*$", re.M)
TABLE_PIPES = re.compile(r"^[^\n|]*\|[^\n|]*\|.*$", re.M)
TABLE_SEPARATOR = re.compile(r"^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*\|[ \t:|-]*$", re.M)
PIPE_LINE = re.compile(r"^.*\|.*$", re.M)
# why: 한글이 든 줄은 설명 문장일 수 있어 지우지 않는다. 한 줄짜리 한국어 입력이 통째로 사라지면 대화 언어를 못 정한다
ASCII_ARROW_ROW = re.compile(r"^(?![^\n]*[가-힣])[^\n]*(?:-+>|=+>|<-+)[^\n]*$", re.M)
ASCII_BOX_ROW = re.compile(r"^[ \t]*\+[-=+]{3,}.*$", re.M)
JSON_ROW = re.compile(r'^[ \t]*(?:[{}\]]|\[[ \t]*(?:[{"\[\d-]|$)|"[^"\n]*"[ \t]*(?::|,?[ \t]*$)).*$', re.M)
LINK = re.compile(r"\[[^\]\n]*\]\([^)\n]*\)")
INDENTED_CODE = re.compile(r"^(?: {4}|\t).*$", re.M)
ALT_FENCE = re.compile(r"(~~~|````+).*?(?:\1|\Z)", re.S)
CLOSED_ALT_FENCE = re.compile(r"(~~~|````+).*?\1", re.S)
HYPHEN_ID = re.compile(r"[A-Za-z0-9_.]+(?:-[A-Za-z0-9_.]+)+|[A-Za-z0-9]*_[A-Za-z0-9_]*")
OPTION = re.compile(r"(?<![\w-])--?[A-Za-z][\w-]*")
SENTENCE = re.compile(r"[A-Z][^\n]*[.!?:]")
OPEN_FENCE = re.compile(r"```.*\Z", re.S)
WORD_RUN = re.compile(r"[A-Za-z']+(?:[ \t]*,?[ \t]+[A-Za-z']+){2,}")
FUNCTION_WORDS = frozenset(
    "the a an is are was were be been being to of and or but in on at for with this that these those "
    "it its i i'll i've i'm i'd we we'll we're you you'll your will would can could should not no so "
    "as by from if then than there here what which who when where how also now first next let me my "
    "our they them their has have had do does did before after still again instead until while about into only just".split()
)
IMAGE_MARK = re.compile(r"\[Image #\d+\]")
PASTED = re.compile(r"<pasted_content[^>]*>.*?</pasted_content[^>]*>", re.S)
COMMAND_ARGS = re.compile(r"<command-args>(.*?)</command-args>", re.S)
SYSTEM_REMINDER = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)
# why: 슬래시 명령은 `/이름` 뒤가 공백이나 끝이다. `/Users/...` 로 시작하는 경로 입력은 사람이 쓴 말이다
SLASH_COMMAND = re.compile(r"/[\w:.-]+(?:\s|\Z)")
SYSTEM_PREFIXES = (
    "[Request interrupted", "<bash-input>", "<bash-stdout>", "<bash-stderr>", "<command-name>",
    "<command-message>", "<command-args>", "<local-command-stdout>", "<local-command-stderr>",
    "<task-notification>", "<system-reminder>",
)


def strip_verbatim(text: str, closed_only: bool = False) -> str:
    # why: 백틱 넷 블록 안의 ``` 를 먼저 지우면 바깥 블록이 깨진다. 긴 울타리부터 지운다
    # 사람 입력은 닫히지 않은 울타리가 입력 끝까지 한국어를 지우지 않게 닫힌 블록만 지운다 (#1076)
    if TABLE_SEPARATOR.search(text):
        text = PIPE_LINE.sub(" ", text)
    patterns = (CLOSED_ALT_FENCE, FENCE) if closed_only else (ALT_FENCE, FENCE, OPEN_FENCE)
    for pattern in patterns + (INDENTED_CODE, INLINE, LINK, URL, PATH, QUOTE, TABLE_ROW, TABLE_PIPES,
                               DIAGRAM_ROW, ASCII_ARROW_ROW, ASCII_BOX_ROW, JSON_ROW):
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
    body = strip_verbatim(text)
    # why: 하이픈 · 밑줄 식별자와 `-a` 옵션의 조각(be · to · a · it)은 기능어가 아니다. 낱말 연속도 끊는다
    body = HYPHEN_ID.sub(" ¦ ", OPTION.sub(" ¦ ", body))
    for run in WORD_RUN.findall(body):
        words = {w.lower() for w in re.findall(r"[A-Za-z']+", run)}
        if words & FUNCTION_WORDS:
            return True
    if HANGUL.search(body):
        return False
    # why: 한글 없는 문단은 낱말이 끊겨도(숫자 · 괄호) 영어 문장이다. 「Next, #811 (...)」
    words = re.findall(r"[A-Za-z']+", body)
    if len(words) >= 3 and any(w.lower() in FUNCTION_WORDS for w in words):
        return True
    lower = [w for w in words if len(w) >= 2 and w.islower()]
    return len(words) >= 4 and len(lower) >= 3 and bool(SENTENCE.fullmatch(" ".join(body.split())))


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


CHUNK = 1 << 18


def reversed_lines(path: str):
    with open(path, "rb") as f:
        f.seek(0, 2)
        pos, rest = f.tell(), b""
        while pos > 0:
            step = min(CHUNK, pos)
            pos -= step
            f.seek(pos)
            lines = (f.read(step) + rest).split(b"\n")
            rest = lines.pop(0)
            yield from reversed(lines)
        if rest:
            yield rest


def is_tool_result(entry: dict) -> bool:
    content = entry.get("message", {}).get("content")
    return entry.get("type") == "user" and isinstance(content, list) and any(
        isinstance(c, dict) and c.get("type") == "tool_result" for c in content)


def has_tool_use(entry: dict) -> bool:
    content = entry.get("message", {}).get("content")
    return entry.get("type") == "assistant" and isinstance(content, list) and any(
        isinstance(c, dict) and c.get("type") == "tool_use" for c in content)


def is_mid_turn(previous: dict | None) -> bool:
    """입력 직전 항목이 도구 호출이나 도구 결과면 그 입력은 턴 중간에 끼어든 것이다."""
    # why: 도구가 도는 동안 들어온 알림 · 사람 입력이 턴 경계가 되면 그 앞의 글이 판정에서 빠진다 (#1076).
    # 어시스턴트가 글로 끝낸 뒤의 입력(end_turn)은 새 턴이다
    return previous is not None and (is_tool_result(previous) or has_tool_use(previous))


def read_entries(path: str) -> list[dict]:
    """세션 기록을 끝에서부터 읽어 대화 언어를 정하는 사람 입력까지를 시간 순으로 돌려준다."""
    # why: PostToolUse 는 도구 호출마다 돈다. 긴 세션의 기록 전체를 매번 읽지 않는다
    entries = []
    boundary = False
    for raw in reversed_lines(path):
        raw = raw.strip()
        if not raw:
            continue
        try:
            entry = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(entry, dict):
            continue
        if boundary and entry.get("type") in ("user", "assistant"):
            # 앞서 읽은 입력의 직전 항목. 턴 중간 입력이면 그 앞까지 더 읽는다
            if not is_mid_turn(entry):
                break
            boundary = False
        entries.append(entry)
        if input_language(entry) is not None:
            boundary = True
    entries.reverse()
    return entries


def is_human(entry: dict, text: str) -> bool:
    """사람이 친 말인가. 시스템이 남긴 입력 형태와 자동 입력은 아니다."""
    origin = entry.get("origin")
    # why: CLI 는 사람 입력에도 origin.kind=human 을 붙인다. SDK 화면은 origin 을 붙이지 않는다
    if origin and (not isinstance(origin, dict) or origin.get("kind") != "human"):
        return False
    if entry.get("isCompactSummary"):
        return False
    # why: 시스템 알림 블록이 앞에 붙은 사람 입력은 알림 뒤의 말이 사람 말이다
    head = SYSTEM_REMINDER.sub("", text).lstrip()
    if head.startswith(("<command-message>", "<command-name>")):
        # why: 인자를 붙인 슬래시 명령은 인자가 사람이 쓴 말이다
        return bool(COMMAND_ARGS.search(text))
    return not head.startswith("!") and not SLASH_COMMAND.match(head) and not head.startswith(SYSTEM_PREFIXES)


def spoken_text(text: str) -> str:
    """사람 입력에서 사람이 쓴 말만. 이미지 표식 · 붙여넣은 원문 · 명령 틀은 뺀다."""
    args = COMMAND_ARGS.findall(text)
    if args and text.lstrip().startswith(("<command-message>", "<command-name>")):
        text = " ".join(args)
    text = SYSTEM_REMINDER.sub(" ", text)
    return strip_verbatim(PASTED.sub(" ", IMAGE_MARK.sub(" ", text)), closed_only=True)


def input_language(entry: dict) -> bool | None:
    """사람 입력이면 한국어인가. 대화 언어를 정하지 못하는 항목이면 None."""
    text = user_text(entry)
    # why: 백그라운드 작업 알림 같은 자동 입력은 사람이 쓴 말이 아니다. 영어라 이것으로 재면
    # 영어 응답이 가장 잦은 자리(알림 직후)에서 검사가 꺼진다
    if text is None or not is_human(entry, text):
        return None
    body = spoken_text(text)
    hangul, latin = len(HANGUL.findall(body)), len(LATIN.findall(body))
    if hangul == 0 and latin < MIN_INPUT_LETTERS:
        return None
    return hangul / (hangul + latin) >= KOREAN_INPUT_RATIO


def conversation_is_korean(entries: list[dict]) -> bool:
    for entry in reversed(entries):
        korean = input_language(entry)
        if korean is not None:
            return korean
    return False


def split_paragraphs(text: str) -> list[str]:
    # why: 글 블록 하나에 한국어 문단과 영어 문단이 섞이면 합쳐 재서 영어 문단이 통과한다.
    # 코드 블록 안의 빈 줄로 나누지 않도록 코드 블록을 먼저 지운다
    return [p for p in re.split(r"\n[ \t]*\n", FENCE.sub(" ", ALT_FENCE.sub(" ", text))) if p.strip()]


def turn_items(entries: list[dict]) -> list[tuple[str, str]]:
    """이번 턴(마지막 입력 뒤)을 순서대로: ("text", 글) · ("tool", 호출 id) · ("result", "")."""
    last_user, previous = -1, None
    for i, entry in enumerate(entries):
        if user_text(entry) is not None and not is_mid_turn(previous):
            last_user = i
        if entry.get("type") in ("user", "assistant"):
            previous = entry
    items = []
    for entry in entries[last_user + 1:]:
        if entry.get("type") == "user":
            # 턴 중간에 끼어든 입력은 글을 가르지 않는다
            if user_text(entry) is None:
                items.append(("result", ""))
            continue
        if entry.get("type") != "assistant":
            continue
        for block in entry.get("message", {}).get("content", []) or []:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text":
                items.append(("text", block.get("text", "")))
            elif block.get("type") == "tool_use":
                items.append(("tool", block.get("id") or ""))
    return items


def steps(items: list[tuple[str, str]]) -> list[list[tuple[str, str]]]:
    """도구 결과로 나눈 단계. 한 단계 = 글과 그 글 뒤에 이어진 도구 호출들."""
    out = [[]]
    for item in items:
        if item[0] == "result":
            if out[-1]:
                out.append([])
        else:
            out[-1].append(item)
    return [s for s in out if s]


def paragraphs_of(items: list[tuple[str, str]]) -> list[str]:
    return [p for kind, text in items if kind == "text" for p in split_paragraphs(text)]


def english(paragraphs: list[str]) -> list[tuple[float, str]]:
    off = []
    for text in paragraphs:
        if is_json(text):
            continue
        ratio = hangul_ratio(text)
        if ratio is not None and ratio < THRESHOLD and has_english_sentence(text):
            off.append((ratio, text.strip().splitlines()[0][:60]))
    return off


def is_progress(step: list[tuple[str, str]]) -> bool:
    """도구 호출 앞의 한 문단 글. 진행 문장 · 스킬 호출 문구다."""
    return any(kind == "tool" for kind, _ in step) and len(paragraphs_of(step)) == 1


def post_tool_verdict(entries: list[dict], tool_use_id: str | None) -> dict | None:
    if not conversation_is_korean(entries):
        return None
    all_steps = [s for s in steps(turn_items(entries)) if any(kind == "tool" for kind, _ in s)]
    if not all_steps:
        return None
    index = next((i for i, s in enumerate(all_steps) if ("tool", tool_use_id) in s), len(all_steps) - 1)
    step = all_steps[index]
    first_tool = next(v for kind, v in step if kind == "tool")
    # why: 병렬 호출은 호출마다 훅이 돈다. 같은 글을 여러 번 알리지 않는다
    if tool_use_id and first_tool != tool_use_id:
        return None
    off = english(paragraphs_of(step))
    if not off:
        return None
    if is_progress(step):
        # why: 진행 문장은 막지 않는다 (#1080). 넘어가기 시작했다는 신호라 턴에 한 번만 알린다
        if any(is_progress(s) and english(paragraphs_of(s)) for s in all_steps[:index]):
            return None
        context = (
            f"[응답 언어] 대화 언어는 한국어인데 방금 진행 문장이 한국어가 아니었다: {off[0][1]}\n"
            "→ 지나간 문장은 다시 쓰지 않는다. 다음 글부터 한국어로 쓴다."
        )
    else:
        lines = "\n".join(f"  - 한글 비율 {r:.2f}: {head}" for r, head in off)
        context = (
            "[응답 언어] 대화 언어는 한국어인데 방금 낸 글에 한국어가 아닌 문단이 있다.\n"
            f"{lines}\n"
            "→ 다음 글 첫머리에서 그 내용을 한국어로 한 번 다시 내고 이어 간다. 이후 글은 한국어로 쓴다. "
            "원문(코드 · 명령 · 식별자 · 오류 문구)을 옮길 때는 백틱이나 `>` 인용으로 감싼다. "
            "감싼 원문은 언어를 세지 않는다."
        )
    return {"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": context}}


def stop_verdict(entries: list[dict], last_message: str | None) -> dict | None:
    if not conversation_is_korean(entries):
        return None
    if isinstance(last_message, str):
        # why: Stop 시점에는 마지막 글이 세션 기록에 아직 없다. 입력의 last_assistant_message 로 잰다
        # (2026-11-18 헤드리스 세션 실측). 기록으로 재면 지나간 진행 문장만 걸린다
        off = english(split_paragraphs(last_message))
    else:
        items = turn_items(entries)
        last_tool = max((i for i, (kind, _) in enumerate(items) if kind == "tool"), default=-1)
        off = english(paragraphs_of(items[last_tool + 1:]))
    if not off:
        return None
    # why: 끝난 턴의 글은 고칠 수 없다. 막으면 지나간 문단의 번역이 응답 끝에 덧붙을 뿐이다 (#1080)
    return {"systemMessage": (
        f"[응답 언어] 이번 응답에 한국어가 아닌 문단이 {len(off)}개 있었습니다. 끝난 응답은 고치지 않습니다. "
        "계속 영어로 넘어가면 지금 작업을 마친 뒤 새 세션에서 이어 가세요."
    )}


def main() -> int:
    # why: 훅이 죽으면 검사만 빠지는 게 아니라 오류가 화면에 남는다. 예상 밖 입력은 통과로 둔다
    try:
        data = json.load(sys.stdin)
        if not isinstance(data, dict):
            return 0
        event = data.get("hook_event_name")
        if event not in ("PostToolUse", "Stop") or data.get("stop_hook_active"):
            return 0
        entries = read_entries(data.get("transcript_path") or "")
        if event == "PostToolUse":
            result = post_tool_verdict(entries, data.get("tool_use_id"))
        else:
            result = stop_verdict(entries, data.get("last_assistant_message"))
    except (OSError, ValueError, TypeError, AttributeError, StopIteration):
        return 0
    if result:
        print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
