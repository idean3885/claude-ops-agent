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
        ("pending 있고 승인 이력 없음 · 설치 8일 전", None, "pending", True),
        ("pending 있고 승인 이력 없음 · 설치 1일 전 (첫 주는 고지 없음)", None, "pending", False),
        ("pending 있고 8일 지남", (datetime.date.today() - datetime.timedelta(days=8)).isoformat(), "pending", True),
        ("pending 있고 3일 전 승인", (datetime.date.today() - datetime.timedelta(days=3)).isoformat(), "pending", False),
        ("pending 없음", None, "reviewed", False),
    ]
    for name, approval, status, expect in cases:
        with tempfile.TemporaryDirectory() as home:
            write_judgment(home, iso(1), 4, 1, status)
            with open(lessons(home, "state.json"), "w") as f:
                since_days = 1 if "설치 1일 전" in name else 8
                json.dump({"last_approval": approval, "since": time.time() - since_days * 86400}, f)
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
        check("승인 대기 건수 (7일 지난 대기는 만료)", "| 승인 대기 | 1건 |" in r.stdout, r.stdout)
        check("만료 건수", "| 기한 만료 | 1건 |" in r.stdout, r.stdout)
        check("자동 기각 건수", "| 자동 기각 | 0건 |" in r.stdout, r.stdout)
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
            write_judgment(home, iso(1), 10, 1, transcript=f"t{i}")
        run(home, "approve")
        r = run(home, "report")
        check("승인은 묶음 5건만 닫는다 (대기 7건 남음)", "| 승인 대기 | 7건 |" in r.stdout, r.stdout)
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


def test_baseline() -> None:
    """#997: 설치 이전 세션 표본으로 기준선을 한 번 만든다. 승인 대기에 올리지 않고, 다시 실행하지 않는다."""
    with tempfile.TemporaryDirectory() as home:
        fake = make_fake_claude(home)
        seed_state(home, 60)  # 설치 1분 전 → 3시간 전 세션은 설치 이전
        write_transcript(home, "proj", "past1", 3 * 3600)
        write_transcript(home, "proj", "past2", 4 * 3600)
        r = run(home, "baseline", "--sample", "5", env={"OPS_AGENT_LESSONS_CLAUDE": fake})
        check("기준선: 시작 안내", "기준선 판정 2세션" in r.stdout, r.stdout + r.stderr)
        ok = wait_for(lessons(home, "judgments.jsonl"))
        time.sleep(1.5)
        rows = [json.loads(l) for l in open(lessons(home, "judgments.jsonl"), encoding="utf-8")] if ok else []
        check("기준선: 설치 이전 세션을 판정한다", len(rows) == 2, str(len(rows)))
        check("기준선: 승인 대기에 올리지 않는다", all(x["status"] == "reviewed" and x["baseline"] for x in rows), str(rows))
        check("기준선: 판정이 쌓인 뒤 완료 표시", bool(read_state(home).get("baseline_at")))
        r = run(home, "baseline", env={"OPS_AGENT_LESSONS_CLAUDE": fake})
        check("기준선: 다시 실행하지 않는다", "이미 만들었다" in r.stdout, r.stdout)
        r = run(home, "report")
        check("기준선: report 에 세션 수", "| 기준선 | 2세션 |" in r.stdout, r.stdout)


def test_baseline_failure_allows_retry() -> None:
    """5회차 지적: 기준선 판정이 모두 실패하면 완료 표시를 남기지 않아 다시 실행할 수 있다."""
    with tempfile.TemporaryDirectory() as home:
        bad = os.path.join(home, "bad-claude")
        with open(bad, "w") as f:
            f.write("#!/bin/sh\ncat >/dev/null\nexit 1\n")
        os.chmod(bad, 0o755)
        seed_state(home, 60)
        write_transcript(home, "proj", "past", 3 * 3600)
        run(home, "baseline", env={"OPS_AGENT_LESSONS_CLAUDE": bad})
        # 판정 실패가 로그에 남을 때까지 기다린다 (잠금을 잡기 전에 빠져나오지 않게)
        end = time.time() + 15
        while time.time() < end:
            try:
                if "판정 실패" in open(lessons(home, "judge.log"), encoding="utf-8").read():
                    break
            except OSError:
                pass
            time.sleep(0.2)
        while time.time() < end and os.path.exists(lessons(home, "judge.lock")):
            time.sleep(0.2)
        check("기준선 실패: 완료 표시 없음", not read_state(home).get("baseline_at"))
        r = run(home, "baseline", env={"OPS_AGENT_LESSONS_CLAUDE": bad})
        check("기준선 실패: 다시 실행할 수 있다", "기준선 판정" in r.stdout, r.stdout)


