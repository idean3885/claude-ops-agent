#!/usr/bin/env python3
"""위임 정확도 기록 (#1000).

위임받은 작업 하나가 끝날 때 목표 대비 결과를 한 줄로 쌓고, 쌓인 줄로 통계를 낸다.
답 하나의 정답률(lessons-judge.py)보다 한 단계 위 단위다. 위임 하나는 사용자가 목표를 주고
결과를 받기까지 맡긴 작업이다 (예: 「체크리스트 테스트 전권 위임」).

사용법:
  delegation-log.py add --goal <목표 한 줄> --items <목표 항목 수> --done <교정 없이 끝난 수>
                        [--reverted <사용자 지적으로 되돌린 판정 수>] [--missed <빠뜨린 항목 수>]
                        [--session <세션 식별자>] [--note <한 줄>]
  delegation-log.py report [--days <N>]

  정확도 = done / items. 되돌린 판정 · 빠뜨린 항목은 원인을 보려고 따로 센다.
  기록 위치: ~/.claude/ops-agent/metrics/delegation.jsonl (DELEGATION_LOG 로 바꿀 수 있다)

출력: JSON. add {status, row}, report {status, count, accuracy, reverted, missed, recent[]}
종료 코드: 0 성공, 1 값 오류(done > items, 음수, 빈 목표)
"""

import argparse
import datetime
import json
import os
import sys


def log_path():
    return os.environ.get("DELEGATION_LOG") or os.path.expanduser("~/.claude/ops-agent/metrics/delegation.jsonl")


def read_rows():
    try:
        with open(log_path()) as f:
            return [json.loads(l) for l in f if l.strip()]
    except FileNotFoundError:
        return []


def cmd_add(a):
    if not a.goal.strip() or a.items <= 0 or a.done < 0 or a.done > a.items or a.reverted < 0 or a.missed < 0:
        print(json.dumps({"status": "error", "message": "목표는 비어 있지 않고, 0 <= done <= items, items > 0, 나머지는 0 이상이어야 한다"}, ensure_ascii=False))
        return 1
    row = {"ts": datetime.datetime.now().astimezone().isoformat(timespec="seconds"), "goal": a.goal.strip(),
           "items": a.items, "done": a.done, "reverted": a.reverted, "missed": a.missed}
    if a.session:
        row["session"] = a.session
    if a.note:
        row["note"] = a.note
    parent = os.path.dirname(log_path())
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(log_path(), "a") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(json.dumps({"status": "ok", "row": row}, ensure_ascii=False))
    return 0


def cmd_report(a):
    rows = read_rows()
    if a.days:
        cut = datetime.datetime.now().astimezone() - datetime.timedelta(days=a.days)
        rows = [r for r in rows if datetime.datetime.fromisoformat(r["ts"]) >= cut]
    items = sum(r["items"] for r in rows)
    done = sum(r["done"] for r in rows)
    out = {"status": "ok", "count": len(rows),
           "accuracy": round(done / items, 3) if items else None,
           "reverted": sum(r.get("reverted", 0) for r in rows),
           "missed": sum(r.get("missed", 0) for r in rows),
           "recent": [{"goal": r["goal"], "accuracy": round(r["done"] / r["items"], 3)} for r in rows[-5:]]}
    print(json.dumps(out, ensure_ascii=False))
    return 0


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("add")
    p.add_argument("--goal", required=True)
    p.add_argument("--items", type=int, required=True)
    p.add_argument("--done", type=int, required=True)
    p.add_argument("--reverted", type=int, default=0)
    p.add_argument("--missed", type=int, default=0)
    p.add_argument("--session")
    p.add_argument("--note")
    r = sub.add_parser("report")
    r.add_argument("--days", type=int, default=0)
    a = ap.parse_args()
    return cmd_add(a) if a.cmd == "add" else cmd_report(a)


if __name__ == "__main__":
    sys.exit(main())
