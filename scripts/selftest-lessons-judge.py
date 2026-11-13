#!/usr/bin/env python3
"""lessons-judge.py 자체 점검.

가드 · 대상 선정 · 고지 조건 · 정답률 계산이 무너져도 판정은 작업 시간 밖에서 조용히 돌아 신호가 없다.
임시 HOME 과 가짜 claude 로 그 붕괴를 잡는다. 실제 claude 는 부르지 않는다.

    python3 scripts/selftest-lessons-judge.py [대상 스크립트 경로]
"""

from __future__ import annotations

import datetime
import json
import os
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "lessons-judge.py")
FAKE_VERDICT = {"answers": 2, "corrections": [{"answer": "A2", "cause": "level", "why": "분량", "asset_hint": ""}]}

failures: list[str] = []
passed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global passed
    if ok:
        passed += 1
    else:
        failures.append(f"{name} {detail}")


def seed_state(home: str, since_ago: float) -> None:
    """설치 시점(since)을 과거로 둔다. 없으면 설치 시점 이전 세션은 판정 대상이 아니다."""
    os.makedirs(os.path.dirname(lessons(home, "x")), exist_ok=True)
    with open(lessons(home, "state.json"), "w", encoding="utf-8") as f:
        json.dump({"since": time.time() - since_ago, "judged": {}, "fails": {}, "last_scan": 0, "last_approval": None}, f)


