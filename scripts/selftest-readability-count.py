#!/usr/bin/env python3
"""readability_count.py PN8(물결표 취소선) 자체 점검.

소스에서는 보이지 않고 렌더해야 드러나는 결함이라, 검출이 무너지면 신호가 없다.
예문의 기댓값은 GitHub 마크다운 API(gfm 모드)가 <del> 을 내는지로 정했다 (#823).

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
    for f in fails:
        print(f)
    print(f"PN8 {len(STRIKE) + len(PLAIN) + len(DOCS) + 1}건 중 실패 {len(fails)}건")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
