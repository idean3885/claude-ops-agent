#!/usr/bin/env python3
"""구조 가독성 카운터 — `base/readability.md` 의 자동 판별 `가능` 항목만 집계한다.

판정하지 않고 수치와 위치만 낸다. 상한값의 정본은 `base/readability.md` 이고
이 스크립트는 그 값을 상수로 복제한다. 규칙을 고치면 양쪽을 함께 고친다.

커버 (자동 판별 `가능`):
  P2 문단 2-4문장 · P4 산문 사이 단문 문단 · P7 산문 5문단 연속
  V2 시각 요소 없이 15-20문장 · L1 목록 3-7항목 · L4 테이블 열 5 이하
  H1 단일 H1 · H2 레벨 건너뛰기 · C1 코드 언어 명시
  PN7 서술 문장 종결 부호 · PN8 물결표 취소선 (정본은 `base/punctuation.md`)

미커버 (`부분`·`불가`): P1 P3 P5 P8 P10 P11 H4 L2 L3 C2 V1 V3 V4 CJ3
  기계가 의도를 읽어야 하는 항목이다. 구현하면 과검출로 신뢰가 떨어진다.

사용:
  python3 readability_count.py README.md docs/*.md
종료 코드: 검출 0 이면 0, 있으면 1.
"""
import re
import sys
import unicodedata
import pathlib

# 상한값 정본: base/readability.md
MAX_SENT_PER_PARA = 4      # P2
MAX_PROSE_RUN = 5          # P7
MAX_SENT_NO_VISUAL = 20    # V2
MAX_LIST_ITEMS = 7         # L1
MAX_TABLE_COLS = 5         # L4

# 한국어 합쇼체·해요체 종결과 ASCII 문장부호를 문장 경계로 본다.
SENT = re.compile(r"(?:다|요)\.(?=\s|$)|[.!?](?=\s|$)")
LIST_ITEM = re.compile(r"^(?:[-*]\s|\d+\.\s)")
# PN7: 인라인 코드 · 「」 인용 · 링크 주소를 지운 뒤 서술어로 끝나는 조각을 본다.
UNQUOTE = re.compile(r"`[^`]*`|「[^」]*」|\]\([^)]*\)")
PREDICATE_END = re.compile(r"[가-힣](?:(?<!과)다|니까)\**(?:\s*\([^()]*\))?$")
BR = re.compile(r"<br\s*/?>")
# PN8: GFM 은 한 인라인 범위(문단 · 제목 · 표 셀 · 목록 항목 문단) 안의 물결표 한 쌍을 취소선으로 렌더한다.
# 블록 분류는 위 blocks() 와 따로 한다. 인라인 범위가 GitHub 파서와 같아야 과검출 · 놓침이 없다.
CODE_SPAN = re.compile(r"`[^`]*`")
TILDE = re.compile(r"(?<!~)~(?!~)")
FENCE = re.compile(r"^\s*(`{3,}|~{3,})")
# CommonMark HTML 블록: 주석 · 블록 태그(6형)로 시작하는 줄, 또는 태그 하나만 있는 줄(7형). 인라인 태그로 시작하는 문단은 아니다.
BLOCK_TAGS = (
    "address|article|aside|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|"
    "figcaption|figure|footer|form|h[1-6]|head|header|hr|html|iframe|legend|li|main|menu|nav|ol|p|pre|script|"
    "section|style|summary|table|tbody|td|textarea|tfoot|th|thead|title|tr|ul"
)
HTML_BLOCK = re.compile(rf"^\s*(?:<!--|</?(?:{BLOCK_TAGS})(?:\s|/?>|$)|</?[A-Za-z][\w-]*(?:\s[^>]*)?/?>\s*$)", re.I)
LIST_MARK = re.compile(r"^(\s*)(?:[-*+]|\d+[.)])\s+")
TABLE_SEP = re.compile(r"^\s*\|[\s:|-]+\|?\s*$")
URL = re.compile(r"<https?://[^>]*>|https?://[^\s)>]+|<!--.*?-->")
# 링크 · 강조는 물결표보다 먼저 묶여 안팎의 물결표가 짝을 이루지 못한다. 안쪽은 따로 본다.
NESTED = re.compile(r"!?\[([^\]]*)\]\([^)]*\)|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*")
ASCII_PUNCT = set("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~")


def _punct(ch):
    # GitHub(cmark-gfm) 은 ASCII 구두점과 유니코드 P 범주만 구두점으로 본다. 그 밖의 기호(→ ×)는 글자로 본다.
    return ch in ASCII_PUNCT or unicodedata.category(ch).startswith("P")


def _inline_units(text):
    """인라인 범위 하나를 링크 · 강조 안쪽과 바깥으로 나눈다."""
    text = URL.sub(" ", CODE_SPAN.sub("X", text))
    inner = []

    def keep(m):
        inner.append(next(g for g in m.groups() if g is not None))
        return "X"

    return [NESTED.sub(keep, text)] + inner