def test_asset_registered_before_correction() -> None:
    """#1232: 표준 용어 목록은 교정 시각에 그 항목이 있었을 때만 재발로 센다. 등재 전 교정은 최초 사례다."""
    def ts(day: str) -> float:
        return datetime.datetime.strptime(day + " 12:00", "%Y-%m-%d %H:%M").timestamp()

    def day(n: int) -> str:
        """오늘에서 n 일 전. 기한 만료(7일)에 걸리지 않게 상대 날짜로 둔다"""
        return (datetime.date.today() - datetime.timedelta(days=n)).isoformat()

    def row(name: str, day: str, hint: str, term: str | None) -> dict:
        c = {"answer": "A1", "cause": "level", "admit": "taste", "why": "용어", "asset_hint": hint}
        if term is not None:
            c["asset_term"] = term
        return {"ts": iso(0), "transcript": name, "mtime": ts(day), "answers": 5, "status": "pending", "corrections": [c]}
    with tempfile.TemporaryDirectory() as home:
        terms = os.path.join(home, "terms.md")
        with open(terms, "w", encoding="utf-8") as f:
            f.write("# 표준 용어\n\n## 항목\n\n### 메트릭\n- 섞어 쓴 말: 지표\n- 등재: " + day(3) + "\n")
        write_rows(home, [
            row("before", day(4), "base/terms.md", "메트릭"),
            row("sameday", day(3), "~/.claude/ops-agent/style-rules/base/terms.md", "메트릭"),
            row("legacy", day(1), "base/terms.md", None),
            row("unknown", day(1), "base/terms.md", "없는 항목"),
        ])
        r = run(home, "report", env={"OPS_AGENT_LESSONS_TERMS": terms})
        check("등재 전 · 등재일 · 항목 미상 교정은 재발 자산 표에 없다", "terms.md" not in r.stdout.split("이번 승인 묶음")[0], r.stdout)
        check("등재 전 교정 후보에 재발 표시가 없다", " · 재발" not in r.stdout, r.stdout)
        write_rows(home, [
            row("before", day(4), "base/terms.md", "메트릭"),
            row("after1", day(2), "base/terms.md", "메트릭"),
            row("after2", day(1), "~/.claude/ops-agent/style-rules/base/terms.md", "메트릭"),
        ])
        r = run(home, "report", env={"OPS_AGENT_LESSONS_TERMS": terms})
        check("등재 뒤 교정 둘은 경로 표기가 달라도 같은 항목의 재발로 센다", "| terms.md 메트릭 | 2 | 예 |" in r.stdout, r.stdout)
        lines = [l for l in r.stdout.splitlines() if l.startswith("- ")]
        check("등재 뒤 교정만 재발 표시, 등재 전 교정은 표시 없음",
              any(l.startswith("- after1") and "재발" in l for l in lines)
              and any(l.startswith("- before") and "재발" not in l for l in lines), "\n".join(lines))


def write_rows(home: str, rows: list[dict]) -> None:
    os.makedirs(os.path.dirname(lessons(home, "x")), exist_ok=True)
    with open(lessons(home, "judgments.jsonl"), "w", encoding="utf-8") as f:
        f.writelines(json.dumps(r, ensure_ascii=False) + "\n" for r in rows)


def read_rows(home: str) -> list[dict]:
    return [json.loads(l) for l in open(lessons(home, "judgments.jsonl"), encoding="utf-8")]


def test_path_cause() -> None:
    """#1154: 원인 갈래에 「경로」(불렀어야 할 스킬 · 전문가 · 검증 단계를 부르지 않음)를 더한다 (ADR-0043 결정 3)."""
    prompt = open(TARGET, encoding="utf-8").read().split('PROMPT = """', 1)[1].split('"""', 1)[0]
    check("경로: 판정 프롬프트가 원인 셋을 받는다", '"cause": "content|level|path"' in prompt, prompt[:200])
    check("경로: 판정 프롬프트가 경로를 정의한다", "path(" in prompt and "부르지 않" in prompt, prompt[:400])
    with tempfile.TemporaryDirectory() as home:
        write_rows(home, [{"ts": iso(1), "transcript": "a", "answers": 10, "taxonomy": 2, "status": "reviewed",
                           "corrections": [{"answer": "A1", "cause": "path"}, {"answer": "A2", "cause": "content"}]}])
        r = run(home, "report")
        check("경로: report 에 원인 경로 행", "| 원인 경로 | 1 |" in r.stdout, r.stdout)
        check("경로: 다른 원인 행은 그대로", "| 원인 내용 | 1 |" in r.stdout and "| 원인 수준 | 0 |" in r.stdout, r.stdout)


def test_taxonomy_marks_and_split() -> None:
    """판정 행에 원인 갈래 판(taxonomy 2)을 남기고, 원인 둘 시절 행(판 없음 = 1)과 경로를 비교하지 않는다."""
    with tempfile.TemporaryDirectory() as home:
        fake = make_fake_claude(home)
        path = write_transcript(home, "proj", "s", 3 * 3600)
        run(home, "worker", path, env={"OPS_AGENT_LESSONS_CLAUDE": fake})
        rows = read_rows(home) if os.path.exists(lessons(home, "judgments.jsonl")) else []
        check("판: 새 판정 행은 taxonomy 2", len(rows) == 1 and rows[0].get("taxonomy") == 2, str(rows))
    old = datetime.datetime(2026, 1, 5).timestamp()
    new = datetime.datetime(2026, 1, 20).timestamp()
    with tempfile.TemporaryDirectory() as home:
        write_rows(home, [
            {"ts": iso(0), "transcript": "a", "mtime": old, "answers": 10, "corrections": [{"cause": "level"}], "status": "reviewed"},
            {"ts": iso(0), "transcript": "b", "mtime": new, "answers": 10, "taxonomy": 2, "corrections": [{"cause": "path"}], "status": "reviewed"},
        ])
        r = run(home, "report", "--split", "2026-01-10")
        check("판: 경로 기준선이 없으면 비교 불가", "| 원인 경로 | 비교 불가" in r.stdout, r.stdout)
        # why: 판 2 는 경로를 먼저 가른다. 판 1 의 내용 · 수준 수와 뜻이 달라 섞어 비교하지 않는다 (주장 검증 1회 권장 5a)
        check("판: 판이 섞이면 내용 · 수준은 비교 불가", "| 원인 수준 | 비교 불가" in r.stdout and "| 원인 내용 | 비교 불가" in r.stdout, r.stdout)
        check("판: 전체(교정 수)는 원인 갈래와 무관해 판이 섞여도 비교한다", "| 전체 | 90.0% (1세션 · 답 10) | 90.0% (1세션 · 답 10) |" in r.stdout, r.stdout)
    with tempfile.TemporaryDirectory() as home:
        write_rows(home, [
            {"ts": iso(0), "transcript": "a", "mtime": old, "answers": 10, "corrections": [{"cause": "level"}], "status": "reviewed"},
            {"ts": iso(0), "transcript": "b", "mtime": new, "answers": 10, "corrections": [], "status": "reviewed"},
        ])
        r = run(home, "report", "--split", "2026-01-10")
        check("판: 같은 판끼리는 내용 · 수준을 비교한다", "| 원인 수준 | 90.0% (1세션 · 답 10) | 100.0% (1세션 · 답 10) |" in r.stdout, r.stdout)
    with tempfile.TemporaryDirectory() as home:
        write_rows(home, [
            {"ts": iso(0), "transcript": "a", "mtime": old, "answers": 10, "taxonomy": 2, "corrections": [{"cause": "path"}] * 2, "status": "reviewed"},
            {"ts": iso(0), "transcript": "c", "mtime": old, "answers": 10, "corrections": [{"cause": "path"}] * 5, "status": "reviewed"},
            {"ts": iso(0), "transcript": "b", "mtime": new, "answers": 10, "taxonomy": 2, "corrections": [{"cause": "path"}], "status": "reviewed"},
        ])
        r = run(home, "report", "--split", "2026-01-10")
        check("판: 경로는 taxonomy 2 행끼리만 비교한다", "| 원인 경로 | 80.0% (1세션 · 답 10) | 90.0% (1세션 · 답 10) |" in r.stdout, r.stdout)
    with tempfile.TemporaryDirectory() as home:
        write_rows(home, [
            {"ts": iso(0), "transcript": "a", "mtime": old, "answers": 10, "corrections": [{"cause": "level"}], "status": "reviewed"},
            {"ts": iso(0), "transcript": "b", "mtime": new, "answers": 10, "taxonomy": 2, "corrections": [{"cause": "path"}], "status": "reviewed"},
        ])
        with open(lessons(home, "path-baseline.jsonl"), "w", encoding="utf-8") as f:
            f.write(json.dumps({"ts": iso(0), "transcript": "a", "first_mtime": old, "answers": 10, "taxonomy": 2, "corrections": [{"cause": "path"}] * 2}) + "\n")
        r = run(home, "report", "--split", "2026-01-10")
        check("판: 경로 기준선 파일의 경로 수가 기준선(전)이다", "| 원인 경로 | 80.0% (1세션 · 답 10) | 90.0% (1세션 · 답 10) |" in r.stdout, r.stdout)