def write_transcript(home: str, project: str, session: str, age_seconds: float) -> str:
    d = os.path.join(home, ".claude", "projects", project)
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, f"{session}.jsonl")
    rows = [
        {"type": "user", "message": {"content": "질문"}},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "답1"}]}},
        {"type": "user", "message": {"content": "너무 길다"}},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "답2"}]}},
    ]
    with open(path, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    t = time.time() - age_seconds
    os.utime(path, (t, t))
    return path


def run(home: str, *args: str, stdin: str = "", env: dict | None = None) -> subprocess.CompletedProcess:
    e = {k: v for k, v in os.environ.items() if not k.startswith("OPS_AGENT_LESSONS")}
    e["HOME"] = home
    e.update(env or {})
    return subprocess.run([sys.executable, TARGET, *args], input=stdin, capture_output=True, text=True, env=e, timeout=60)


def lessons(home: str, name: str) -> str:
    return os.path.join(home, ".claude", "ops-agent", "lessons", name)


def read_state(home: str) -> dict:
    with open(lessons(home, "state.json"), encoding="utf-8") as f:
        return json.load(f)


def write_judgment(home: str, ts: str, answers: int, corrections: int, status: str = "pending",
                   transcript: str = "", hint: str = "") -> None:
    os.makedirs(os.path.dirname(lessons(home, "x")), exist_ok=True)
    transcript = transcript or f"t-{ts}-{answers}-{corrections}"
    row = {"ts": ts, "transcript": transcript, "project": "p", "session": "s", "answers": answers,
           "corrections": [{"answer": f"A{i}", "cause": "content", "why": "", "asset_hint": hint} for i in range(corrections)],
           "status": status}
    with open(lessons(home, "judgments.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps(row) + "\n")


def wait_for(path: str, seconds: float = 15) -> bool:
    end = time.time() + seconds
    while time.time() < end:
        if os.path.exists(path):
            return True
        time.sleep(0.1)
    return False


def iso(days_ago: float) -> str:
    return (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=days_ago)).isoformat(timespec="seconds")


def make_fake_claude(directory: str) -> str:
    path = os.path.join(directory, "fake-claude")
    with open(path, "w") as f:
        f.write("#!/bin/sh\ncat >/dev/null\nprintf '%s' '" + json.dumps({"result": json.dumps(FAKE_VERDICT), "total_cost_usd": 0.01}) + "'\n")
    os.chmod(path, 0o755)
    return path


def test_selection_and_worker() -> None:
    with tempfile.TemporaryDirectory() as home:
        seed_state(home, 86400)
        old = write_transcript(home, "proj", "old", 3 * 3600)
        write_transcript(home, "proj", "fresh", 10)
        fake = make_fake_claude(home)
        started = time.time()
        r = run(home, "spawn", stdin=json.dumps({"session_id": "current"}), env={"OPS_AGENT_LESSONS_CLAUDE": fake})
        check("spawn 종료 코드 0", r.returncode == 0, r.stderr)
        check("spawn 1초 안", time.time() - started < 1.5, f"{time.time() - started:.2f}s")
        check("spawn 고지 없음 (pending 0)", r.stdout.strip() == "", r.stdout)
        done = wait_for(lessons(home, "judgments.jsonl"))
        check("worker 가 판정을 쌓는다", done)
        if done:
            time.sleep(0.5)
            rows = [json.loads(l) for l in open(lessons(home, "judgments.jsonl"), encoding="utf-8")]
            check("오래된 것만 판정", [x["session"] for x in rows] == ["old"], str(rows))
            check("기계 분모 = A 개수", rows[0]["answers"] == 2 and rows[0]["status"] == "pending")
            check("state.judged 에 오래된 것만", list(read_state(home)["judged"]) == [old])


def test_guards() -> None:
    for name, env in (("재귀 가드", {"OPS_AGENT_LESSONS_JUDGE": "1"}), ("비활성", {"OPS_AGENT_LESSONS_DISABLE": "1"})):
        with tempfile.TemporaryDirectory() as home:
            write_transcript(home, "proj", "old", 3 * 3600)
            r = run(home, "spawn", stdin="{}", env=env)
            check(f"{name} 즉시 종료", r.returncode == 0 and r.stdout == "")
            check(f"{name} 상태 미생성", not os.path.exists(lessons(home, "state.json")))


def test_notice() -> None:
    cases = [
        ("pending 있고 승인 이력 없음", None, "pending", True),
        ("pending 있고 8일 지남", (datetime.date.today() - datetime.timedelta(days=8)).isoformat(), "pending", True),
        ("pending 있고 3일 전 승인", (datetime.date.today() - datetime.timedelta(days=3)).isoformat(), "pending", False),
        ("pending 없음", None, "reviewed", False),
    ]
    for name, approval, status, expect in cases:
        with tempfile.TemporaryDirectory() as home:
            write_judgment(home, iso(1), 4, 1, status)
            with open(lessons(home, "state.json"), "w") as f:
                json.dump({"last_approval": approval}, f)
            r = run(home, "spawn", stdin="{}")
            check(f"고지 {name}", ("systemMessage" in r.stdout) == expect, r.stdout)
            if expect:
                check("고지 한 줄 JSON", json.loads(r.stdout.strip())["systemMessage"] == "레슨런 승인 대기 1건 · 정리: /learn", r.stdout)


def test_report() -> None:
    with tempfile.TemporaryDirectory() as home:
        write_judgment(home, iso(1), 10, 2)
        write_judgment(home, iso(2), 10, 1, "reviewed")
        write_judgment(home, iso(30), 100, 50)
        r = run(home, "report")
        check("정답률 = 1 - 3/20 = 85.0%", "85.0%" in r.stdout, r.stdout)
        check("기간 밖 제외 (답 수 20)", "| 답 수 | 20 |" in r.stdout, r.stdout)
        check("승인 대기 건수", "| 승인 대기 | 2건 |" in r.stdout, r.stdout)
        check("대리 지표 표시", "사람 표본 0/50" in r.stdout, r.stdout)
        r = run(home, "approve")
        r = run(home, "report")
        check("approve 뒤 대기 0", "| 승인 대기 | 0건 |" in r.stdout, r.stdout)


def test_review_fixes() -> None:
    """검토 지적: 설치 이전 제외 · 재판정 이중 집계 · 승인 묶음 상한 · 자산 무시 집계 · 잠금."""
    with tempfile.TemporaryDirectory() as home:
        write_transcript(home, "proj", "before-install", 3 * 3600)
        r = run(home, "spawn", stdin=json.dumps({"session_id": "x"}))
        time.sleep(1)
        check("설치 이전 세션은 판정하지 않는다", not os.path.exists(lessons(home, "judgments.jsonl")))
    with tempfile.TemporaryDirectory() as home:
        write_judgment(home, iso(1), 10, 1, transcript="same")
        write_judgment(home, iso(0.5), 12, 2, transcript="same")
        r = run(home, "report")
        check("같은 세션은 마지막 판정만 센다 (답 수 12)", "| 답 수 | 12 |" in r.stdout, r.stdout)
    with tempfile.TemporaryDirectory() as home:
        for i in range(12):
            write_judgment(home, iso(1), 10, 0, transcript=f"t{i}")
        run(home, "approve")
        r = run(home, "report")
        check("승인은 묶음 10건만 닫는다 (대기 2건 남음)", "| 승인 대기 | 2건 |" in r.stdout, r.stdout)
    with tempfile.TemporaryDirectory() as home:
        write_judgment(home, iso(1), 10, 2, hint="원천 먼저 열기")
        r = run(home, "report")
        check("같은 자산 2회는 구조 수정 후보", "| 원천 먼저 열기 | 2 | 예 |" in r.stdout, r.stdout)
    with tempfile.TemporaryDirectory() as home:
        os.makedirs(os.path.dirname(lessons(home, "x")), exist_ok=True)
        open(lessons(home, "judge.lock"), "w").write("1")
        r = run(home, "approve")
        check("판정 중에는 승인이 기다린다", r.returncode != 0 and "진행 중" in (r.stderr + r.stdout), r.stderr)


def test_judge_transcripts_excluded() -> None:
    """판정용 자식 세션의 기록은 다시 판정하지 않는다 (판정이 판정을 낳는 고리)."""
    import re
    with tempfile.TemporaryDirectory() as home:
        work = os.path.join(home, ".claude", "ops-agent", "lessons", "work")
        judge_proj = re.sub(r"[^A-Za-z0-9]", "-", os.path.abspath(work))
        seed_state(home, 86400)
        write_transcript(home, judge_proj, "in-work-dir", 3 * 3600)
        path = write_transcript(home, "proj", "prompt-head", 3 * 3600)
        head = open(TARGET, encoding="utf-8").read().split('PROMPT = """', 1)[1].splitlines()[0]
        rows = [json.loads(l) for l in open(path, encoding="utf-8")]
        rows[0]["message"]["content"] = head + "\n대화"
        with open(path, "w", encoding="utf-8") as f:
            f.writelines(json.dumps(r, ensure_ascii=False) + "\n" for r in rows)
        t = time.time() - 3 * 3600
        os.utime(path, (t, t))
        fake = make_fake_claude(home)
        r = run(home, "spawn", stdin=json.dumps({"session_id": "current"}), env={"OPS_AGENT_LESSONS_CLAUDE": fake})
        time.sleep(2)
        check("판정 기록 제외: 종료 코드 0", r.returncode == 0, r.stderr)
        check("판정 기록 제외: 판정 0건", not os.path.exists(lessons(home, "judgments.jsonl")))


def test_first_install_and_split() -> None:
    """2회차 지적: 첫 설치 뒤 판정이 시작되는가, 기준선 비교가 세션 시각으로 나뉘는가."""
    with tempfile.TemporaryDirectory() as home:
        fake = make_fake_claude(home)
        run(home, "spawn", stdin="{}", env={"OPS_AGENT_LESSONS_CLAUDE": fake})
        saved = os.path.exists(lessons(home, "state.json"))
        check("첫 설치: 설치 시점을 저장한다", saved)
        if not saved:
            return
        st = read_state(home)
        st["since"] -= 2 * 3600  # 2시간이 지난 것으로 둔다
        with open(lessons(home, "state.json"), "w", encoding="utf-8") as f:
            json.dump(st, f)
        write_transcript(home, "proj", "after-install", 3600)
        run(home, "spawn", stdin="{}", env={"OPS_AGENT_LESSONS_CLAUDE": fake})
        check("첫 설치 뒤 세션은 판정된다", wait_for(lessons(home, "judgments.jsonl")))
    with tempfile.TemporaryDirectory() as home:
        os.makedirs(os.path.dirname(lessons(home, "x")), exist_ok=True)
        old = datetime.datetime(2026, 1, 5).timestamp()
        new = datetime.datetime(2026, 1, 20).timestamp()
        rows = [
            {"ts": iso(0), "transcript": "a", "mtime": old, "answers": 10, "corrections": [{"cause": "level"}] * 4, "status": "reviewed"},
            {"ts": iso(0), "transcript": "b", "mtime": new, "answers": 10, "corrections": [{"cause": "level"}], "status": "reviewed"},
        ]
        with open(lessons(home, "judgments.jsonl"), "w", encoding="utf-8") as f:
            f.writelines(json.dumps(r) + "\n" for r in rows)
        r = run(home, "report", "--split", "2026-01-10")
        check("기준선 비교: 세션 시각으로 나눈다", "| 원인 수준 | 60.0% (1세션 · 답 10) | 90.0% (1세션 · 답 10) |" in r.stdout, r.stdout)


def test_round3_fixes() -> None:
    """3회차 지적: 잘린 입력 범위 분모, 재판정 때 승인 상태 · 기간 유지."""
    with tempfile.TemporaryDirectory() as home:
        fake = make_fake_claude(home)
        d = os.path.join(home, ".claude", "projects", "proj")
        os.makedirs(d)
        path = os.path.join(d, "long.jsonl")
        with open(path, "w", encoding="utf-8") as f:
            for i in range(200):
                f.write(json.dumps({"type": "user", "message": {"content": f"질문 {i}"}}, ensure_ascii=False) + "\n")
                f.write(json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "가" * 1200}]}}, ensure_ascii=False) + "\n")
        run(home, "worker", path, env={"OPS_AGENT_LESSONS_CLAUDE": fake})
        rows = [json.loads(l) for l in open(lessons(home, "judgments.jsonl"), encoding="utf-8")]
        check("잘린 입력: 분모는 잘린 범위 안의 답만", 0 < rows[0]["answers"] < 200, str(rows[0]["answers"]))
        run(home, "approve")
        first = rows[0]["first_mtime"]
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps({"type": "user", "message": {"content": "이어서"}}, ensure_ascii=False) + "\n")
        run(home, "worker", path, env={"OPS_AGENT_LESSONS_CLAUDE": fake})
        rows = [json.loads(l) for l in open(lessons(home, "judgments.jsonl"), encoding="utf-8")]
        check("재판정: 승인한 교정은 다시 올리지 않는다", len(rows) == 1 and rows[0]["status"] == "reviewed", str(rows[0]["status"]))
        check("재판정: 기간은 첫 판정 시각으로", rows[0]["first_mtime"] == first)


def main() -> int:
    test_selection_and_worker()
    test_guards()
    test_notice()
    test_report()
    test_judge_transcripts_excluded()
    test_review_fixes()
    test_first_install_and_split()
    test_round3_fixes()
    print(f"통과 {passed} · 실패 {len(failures)}")
    for f in failures:
        print(f"  실패: {f}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
