#!/usr/bin/env python3
"""readability_count.py PN8(물결표 취소선) · PN9(의도한 취소선) · L9(불릿 안 머리말) 자체 점검.

PN8 은 소스에서는 보이지 않고 렌더해야 드러나는 결함이라, 검출이 무너지면 신호가 없다.
예문의 기댓값은 GitHub 마크다운 API(gfm 모드)가 <del> 을 내는지로 정했다 (#823).
L9 는 트래커 본문을 보내기 전 글 판정이 차단에 쓴다. 검출이 무너지면 머리말 불릿이 신호 없이 전송되고,
예외가 무너지면 형식이 정한 정의 목록까지 막는다 (#1111 · #1112).
PN9 는 정정을 겹 물결표 취소선으로 남긴 본문을 잡는다. 홑 물결표만 세던 PN8 이 놓쳐 판정을 통과했다 (#1190).

    python3 scripts/selftest-readability-count.py
"""

from __future__ import annotations

import os
import sys
import tempfile

sys.path.insert(
    0,
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "config", "style-rules", "metrics"),
)

import readability_count as rc  # noqa: E402

# GitHub 이 취소선으로 렌더한 예문
STRIKE = [
    "51~55, 5.6~6.0ms",            # 이슈 원 사례
    "(PU1~PU5) 와 (T1~T24)",
    "x~y z~w",
    "1~2·3~4",
    "「1~2」와 「3~4」",
    "9991~9993 과 10~20%",
]

# GitHub 이 취소선으로 렌더하지 않은 예문
PLAIN = [
    "51\\~55, 5.6\\~6.0ms",        # 이스케이프
    "4\\~11% 와 5~6",              # 한쪽만 이스케이프
    "1 ~ 2 ~ 3",                   # 양쪽 공백
    "글로벌 ~/.claude 와 가 ~/.cache",
    "(~/.a ~/.b)",
    "`~/.a` 와 `~/.b`",            # 인라인 코드
    "A~J · 심화 ~되어지다",
    "~되어지다·~에 의해",           # 문장 부호 뒤 · 글자 앞은 닫지 못한다
    "(~하고, ~되고)",
    "~하고 ~지 않고",
    "a~(b)~c",
    "범위 1~2.",
]


# 파일 단위: 블록 분류(제목 · 표 머리행 · 목록 이어짐 · 인용 · 펜스 · HTML · 링크 · 강조)까지 거친 결과. 값은 GitHub 렌더.
DOCS = {
    'heading': ('## 범위 1~2 와 3~4', True),
    'table_header': ('| 범위 1~2 3~4 | x |\n|---|---|\n| a | b |', True),
    'table_body': ('| a | b |\n|---|---|\n| 1~2 3~4 | c |', True),
    'table_cross': ('| a | b |\n|---|---|\n| 1~2 | 3~4 |', False),
    'list_indent': ('- a 1~2\n  b 3~4', True),
    'list_lazy': ('- a 1~2\nb 3~4', True),
    'list_items': ('- a 1~2\n- b 3~4', False),
    'quote_list': ('> - a 1~2\n> - b 3~4', False),
    'quote_blank': ('> 1~2\n>\n> 3~4', False),
    'quote_para': ('> 1~2\n> 3~4', True),
    'fence_tilde': ('~~~\n1~2 3~4\n~~~', False),
    'fence_indented': ('- item\n\n  ```\n  1~2 3~4\n  ```', False),
    'indented_code': ('para\n\n    1~2 3~4', False),
    'details': ('<details>\n<summary>1~2 3~4</summary>\n</details>', False),
    'link_text': ('[1~2](u) 3~4', False),
    'link_url': ('[a](https://x/~u) 1~2', False),
    'autolink': ('https://a.b/~u 1~2', False),
    'bold': ('**1~2** 3~4', False),
    'em': ('*1~2* 3~4', False),
    'comment': ('<!-- 1~2 --> 3~4', False),
    'arrow': ('x~→ y →~z', True),
    'ellipsis': ('x~… y …~z', False),
    'dbl_backslash': ('a\\\\~b c~d', True),
    'escaped': ('a\\~b c~d', False),
    'para_multi': ('1~2\n3~4', True),
    'para_blank': ('1~2\n\n3~4', False),
    'list_nested_para': ('- a\n\n  1~2 3~4', True),
    'heading_then_para': ('# 1~2\n3~4', False),
    'korean_brackets': ('「1~2」와 「3~4」', True),
    'path_pair': ('(~/.a ~/.b)', False),
    'range': ('51~55, 5.6~6.0ms', True),
    'link_https': ('[1~2](https://x) 3~4', False),
    'inline_html_br': ('<br> 1~2 3~4', True),
    'inline_html_img': ('<img src=x> 1~2 3~4', True),
    'inline_html_kbd': ('<kbd>a</kbd> 1~2 3~4', True),
    'inline_html_b': ('<b>1~2</b> 3~4', True),
    'html_block_div': ('<div>\n1~2 3~4\n</div>', False),
    'html_tag_only': ('<span>\n1~2 3~4', False),
}