def test_block_user_messages() -> None:
    """#1237: 블록 목록으로 저장된 사용자 발화(이미지 첨부 · 붙여 넣기)도 판정 입력에 넣는다.
    도구 결과 · 메타 행(스킬 본문 · 이미지 경로 주석) · 태그로 시작하는 주입 글 · 중단 표시는 넣지 않는다."""
    with tempfile.TemporaryDirectory() as home:
        d = os.path.join(home, ".claude", "projects", "proj")
        os.makedirs(d)
        path = os.path.join(d, "s.jsonl")
        rows = [
            {"type": "user", "message": {"content": "문자열 질문"}},
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "답1"}]}},
            {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t", "content": "도구출력"}]}},
            {"type": "user", "message": {"content": [{"type": "text", "text": "[Request interrupted by user]"}]}},
            {"type": "user", "message": {"content": [{"type": "text", "text": "블록 교정"},
                                                     {"type": "image", "source": {"type": "base64", "data": "x"}}]}},
            {"type": "user", "isMeta": True, "message": {"content": [{"type": "text", "text": "[Image: source: /tmp/a.png]"}]}},
            {"type": "user", "message": {"content": [{"type": "text", "text": "<system-reminder>주입</system-reminder>"},
                                                     {"type": "text", "text": "붙여 넣은 교정"}]}},
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "답2"}]}},
        ]
        with open(path, "w", encoding="utf-8") as f:
            f.writelines(json.dumps(r, ensure_ascii=False) + "\n" for r in rows)
        t = time.time() - 3 * 3600
        os.utime(path, (t, t))
        captured = os.path.join(home, "captured.txt")
        fake = os.path.join(home, "fake-capture")
        with open(fake, "w") as f:
            f.write(f"#!/bin/sh\ncat > '{captured}'\nprintf '%s' '"
                    + json.dumps({"result": json.dumps(FAKE_VERDICT), "total_cost_usd": 0.01}) + "'\n")
        os.chmod(fake, 0o755)
        run(home, "worker", path, env={"OPS_AGENT_LESSONS_CLAUDE": fake})
        text = open(captured, encoding="utf-8").read() if os.path.exists(captured) else ""
        check("블록 발화: 문자열 발화는 그대로 들어간다", "USER: 문자열 질문" in text, text[-400:])
        check("블록 발화: 첨부 발화의 텍스트가 직전 답 뒤 사용자 발화로 들어간다",
              "A1: 답1\n\nUSER: 블록 교정\n\nUSER: 붙여 넣은 교정\n\nA2: 답2" in text, text[-400:])
        check("블록 발화: 도구 결과 · 메타 행 · 주입 글 · 중단 표시는 넣지 않는다",
              not any(s in text for s in ("도구출력", "[Image: source", "system-reminder", "Request interrupted")), text[-400:])
        rows = read_rows(home) if os.path.exists(lessons(home, "judgments.jsonl")) else []
        check("입력 판: 새 판정 행은 input 2", len(rows) == 1 and rows[0].get("input") == 2, str(rows))


