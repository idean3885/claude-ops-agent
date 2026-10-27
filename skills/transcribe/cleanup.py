"""교정: 원문 + 대응표 → 정리본 md

사용:
  python3 cleanup.py preview <원문> <대응표>...         치환 예정 건수 · 화자별 대표 발화
  python3 cleanup.py apply <원문> <정리본.md> <대응표>...  정리본을 한 번 쓴다

대응표는 한 줄에 `틀린 말<TAB>바른 말`, `#` 은 주석이다. 원문은 읽기만 한다.
정리본이 이미 있으면 쓰지 않는다. 교정은 수집할 때 한 번에 끝낸다 (#807).
"""
import os
import re
import sys

HANGUL_OR_WORD = r"[0-9A-Za-z가-힣]"


def load(paths):
    table = {}
    for p in paths:
        for n, line in enumerate(open(p, encoding="utf-8"), 1):
            line = line.rstrip("\n")
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            parts = line.split("\t")
            assert len(parts) == 2 and parts[0], f"{p}:{n} 형식은 `틀린 말<TAB>바른 말` 이다"
            table[parts[0]] = parts[1]
    return table


def pattern(table):
    # 긴 말부터 맞춘다. 앞쪽만 경계를 본다: 조사(「리터링이」)는 뒤에 붙는다
    keys = sorted(table, key=len, reverse=True)
    return re.compile(rf"(?<!{HANGUL_OR_WORD})(?:{'|'.join(map(re.escape, keys))})")


def correct(text, table):
    if not table:
        return text, {}
    counts = {}

    def sub(m):
        counts[m[0]] = counts.get(m[0], 0) + 1
        return table[m[0]]

    return pattern(table).sub(sub, text), counts


def samples(text, k=3):
    # 화자별로 긴 발화 k 개. 번호 → 이름 대응을 사람이 확인하는 재료다
    by, cur = {}, None
    for line in text.splitlines():
        m = re.match(r"\[[\d:]+\] (화자\d+):", line)
        if m:
            cur = m[1]
        elif cur and line.strip():
            by.setdefault(cur, []).append(line.strip())
    return {s: sorted(v, key=len, reverse=True)[:k] for s, v in sorted(by.items())}


def report(counts, table):
    for k, v in sorted(counts.items(), key=lambda x: -x[1]):
        print(f"{k} → {table[k]} {v}건")


if __name__ == "__main__":
    cmd, src = sys.argv[1], sys.argv[2]
    raw = open(src, encoding="utf-8").read()
    if cmd == "preview":
        table = load(sys.argv[3:])
        _, counts = correct(raw, table)
        report(counts, table)
        for spk, lines in samples(raw).items():
            print(f"\n{spk}")
            for line in lines:
                print(f"  {line}")
    elif cmd == "apply":
        out, table = sys.argv[3], load(sys.argv[4:])
        if os.path.exists(out):
            sys.exit(f"{out} 이 이미 있다. 정리본은 한 번만 쓴다")
        text, counts = correct(raw, table)
        open(out, "w", encoding="utf-8").write(f"# {os.path.basename(src)} 정리본\n\n{text}")
        report(counts, table)
    else:
        sys.exit(__doc__)
