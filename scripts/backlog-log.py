#!/usr/bin/env python3
"""이슈 정리 결과 기록 (#1134).

이슈 정리(backlog-refinement) 한 번이 끝날 때 결과를 한 줄로 쌓고, 쌓인 줄로 통계를 낸다.
사용 횟수는 스킬 사용 지표가 세고, 이 기록은 정리가 잘 됐는지를 본다.

사용법:
  backlog-log.py add --open-before <정리 전 열린 이슈 수> --closed <닫은 수> --bundled <묶음으로 고친 수>
                     --debated <토론에 올린 수> --waiting <대기로 남긴 수> --reversed <사람이 추천을 뒤집은 수>
                     [--reopened <지난 정리에서 닫았다가 다시 열린 수>] [--session <세션 식별자>] [--note <한 줄>]
  backlog-log.py report [--days <N>]

  줄어든 비율 = (closed + bundled) / open_before. 뒤집힘률 = reversed / debated.
  기록 위치: ~/.claude/ops-agent/metrics/backlog-refinement.jsonl (BACKLOG_LOG 로 바꿀 수 있다)

출력: JSON. add {status, row}, report {status, count, reduced, reversed_rate, reopened, recent[]}
종료 코드: 0 성공, 1 값 오류(음수, 처리 수가 정리 전 수보다 큼)
"""

import argparse
import datetime
import json
import os
import sys


def log_path():
    return os.environ.get("BACKLOG_LOG") or os.path.expanduser("~/.claude/ops-agent/metrics/backlog-refinement.jsonl")


def fail(message):
    print(json.dumps({"status": "error", "message": message}, ensure_ascii=False))
    sys.exit(1)


def add(args):
    counts = {k: getattr(args, k) for k in ("open_before", "closed", "bundled", "debated", "waiting", "reversed", "reopened")}
    if any(v < 0 for v in counts.values()):
        fail("음수는 받지 않는다")
    if counts["closed"] + counts["bundled"] > counts["open_before"]:
        fail("닫은 수 + 묶음 수가 정리 전 열린 이슈 수보다 크다")
    if counts["reversed"] > counts["debated"]:
        fail("뒤집힌 수가 토론에 올린 수보다 크다")
    row = {"ts": datetime.datetime.now().astimezone().isoformat(timespec="seconds"), **counts}
    if args.session:
        row["session"] = args.session
    if args.note:
        row["note"] = args.note
    path = log_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(json.dumps({"status": "ok", "row": row}, ensure_ascii=False))


def report(args):
    rows = []
    path = log_path()
    if os.path.exists(path):
        since = None
        if args.days:
            since = datetime.datetime.now().astimezone() - datetime.timedelta(days=args.days)
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    row = json.loads(line)
                    if since and datetime.datetime.fromisoformat(row["ts"]) < since:
                        continue
                    rows.append(row)
                except (ValueError, KeyError):
                    continue
    total = lambda k: sum(r.get(k, 0) for r in rows)
    opened = total("open_before")
    debated = total("debated")
    print(json.dumps({
        "status": "ok",
        "count": len(rows),
        "reduced": round((total("closed") + total("bundled")) / opened, 3) if opened else None,
        "reversed_rate": round(total("reversed") / debated, 3) if debated else None,
        "reopened": total("reopened"),
        "recent": rows[-5:],
    }, ensure_ascii=False))


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add")
    for name in ("open-before", "closed", "bundled", "debated", "waiting", "reversed"):
        a.add_argument(f"--{name}", type=int, required=True)
    a.add_argument("--reopened", type=int, default=0)
    a.add_argument("--session")
    a.add_argument("--note")
    r = sub.add_parser("report")
    r.add_argument("--days", type=int)
    args = p.parse_args()
    add(args) if args.cmd == "add" else report(args)


if __name__ == "__main__":
    main()