def test_input_version_split() -> None:
    """#1237: 입력 판이 다른 행(판 표시 없음 = 1, 블록 발화를 빠뜨리던 시절)은 전후 비교에서 뺀다."""
    old = datetime.datetime(2026, 1, 5).timestamp()
    mid = datetime.datetime(2026, 1, 8).timestamp()
    new = datetime.datetime(2026, 1, 20).timestamp()
    with tempfile.TemporaryDirectory() as home:
        write_rows(home, [
            {"ts": iso(0), "transcript": "a", "mtime": old, "answers": 10, "taxonomy": 2, "corrections": [], "status": "reviewed"},
            {"ts": iso(0), "transcript": "m", "mtime": mid, "answers": 10, "taxonomy": 2, "input": 2,
             "corrections": [{"cause": "level"}] * 3, "status": "reviewed"},
            {"ts": iso(0), "transcript": "b", "mtime": new, "answers": 10, "taxonomy": 2, "input": 2,
             "corrections": [{"cause": "level"}], "status": "reviewed"},
        ])
        with open(lessons(home, "path-baseline.jsonl"), "w", encoding="utf-8") as f:
            f.write(json.dumps({"ts": iso(0), "transcript": "z", "first_mtime": old, "answers": 10, "taxonomy": 2,
                                "corrections": [{"cause": "path"}] * 5}) + "\n")
        r = run(home, "report", "--split", "2026-01-10")
        check("입력 판: 전체는 같은 입력 판 행끼리만 비교한다",
              "| 전체 | 70.0% (1세션 · 답 10) | 90.0% (1세션 · 답 10) |" in r.stdout, r.stdout)
        check("입력 판: 경로 기준선도 입력 판이 다르면 뺀다",
              "| 원인 경로 | 100.0% (1세션 · 답 10) |" in r.stdout, r.stdout)
        check("입력 판: 뺀 세션 수를 알린다", "입력 판이 달라 뺀 세션 2" in r.stdout, r.stdout)
    with tempfile.TemporaryDirectory() as home:
        write_rows(home, [
            {"ts": iso(0), "transcript": "a", "session": "a", "mtime": old, "answers": 10, "corrections": [], "status": "reviewed"},
            {"ts": iso(0), "transcript": "b", "session": "b", "mtime": new, "answers": 10, "input": 2,
             "corrections": [{"cause": "level"}], "status": "reviewed"},
            {"ts": iso(0), "transcript": "c", "session": "c", "mtime": new, "answers": 10, "input": 2,
             "corrections": [], "status": "reviewed"},
        ])
        source = os.path.join(home, "hits.jsonl")
        with open(source, "w", encoding="utf-8") as f:
            f.write(json.dumps({"session": "a"}) + "\n" + json.dumps({"session": "b"}) + "\n")
        r = run(home, "report", "--sessions-from", source)
        check("입력 판: 세션 집합 비교도 같은 입력 판 행끼리만 한다",
              "| 세션 집합 | 90.0% (1세션 · 답 10) |" in r.stdout and "| 나머지 | 100.0% (1세션 · 답 10) |" in r.stdout
              and "입력 판이 달라 뺀 세션 1" in r.stdout, r.stdout)


def test_sample_record_path() -> None:
    with tempfile.TemporaryDirectory() as home:
        write_rows(home, [{"ts": iso(1), "transcript": "t", "answers": 2, "taxonomy": 2, "status": "reviewed",
                           "corrections": [{"answer": "A1", "cause": "path"}]}])
        r = run(home, "sample-record", "t", "A1", "path")
        samples = [json.loads(l) for l in open(lessons(home, "samples.jsonl"), encoding="utf-8")] if os.path.exists(lessons(home, "samples.jsonl")) else []
        check("표본: path 를 받는다", r.returncode == 0 and len(samples) == 1 and samples[0]["human"] == "path" and samples[0]["machine"] == "path",
              r.stderr + str(samples))
        r = run(home, "sample-record", "t", "A1", "route")
        check("표본: 정해진 값 밖은 거부한다", r.returncode != 0 and "correct|content|level|path" in (r.stderr + r.stdout), r.stderr)


def test_sessions_from() -> None:
    """문구 감지 지표의 세션 식별자로 그 세션들의 정답률을 나머지와 나란히 낸다 (#1154 시범-지표 연결)."""
    with tempfile.TemporaryDirectory() as home:
        write_rows(home, [
            {"ts": iso(1), "transcript": "/p/s1.jsonl", "session": "s1", "answers": 10, "corrections": [{"cause": "content"}] * 3, "status": "reviewed"},
            {"ts": iso(1), "transcript": "/p/s2.jsonl", "session": "s2", "answers": 10, "corrections": [], "status": "reviewed"},
        ])
        metric = os.path.join(home, "m.jsonl")
        with open(metric, "w", encoding="utf-8") as f:
            f.write(json.dumps({"ts": iso(1), "matched": "delegation", "session": "s1"}) + "\n")
            f.write(json.dumps({"ts": iso(1), "matched": "delegation"}) + "\n")
        r = run(home, "report", "--sessions-from", metric)
        check("세션 집합: 그 세션들의 정답률", "| 세션 집합 | 70.0% (1세션 · 답 10) |" in r.stdout, r.stdout)
        check("세션 집합: 나머지 정답률", "| 나머지 | 100.0% (1세션 · 답 10) |" in r.stdout, r.stdout)
        check("세션 집합: 세션 식별자 없는 줄 수를 알린다", "식별자 없는 줄 1" in r.stdout, r.stdout)
    with tempfile.TemporaryDirectory() as home:
        old = time.time() - 30 * 86400
        write_rows(home, [
            {"ts": iso(30), "transcript": "/p/s1.jsonl", "session": "s1", "mtime": old, "answers": 10, "corrections": [{"cause": "content"}] * 3, "status": "reviewed"},
            {"ts": iso(1), "transcript": "/p/s2.jsonl", "session": "s2", "answers": 10, "corrections": [], "status": "reviewed"},
        ])
        metric = os.path.join(home, "m.jsonl")
        with open(metric, "w", encoding="utf-8") as f:
            f.write(json.dumps({"ts": iso(30), "matched": "delegation", "session": "s1"}) + "\n")
        r = run(home, "report", "--sessions-from", metric, "--days", "7")
        check("세션 집합: --days 밖 세션은 빼고 비교한다", "| 세션 집합 | - |" in r.stdout and "| 나머지 | 100.0% (1세션 · 답 10) |" in r.stdout, r.stdout)