# PN9: (예문, 검출 줄 수). 겹 물결표 취소선은 잡고, 코드 · 이스케이프 · 홑 물결표 범위 · 링크 주소는 넘긴다.
PN9_DOCS = {
    'correction': ('## Why\n\n* ~~사용률이 전 기간 0 이다~~ (정정: 쓰지 않는 컬럼 값)\n', 1),
    'inline': ('값은 ~~10~~ 12 다\n', 1),
    'multi_line_para': ('앞 ~~틀린\n문장~~ 뒤\n', 2),
    'para_middle_line': ('앞 ~~틀린\n가운데 줄\n문장~~ 뒤\n', 2),
    'table_cell': ('| a | b |\n|---|---|\n| ~~옛 값~~ | 새 값 |\n', 1),
    'inline_code': ('`~~a~~` 는 취소선 문법이다\n', 0),
    'fence': ('```markdown\n~~a~~\n```\n', 0),
    'escaped': ('\\~\\~a\\~\\~ 는 글자다\n', 0),
    'escaped_open': ('\\~~a~~ 는 여는 쪽만 이스케이프\n', 0),
    'single_range': ('범위 51~55 와 60~70\n', 0),
    'link_url': ('[a](https://x/~~b~~) 끝\n', 0),
    'spaced': ('a ~~ b ~~ c\n', 0),
}


# L9: (예문, 검출 줄 수). 위반 예문 · 고친 예문 · 정의 목록 예외.
L9_DOCS = {
    'report_labels': ('## 결과\n\n- 확인: 재현되지 않는다\n- 원인: 캐시 만료가 짧다\n', 2),
    'bold_label': ('## 결과\n\n- **영향**: 없음\n', 1),
    'checkbox_label': ('## 할 일\n\n- [ ] 검출력: 사본에서 실패를 본다\n', 1),
    'nested_label': ('## 결과\n\n- 결론 한 줄\n  - 근거: 실측 값\n', 1),
    'fullwidth_colon': ('## 결과\n\n- 원인： 캐시\n', 1),
    'fixed': ('## 결과\n\n### 확인\n\n- 재현되지 않는다\n\n### 원인\n\n- 캐시 만료가 짧다\n', 0),
    'meta_after_h1': ('# ADR-1: 제목\n\n- 상태: accepted\n- 일시: 2026-11-18\n\n## 배경\n\n본문\n', 0),
    'record_repeated': ('### a\n- 말: 하나\n- 글: 둘\n\n### b\n- 말: 셋\n- 글: 넷\n', 0),
    'format_key': ('## Why\n\n- 기존 기록: 없음 · 찾은 자리\n- 사실\n', 0),
    'not_label': ('## 본문\n\n- 시간은 10:30 이다\n- 주소 https://x.y 를 연다\n- 예시 (예: a) 를 든다\n- `VERSION`: 버전 파일\n- 도입 문장:\n', 0),
    'code_fence': ('## 틀\n\n```markdown\n- 확인: 값\n```\n', 0),
}


def main() -> int:
    fails = [f"놓침: {s}" for s in STRIKE if not rc.strikes(s)]
    fails += [f"과검출: {s}" for s in PLAIN if rc.strikes(s)]
    fails += [f"파일 단위 불일치: {k}" for k, (doc, want) in DOCS.items() if bool(rc.pn8(doc)) != want]
    # 실제 진입점: check() 가 파일을 읽어 PN8 을 내는가. 덧붙인 줄도 검출 줄로 나와야 최종 점검이 추가 줄로 분류한다.
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as f:
        f.write("# 제목\n\n기존 T1~T16 문장\n이어 붙인 줄 A~K\n")
    lines = sorted(ln for ln, rule, _ in rc.check(f.name) if rule == "PN8")
    os.unlink(f.name)
    if lines != [3, 4]:
        fails.append(f"check() 진입점: PN8 줄 {lines} (기대 [3, 4])")
    # L9: check() 진입점으로 파일을 읽어 검출 줄 수를 본다. --only 로 고른 규칙만 내는지도 본다.
    for k, (doc, want) in L9_DOCS.items():
        with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as f:
            f.write(doc)
        got = sum(1 for _, rule, _ in rc.check(f.name) if rule == "L9")
        os.unlink(f.name)
        if got != want:
            fails.append(f"L9 {k}: 검출 {got}줄 (기대 {want})")
    # PN9: check() 진입점과 --only 로 고른 결과가 같아야 보내기 전 글 판정이 차단에 쓸 수 있다.
    for k, (doc, want) in PN9_DOCS.items():
        with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as f:
            f.write(doc)
        got = sum(1 for _, rule, _ in rc.check(f.name) if rule == "PN9")
        os.unlink(f.name)
        if got != want:
            fails.append(f"PN9 {k}: 검출 {got}줄 (기대 {want})")
    for f in fails:
        print(f)
    total = len(STRIKE) + len(PLAIN) + len(DOCS) + 1 + len(L9_DOCS) + len(PN9_DOCS)
    print(f"PN8 · PN9 · L9 {total}건 중 실패 {len(fails)}건")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