def strikes(text):
    """인라인 범위 하나에 취소선으로 렌더될 물결표 쌍이 있는가.

    여닫는 조건은 CommonMark 의 left · right-flanking 이다. 문자열 끝은 공백으로 본다.
    역슬래시가 홀수 개 앞서면 이스케이프다.
    """
    for s in _inline_units(text):
        opens, closes = [], []
        for m in TILDE.finditer(s):
            i = m.start()
            if (i - len(s[:i].rstrip("\\"))) % 2:
                continue
            prev = s[i - 1] if i > 0 else " "
            nxt = s[i + 1] if i + 1 < len(s) else " "
            if not nxt.isspace() and (not _punct(nxt) or prev.isspace() or _punct(prev)):
                opens.append(i)
            if not prev.isspace() and (not _punct(prev) or nxt.isspace() or _punct(nxt)):
                closes.append(i)
        if any(c > o for o in opens for c in closes):
            return True
    return False


def _starts_block(ln):
    return bool(LIST_MARK.match(ln) or FENCE.match(ln) or re.match(r"^\s*[#>|]", ln))


def _units(lines, base):
    """(시작 줄 번호, 인라인 범위, 줄 수) 목록. 인용 · 목록 항목은 안쪽을 다시 나눈다."""
    out, i, n = [], 0, len(lines)
    while i < n:
        ln, s = lines[i], lines[i].strip()
        if not s:
            i += 1
            continue
        m = FENCE.match(ln)
        if m:
            mark, i = m.group(1), i + 1
            while i < n and not lines[i].strip().startswith(mark):
                i += 1
            i += 1
            continue
        if HTML_BLOCK.match(ln) or ln.startswith("    "):
            # HTML 블록 · 들여쓴 코드 블록은 빈 줄까지 인라인으로 렌더되지 않는다
            while i < n and lines[i].strip():
                i += 1
            continue
        if s.startswith(">"):
            j = i
            while j < n and lines[j].strip().startswith(">"):
                j += 1
            out += _units([re.sub(r"^\s*>\s?", "", x) for x in lines[i:j]], base + i)
            i = j
            continue
        if s.startswith("#"):
            out.append((base + i, s.lstrip("#"), 1))
            i += 1
            continue
        if s.startswith("|"):
            while i < n and lines[i].strip().startswith("|"):
                if not TABLE_SEP.match(lines[i]):
                    out += [(base + i, c, 1) for c in lines[i].strip().strip("|").split("|")]
                i += 1
            continue
        m = LIST_MARK.match(ln)
        if m:
            # 항목의 이어지는 줄(들여쓴 줄 · lazy 줄)은 같은 문단이다. 빈 줄 뒤 들여쓴 줄은 항목 안의 블록이다.
            width = len(m.group(0))
            j, body = i + 1, [ln[width:]]
            while j < n and lines[j].strip() and not _starts_block(lines[j]):
                body.append(lines[j])
                j += 1
            out.append((base + i, " ".join(x.strip() for x in body), j - i))
            k = j
            while k < n and (not lines[k].strip() or lines[k].startswith(" " * width)):
                k += 1
            while k > j and not lines[k - 1].strip():
                k -= 1
            if k > j:
                out += _units([x[width:] for x in lines[j:k]], base + j)
            i = max(j, k)
            continue
        j = i + 1
        while j < n and lines[j].strip() and not _starts_block(lines[j]):
            j += 1
        out.append((base + i, " ".join(x.strip() for x in lines[i:j]), j - i))
        i = j
    return out


def pn8(text):
    """취소선으로 렌더될 물결표 쌍이 있는 인라인 범위에서, 물결표가 있는 줄마다 (줄, 규칙, 안내).

    why: 범위의 첫 줄만 내면, 기존 줄의 홑 물결표에 PR 이 덧붙인 줄이 짝을 이룰 때 최종 점검이
    그 검출을 「기존 줄」로 분류해 통과시킨다.
    """
    lines = text.split("\n")
    hits = set()
    for start, unit, n in _units(lines, 0):
        if strikes(unit):
            hits.update(k for k in range(start, start + n) if TILDE.search(CODE_SPAN.sub("", lines[k])))
    return [(k + 1, "PN8", "물결표 한 쌍이 취소선으로 렌더된다. 역슬래시로 이스케이프한다") for k in sorted(hits)]


def unterminated(text, cell=False):
    """`<br>` 로 나눈 조각 중 서술어로 끝나는데 종결 부호가 없는 개수."""
    parts = BR.split(UNQUOTE.sub("", text))
    # why: 표의 공백 없는 한 낱말 셀(「검증한다」 같은 판정 · 이름)은 문장이 아니다
    return sum(1 for p in map(str.strip, parts) if (" " in p or not cell) and PREDICATE_END.search(p))