def test_path_baseline() -> None:
    """ADR-0043 결정 3: 경로 원인에 한해 기준선을 한 번 다시 판정한다 (ADR-0037 결정 5 의 예외).
    기존 판정 행(내용 · 수준 기준선 포함)은 덮지 않고 경로 수만 lessons/path-baseline.jsonl 에 따로 남긴다 (주장 검증 1회 권장 5b)."""
    with tempfile.TemporaryDirectory() as home:
        fake = os.path.join(home, "fake-claude-path")
        verdict = {"answers": 2, "corrections": [{"answer": "A1", "cause": "path", "why": "부르지 않음", "asset_hint": ""},
                                                 {"answer": "A2", "cause": "level", "why": "분량", "asset_hint": ""}]}
        with open(fake, "w") as f:
            f.write("#!/bin/sh\ncat >/dev/null\nprintf '%s' '" + json.dumps({"result": json.dumps(verdict), "total_cost_usd": 0.01}) + "'\n")
        os.chmod(fake, 0o755)
        p1 = write_transcript(home, "proj", "old1", 3 * 86400)
        p2 = write_transcript(home, "proj", "old2", 4 * 86400)
        write_rows(home, [
            {"ts": iso(3), "transcript": p1, "session": "old1", "mtime": 1, "first_mtime": 1, "answers": 2, "corrections": [], "status": "reviewed", "baseline": True},
            {"ts": iso(4), "transcript": p2, "session": "old2", "mtime": 1, "first_mtime": 1, "answers": 2, "corrections": [], "status": "pending"},
            {"ts": iso(4), "transcript": "/gone.jsonl", "session": "gone", "answers": 2, "corrections": [], "status": "reviewed"},
        ])
        before = open(lessons(home, "judgments.jsonl"), encoding="utf-8").read()
        seed_state(home, 86400)
        judged_before = read_state(home).get("judged", {})
        r = run(home, "baseline", "--path", env={"OPS_AGENT_LESSONS_CLAUDE": fake})
        check("경로 기준선: 원인 둘 시절 행 중 남은 기록만 다시 판정", "경로 기준선 판정 2세션" in r.stdout, r.stdout + r.stderr)
        end = time.time() + 15
        while time.time() < end and not read_state(home).get("path_baseline_at"):
            time.sleep(0.2)
        while time.time() < end and os.path.exists(lessons(home, "judge.lock")):
            time.sleep(0.2)
        check("경로 기준선: 기존 판정 행(내용 · 수준 기준선 · 승인 상태)을 덮지 않는다 — 하루 상한에도 세지 않는다",
              open(lessons(home, "judgments.jsonl"), encoding="utf-8").read() == before, read_rows(home).__str__())
        pb = {}
        if os.path.exists(lessons(home, "path-baseline.jsonl")):
            pb = {json.loads(l)["transcript"]: json.loads(l) for l in open(lessons(home, "path-baseline.jsonl"), encoding="utf-8")}
        check("경로 기준선: 경로 수만 따로 남긴다 (판 2, 경로 교정만)",
              set(pb) == {p1, p2} and all(x.get("taxonomy") == 2 and x.get("answers") == 2 and [c["cause"] for c in x["corrections"]] == ["path"] for x in pb.values()), str(pb))
        check("경로 기준선: 기간은 처음 판정한 시각 그대로", all(x.get("first_mtime") == 1 for x in pb.values()), str(pb))
        check("경로 기준선: 판정한 세션 표시(state judged)를 바꾸지 않는다", read_state(home).get("judged", {}) == judged_before, str(read_state(home).get("judged")))
        check("경로 기준선: 완료 표시", bool(read_state(home).get("path_baseline_at")))
        check("경로 기준선: 원인 둘 기준선 완료 표시는 건드리지 않는다", not read_state(home).get("baseline_at"))
        r = run(home, "baseline", "--path", env={"OPS_AGENT_LESSONS_CLAUDE": fake})
        check("경로 기준선: 다시 실행하지 않는다", "이미 만들었다" in r.stdout, r.stdout)


def test_path_baseline_cap_and_state() -> None:
    """경로 기준선은 하루 판정 상한에 막히지 않고, 실패해도 평소 판정의 공용 상태를 바꾸지 않는다 (주장 검증 2회 권장 5 · 사소 11)."""
    with tempfile.TemporaryDirectory() as home:
        fake = make_fake_claude(home)
        p1 = write_transcript(home, "proj", "old1", 3 * 86400)
        # 오늘 판정한 평소 행으로 하루 상한을 채운다
        today_rows = [{"ts": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"), "transcript": f"/today{i}.jsonl",
                       "session": f"today{i}", "answers": 1, "corrections": [], "status": "reviewed", "taxonomy": 2} for i in range(10)]
        write_rows(home, [{"ts": iso(3), "transcript": p1, "session": "old1", "mtime": 1, "first_mtime": 1, "answers": 2,
                           "corrections": [], "status": "reviewed"}] + today_rows)
        seed_state(home, 86400)
        run(home, "baseline", "--path", env={"OPS_AGENT_LESSONS_CLAUDE": fake})
        end = time.time() + 15
        while time.time() < end and not os.path.exists(lessons(home, "path-baseline.jsonl")):
            time.sleep(0.2)
        while time.time() < end and os.path.exists(lessons(home, "judge.lock")):
            time.sleep(0.2)
        check("경로 기준선: 오늘 하루 상한이 찼어도 판정한다", os.path.exists(lessons(home, "path-baseline.jsonl")),
              open(lessons(home, "judge.log"), encoding="utf-8").read() if os.path.exists(lessons(home, "judge.log")) else "")
    with tempfile.TemporaryDirectory() as home:
        broken = os.path.join(home, "broken-claude")
        with open(broken, "w") as f:
            f.write("#!/bin/sh\ncat >/dev/null\nexit 3\n")
        os.chmod(broken, 0o755)
        p1 = write_transcript(home, "proj", "old1", 3 * 86400)
        write_rows(home, [{"ts": iso(3), "transcript": p1, "session": "old1", "mtime": 1, "first_mtime": 1, "answers": 2,
                           "corrections": [], "status": "reviewed"}])
        seed_state(home, 86400)
        run(home, "worker", p1, env={"OPS_AGENT_LESSONS_CLAUDE": broken, "OPS_AGENT_LESSONS_PATH_BASELINE": "1"})
        st = read_state(home)
        check("경로 기준선: 판정 실패가 실패 횟수 · 판정한 세션 표시를 바꾸지 않는다", not st.get("fails") and not st.get("judged"), str(st))


def test_path_baseline_scope() -> None:
    """#1162: 경로 기준선의 범위. 답 0건 세션은 공용 상태를 쓰지 않고, 판 2 로 판정한 세션은 대상에서 빠지며,
    비교는 같은 원인 갈래 판끼리만 한다 (ADR-0043 결정 3)."""
    with tempfile.TemporaryDirectory() as home:
        fake = make_fake_claude(home)
        d = os.path.join(home, ".claude", "projects", "proj")
        os.makedirs(d, exist_ok=True)
        empty = os.path.join(d, "noanswer.jsonl")
        with open(empty, "w", encoding="utf-8") as f:
            f.write(json.dumps({"type": "user", "message": {"content": "질문만"}}, ensure_ascii=False) + "\n")
        seed_state(home, 86400)
        run(home, "worker", empty, env={"OPS_AGENT_LESSONS_CLAUDE": fake, "OPS_AGENT_LESSONS_PATH_BASELINE": "1"})
        check("경로 기준선: 답 0건 세션은 판정한 세션 표시(공용 상태)를 쓰지 않는다", not read_state(home).get("judged"), str(read_state(home)))
        run(home, "worker", empty, env={"OPS_AGENT_LESSONS_CLAUDE": fake})
        check("대조: 평소 판정은 답 0건 세션을 판정한 세션으로 표시한다", empty in read_state(home).get("judged", {}), str(read_state(home)))
    with tempfile.TemporaryDirectory() as home:
        fake = make_fake_claude(home)
        p1 = write_transcript(home, "proj", "old1", 3 * 86400)
        p2 = write_transcript(home, "proj", "new2", 3 * 86400)
        write_rows(home, [
            {"ts": iso(3), "transcript": p1, "session": "old1", "mtime": 1, "answers": 2, "corrections": [], "status": "reviewed"},
            {"ts": iso(3), "transcript": p2, "session": "new2", "mtime": 1, "answers": 2, "taxonomy": 2, "corrections": [], "status": "reviewed"},
        ])
        seed_state(home, 86400)
        r = run(home, "baseline", "--path", env={"OPS_AGENT_LESSONS_CLAUDE": fake})
        check("경로 기준선: 판 2 로 판정한 세션은 대상에서 빠진다", "경로 기준선 판정 1세션" in r.stdout, r.stdout + r.stderr)
        end = time.time() + 15
        while time.time() < end and not read_state(home).get("path_baseline_at"):
            time.sleep(0.2)
        while time.time() < end and os.path.exists(lessons(home, "judge.lock")):
            time.sleep(0.2)
        pb = [json.loads(l)["transcript"] for l in open(lessons(home, "path-baseline.jsonl"), encoding="utf-8")] if os.path.exists(lessons(home, "path-baseline.jsonl")) else []
        check("경로 기준선: 다시 판정한 세션은 판 1 세션뿐", pb == [p1], str(pb))
    old = datetime.datetime(2026, 1, 5).timestamp()
    new = datetime.datetime(2026, 1, 20).timestamp()
    with tempfile.TemporaryDirectory() as home:
        write_rows(home, [
            {"ts": iso(0), "transcript": "a", "mtime": old, "answers": 10, "taxonomy": 2, "corrections": [{"cause": "path"}] * 2, "status": "reviewed"},
            {"ts": iso(0), "transcript": "b", "mtime": new, "answers": 10, "taxonomy": 2, "corrections": [{"cause": "path"}], "status": "reviewed"},
            {"ts": iso(0), "transcript": "d", "mtime": new, "answers": 10, "corrections": [{"cause": "path"}] * 3, "status": "reviewed"},
        ])
        with open(lessons(home, "path-baseline.jsonl"), "w", encoding="utf-8") as f:
            f.write(json.dumps({"ts": iso(0), "transcript": "a", "first_mtime": old, "answers": 10, "taxonomy": 2, "corrections": [{"cause": "path"}] * 5}) + "\n")
        r = run(home, "report", "--split", "2026-01-10")
        check("판: 경로 비교는 판 2 행끼리(판 2 판정 행이 있는 세션은 기준선 파일 행을 쓰지 않고, 시범 쪽 판 1 행은 뺀다)",
              "| 원인 경로 | 80.0% (1세션 · 답 10) | 90.0% (1세션 · 답 10) |" in r.stdout, r.stdout)