def blocks(text):
    """마크다운을 (종류, 시작줄, 줄들, 코드언어) 블록 목록으로 나눈다."""
    out, buf, kind, start, incode, lang = [], [], None, 0, False, ""
    for i, ln in enumerate(text.split("\n"), 1):
        if ln.startswith("```"):
            if incode:
                out.append(("code", start, buf, lang))
                buf, kind, incode = [], None, False
            else:
                if buf:
                    out.append((kind, start, buf, ""))
                lang = ln[3:].strip()
                buf, kind, start, incode = [], "code", i, True
            continue
        if incode:
            buf.append(ln)
            continue
        s = ln.strip()
        if not s:
            if buf:
                out.append((kind, start, buf, ""))
            buf, kind = [], None
            continue
        if s.startswith("#"):
            k = "heading"
        elif s.startswith("|"):
            k = "table"
        elif LIST_ITEM.match(s):
            k = "list"
        elif s.startswith(">"):
            k = "quote"
        else:
            k = "prose"
        if kind and k != kind:
            out.append((kind, start, buf, ""))
            buf, start = [], i
        if not buf:
            start = i
        kind = k
        buf.append(ln)  # 원문 유지 — 들여쓰기로 중첩 목록을 나눈다
    if buf:
        out.append((kind, start, buf, ""))
    return out


def check(path):
    text = pathlib.Path(path).read_text()
    bs = blocks(text)
    hits, prose_run, since_visual, h1, prev_level = pn8(text), 0, 0, 0, 0

    for idx, (kind, line, body, lang) in enumerate(bs):
        if kind == "heading":
            level = len(re.match(r"^#+", body[0].strip()).group(0))
            if level == 1:
                h1 += 1
            if prev_level and level > prev_level + 1:
                hits.append((line, "H2", f"헤딩 레벨 {prev_level}→{level} 건너뜀"))
            prev_level, prose_run, since_visual = level, 0, 0
            continue

        if kind in ("prose", "list"):
            for off, b in enumerate(body):
                if unterminated(b):
                    hint = "개조식으로 닫거나(L7) 문장 단락으로 옮긴다" if LIST_ITEM.match(b.strip()) else "종결 부호를 붙인다"
                    hits.append((line + off, "PN7", f"서술어로 끝나는데 종결 부호 없음. {hint}"))

        if kind == "prose":
            n = len(SENT.findall(" ".join(b.strip() for b in body)))
            prose_run += 1
            since_visual += n
            if n > MAX_SENT_PER_PARA:
                hits.append((line, "P2", f"문단 {n}문장 (상한 {MAX_SENT_PER_PARA})"))
            # P4: 단문 문단은 강조·전환·결론에만. 앞뒤가 모두 산문이면 그 자리가 아니다.
            # 섹션 첫·끝 문단은 그 자리일 수 있어 제외한다. 좁히지 않으면 정상 문단을 대량 검출한다.
            prev_prose = idx > 0 and bs[idx - 1][0] == "prose"
            next_prose = idx + 1 < len(bs) and bs[idx + 1][0] == "prose"
            if n <= 2 and prev_prose and next_prose:
                hits.append((line, "P4", f"산문 사이에 낀 단문 문단 ({n}문장)"))
            if prose_run >= MAX_PROSE_RUN:
                hits.append((line, "P7", f"소제목 없이 산문 {prose_run}문단 연속"))
            if since_visual > MAX_SENT_NO_VISUAL:
                hits.append((line, "V2", f"시각 요소 없이 약 {since_visual}문장 경과"))
            continue

        prose_run, since_visual = 0, 0

        if kind == "list":
            # 최상위 항목만 집계한다. 중첩 항목은 부모에 속하므로 L1 대상이 아니다.
            items = [b for b in body if LIST_ITEM.match(b)]
            if len(items) > MAX_LIST_ITEMS:
                hits.append((line, "L1", f"목록 {len(items)}항목 (상한 {MAX_LIST_ITEMS})"))
        elif kind == "table":
            cols = len(body[0].strip().strip("|").split("|"))
            sep = re.compile(r"^\s*\|[\s:|-]+\|?\s*$")
            for off, row in enumerate(body):
                # why: 문단에 끊겨 이어진 표는 머리행 없이 시작하므로 앞 두 줄을 건너뛰면 본문 행을 놓친다
                if sep.match(row) or (off == 0 and len(body) > 1 and sep.match(body[1])):
                    continue
                n = sum(unterminated(c, cell=True) for c in UNQUOTE.sub("", row).strip().strip("|").split("|"))
                if n:
                    hits.append((line + off, "PN7", f"표 셀 {n}곳이 서술어로 끝나는데 종결 부호 없음"))
            if cols > MAX_TABLE_COLS:
                hits.append((line, "L4", f"테이블 열 {cols}개 (상한 {MAX_TABLE_COLS})"))
        elif kind == "code" and not lang:
            hits.append((line, "C1", "코드 블록에 언어 미명시"))

    if h1 > 1:
        hits.append((1, "H1", f"H1 {h1}개 (하나만)"))
    return hits


def main(argv):
    if not argv:
        print(__doc__)
        return 0
    total = 0
    for p in argv:
        try:
            hits = check(p)
        except OSError as e:
            print(f"{p}: 읽기 실패 ({e})", file=sys.stderr)
            continue
        total += len(hits)
        for line, rule, msg in sorted(hits):
            print(f"{p}:{line} [{rule}] {msg}")
    return 1 if total else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