def test_close_and_wrap() -> None:
    """ADR-0047: 올릴 것이 없는 대기는 기각, 기한이 지나면 만료, 마무리는 대기가 있을 때만 안내한다."""
    prompt = open(TARGET, encoding="utf-8").read()
    check("등재 조건: 판정 프롬프트가 admit 넷을 받는다", '"admit": "fact|procedure|taste|none"' in prompt)
    with tempfile.TemporaryDirectory() as home:
        def c(admit=None):
            d = {"answer": "A1", "cause": "content", "why": "", "asset_hint": ""}
            if admit:
                d["admit"] = admit
            return d
        write_rows(home, [
            {"ts": iso(1), "transcript": "zero", "answers": 5, "corrections": [], "status": "pending"},
            {"ts": iso(1), "transcript": "none", "answers": 5, "corrections": [c("none"), c("none")], "status": "pending"},
            {"ts": iso(1), "transcript": "mixed", "answers": 5, "corrections": [c("none"), c("fact")], "status": "pending"},
            {"ts": iso(1), "transcript": "legacy", "answers": 5, "corrections": [c()], "status": "pending"},
            {"ts": iso(8), "transcript": "old", "answers": 5, "corrections": [c("procedure")], "status": "pending"},
            {"ts": iso(6), "transcript": "recent", "answers": 5, "corrections": [c("procedure")], "status": "pending"},
            {"ts": iso(15), "transcript": "done", "answers": 5, "corrections": [c("fact")], "status": "reviewed"},
        ])
        r = run(home, "wrap")
        got = {x["transcript"]: x["status"] for x in read_rows(home)}
        check("교정 0건 대기는 기각", got["zero"] == "rejected", str(got))
        check("모두 등재 조건 없음은 기각", got["none"] == "rejected", str(got))
        check("등재 후보가 하나라도 있으면 대기", got["mixed"] == "pending", str(got))
        check("판정 전 행(admit 없음)은 대기로 둔다", got["legacy"] == "pending", str(got))
        check("7일 지난 대기는 만료", got["old"] == "expired", str(got))
        check("7일 안의 대기는 남는다", got["recent"] == "pending", str(got))
        check("검토 완료는 건드리지 않는다", got["done"] == "reviewed", str(got))
        check("마무리 안내: 대기 수와 묶음 상한", "레슨 승인 대기 3건 · 후보 3개" in r.stdout and "후보 3개만 연다" in r.stdout, r.stdout)
    with tempfile.TemporaryDirectory() as home:
        write_rows(home, [{"ts": iso(1), "transcript": "zero", "answers": 5, "corrections": [], "status": "pending"}])
        r = run(home, "wrap")
        check("마무리 안내: 올릴 대기가 없으면 아무것도 내지 않는다", r.stdout.strip() == "", r.stdout)
    with tempfile.TemporaryDirectory() as home:
        for i in range(7):
            write_judgment(home, iso(1), 10, 1, transcript=f"t{i}")
        r = run(home, "wrap")
        check("마무리 안내: 묶음은 후보 5개까지", "레슨 승인 대기 7건 · 후보 7개" in r.stdout and "후보 5개만 연다" in r.stdout, r.stdout)
    with tempfile.TemporaryDirectory() as home:
        os.makedirs(os.path.dirname(lessons(home, "x")), exist_ok=True)
        open(lessons(home, "judge.lock"), "w").write("1")
        write_rows(home, [{"ts": iso(1), "transcript": "zero", "answers": 5, "corrections": [], "status": "pending"}])
        run(home, "wrap")
        check("판정 중(잠금)에는 닫지 않는다", read_rows(home)[0]["status"] == "pending")
    # 판정 경로: 새 교정이 모두 등재 조건 없음이면 대기에 넣지 않는다
    with tempfile.TemporaryDirectory() as home:
        seed_state(home, 7 * 86400)
        path = write_transcript(home, "proj", "s-none", 3600)
        fake = os.path.join(home, "fake-none")
        verdict = {"answers": 2, "corrections": [{"answer": "A2", "cause": "level", "admit": "none", "why": "분량", "asset_hint": ""}]}
        with open(fake, "w") as f:
            f.write("#!/bin/sh\ncat >/dev/null\nprintf '%s' '" + json.dumps({"result": json.dumps(verdict), "total_cost_usd": 0.01}) + "'\n")
        os.chmod(fake, 0o755)
        run(home, "worker", path, env={"OPS_AGENT_LESSONS_CLAUDE": fake})
        rows = read_rows(home)
        check("판정: 등재 조건 없음만 나온 세션은 기각으로 쌓인다", rows and rows[-1]["status"] == "rejected" and rows[-1]["corrections"][0]["admit"] == "none", str(rows))
        fake2 = make_fake_claude(home)
        path2 = write_transcript(home, "proj", "s-legacy", 3600)
        run(home, "worker", path2, env={"OPS_AGENT_LESSONS_CLAUDE": fake2})
        rows = {r["transcript"]: r for r in read_rows(home)}
        check("판정: admit 을 내지 않은 판정은 대기로 둔다", rows[path2]["status"] == "pending", str(rows[path2]))

    def fake_with(home: str, name: str, corrections: list) -> str:
        path = os.path.join(home, name)
        v = {"answers": 2, "corrections": corrections}
        with open(path, "w") as f:
            f.write("#!/bin/sh\ncat >/dev/null\nprintf '%s' '" + json.dumps({"result": json.dumps(v), "total_cost_usd": 0.01}) + "'\n")
        os.chmod(path, 0o755)
        return path
    # 판정 경로: 교정 0건은 기각, 검토 완료한 교정은 다시 후보로 세지 않는다
    with tempfile.TemporaryDirectory() as home:
        seed_state(home, 7 * 86400)
        path = write_transcript(home, "proj", "s-zero", 3600)
        run(home, "worker", path, env={"OPS_AGENT_LESSONS_CLAUDE": fake_with(home, "f0", [])})
        check("판정: 교정 0건 세션은 기각으로 쌓인다", read_rows(home)[-1]["status"] == "rejected", str(read_rows(home)))
    with tempfile.TemporaryDirectory() as home:
        seed_state(home, 7 * 86400)
        path = write_transcript(home, "proj", "s-seen", 3600)
        write_rows(home, [{"ts": iso(0), "transcript": path, "answers": 2, "status": "reviewed",
                           "corrections": [{"answer": "A1", "cause": "content", "admit": "fact"}]}])
        fake = fake_with(home, "f1", [{"answer": "A1", "cause": "content", "admit": "fact"},
                                      {"answer": "A3", "cause": "level", "admit": "none"}])
        run(home, "worker", path, env={"OPS_AGENT_LESSONS_CLAUDE": fake})
        check("판정: 새 교정이 모두 없음이면 검토한 옛 후보가 있어도 기각", read_rows(home)[-1]["status"] == "rejected", str(read_rows(home)))
        run(home, "worker", path, env={"OPS_AGENT_LESSONS_CLAUDE": fake})
        check("판정: 기각된 세션을 다시 판정해도 옛 교정을 후보로 되살리지 않는다", read_rows(home)[-1]["status"] == "rejected", str(read_rows(home)))
        r = run(home, "report")
        check("보고: 자동 기각 건수를 센다", "| 자동 기각 | 1건 |" in r.stdout, r.stdout)
    # 세션 시작도 대기를 닫는다
    with tempfile.TemporaryDirectory() as home:
        seed_state(home, 7 * 86400)
        write_rows(home, [{"ts": iso(1), "transcript": "zero", "answers": 5, "corrections": [], "status": "pending"}])
        run(home, "spawn", stdin="{}", env={"OPS_AGENT_LESSONS_DISABLE": "0"})
        check("세션 시작: 올릴 것이 없는 대기를 닫는다", read_rows(home)[0]["status"] == "rejected", str(read_rows(home)))
    # 승인 묶음 줄이 등재 후보 수를 보인다
    with tempfile.TemporaryDirectory() as home:
        write_rows(home, [{"ts": iso(1), "transcript": "m", "answers": 5, "status": "pending",
                           "corrections": [{"answer": "A1", "admit": "none"}, {"answer": "A2", "admit": "taste"}]}])
        r = run(home, "report")
        check("승인 묶음: 등재 조건 없음은 올리지 않고 후보만 한 줄씩", "m A2 · 원인" in r.stdout and "m A1 ·" not in r.stdout and "후보 1개" in r.stdout, r.stdout)
    test_candidate_batch()


def test_candidate_batch() -> None:
    """#1209: 승인 묶음은 세션이 아니라 등재 후보 5개다. 재발 후보가 먼저, 남은 후보는 세션에 남는다."""
    def fake_with(home: str, name: str, corrections: list) -> str:
        path = os.path.join(home, name)
        v = {"answers": 2, "corrections": corrections}
        with open(path, "w") as f:
            f.write("#!/bin/sh\ncat >/dev/null\nprintf '%s' '" + json.dumps({"result": json.dumps(v), "total_cost_usd": 0.01}) + "'\n")
        os.chmod(path, 0o755)
        return path

    def cands(n, prefix="A", hint=""):
        return [{"answer": f"{prefix}{i}", "cause": "content", "admit": "fact", "why": "", "asset_hint": hint} for i in range(n)]
    with tempfile.TemporaryDirectory() as home:
        write_rows(home, [
            {"ts": iso(2), "transcript": "big", "answers": 300, "status": "pending", "corrections": cands(18)},
            {"ts": iso(1), "transcript": "small", "answers": 20, "status": "pending",
             "corrections": cands(1, "B", "원천 먼저 열기") + cands(1, "C", "원천 먼저 열기")},
        ])
        r = run(home, "report")
        lines = [l for l in r.stdout.splitlines() if l.startswith("- ")]
        check("묶음은 후보 5개 (세션 둘, 후보 20개)", "이번 승인 묶음 (후보 5개" in r.stdout and len(lines) == 5, r.stdout)
        check("재발 후보(같은 자산 2회)가 먼저", lines[0].startswith("- small B0") and lines[1].startswith("- small C0") and "재발" in lines[0], "\n".join(lines))
        check("보고: 승인 대기 후보 수", "| 승인 대기 후보 | 20개 |" in r.stdout, r.stdout)
        run(home, "approve")
        got = {x["transcript"]: x for x in read_rows(home)}
        check("approve: 후보가 다 닫힌 세션만 검토 완료", got["small"]["status"] == "reviewed", str(got["small"]))
        check("approve: 후보가 남은 세션은 대기로 남는다", got["big"]["status"] == "pending"
              and sum(1 for c in got["big"]["corrections"] if c.get("reviewed")) == 3, str(got["big"]))
        r = run(home, "report")
        check("다음 묶음은 남은 후보에서 5개", "| 승인 대기 후보 | 15개 |" in r.stdout and "- big A3 ·" in r.stdout and "- big A0 ·" not in r.stdout, r.stdout)
    with tempfile.TemporaryDirectory() as home:
        seed_state(home, 7 * 86400)
        path = write_transcript(home, "proj", "s-partial", 3600)
        write_rows(home, [{"ts": iso(0), "transcript": path, "answers": 4, "status": "pending",
                           "corrections": [{"answer": "A1", "cause": "content", "admit": "fact", "reviewed": True},
                                           {"answer": "A2", "cause": "content", "admit": "fact"}]}])
        fake = fake_with(home, "fp", [{"answer": "A1", "cause": "content", "admit": "fact"},
                                      {"answer": "A2", "cause": "content", "admit": "fact"}])
        run(home, "worker", path, env={"OPS_AGENT_LESSONS_CLAUDE": fake})
        row = read_rows(home)[-1]
        check("재판정: 대기 중에 이미 본 후보는 다시 올리지 않는다",
              row["status"] == "pending" and [c.get("reviewed", False) for c in row["corrections"]] == [True, False], str(row))


def main() -> int:
    test_selection_and_worker()
    test_guards()
    test_notice()
    test_report()
    test_judge_transcripts_excluded()
    test_review_fixes()
    test_first_install_and_split()
    test_round3_fixes()
    test_baseline()
    test_baseline_failure_allows_retry()
    test_path_cause()
    test_taxonomy_marks_and_split()
    test_block_user_messages()
    test_input_version_split()
    test_sample_record_path()
    test_sessions_from()
    test_path_baseline()
    test_path_baseline_cap_and_state()
    test_path_baseline_scope()
    test_close_and_wrap()
    test_candidate_batch()
    test_asset_registered_before_correction()
    print(f"통과 {passed} · 실패 {len(failures)}")
    for f in failures:
        print(f"  실패: {f}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
