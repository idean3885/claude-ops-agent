#!/usr/bin/env python3
"""usage-log.py · usage-statusline.sh 자체 점검 (#1242).

상태줄 래퍼는 매 갱신마다 돌아 출력이 깨지면 작업 화면이 깨지고, 기록 · 역산이 무너져도 신호가 없다.
임시 HOME 으로 래퍼 출력 · 기록 실패 · 변경 없을 때 · 설치 멱등 · 역산의 증가분 · 재시작 · 계수를 확인한다.

    python3 scripts/selftest-usage-log.py [대상 스크립트 디렉토리]
"""

from __future__ import annotations

import datetime
import json
import os
import subprocess
import sys
import tempfile
import time

HERE = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(HERE, "usage-log.py")
WRAPPER = os.path.join(HERE, "usage-statusline.sh")

failures: list[str] = []
passed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global passed
    if ok:
        passed += 1
    else:
        failures.append(f"{name} {detail}")


def env_for(home: str, extra: dict | None = None) -> dict:
    e = {k: v for k, v in os.environ.items() if k not in ("CLAUDE_CONFIG_DIR", "CLAUDE_CODE_SESSION_ID")}
    e["HOME"] = home
    e.update(extra or {})
    return e


def ops(home: str, *parts: str) -> str:
    return os.path.join(home, ".claude", "ops-agent", *parts)


def statusline_input(session: str = "s1", cost: float = 1.5, five: int = 1) -> str:
    return json.dumps({
        "session_id": session, "model": {"id": "claude-x"},
        "cost": {"total_cost_usd": cost},
        "context_window": {"total_input_tokens": 100, "total_output_tokens": 20},
        "rate_limits": {"five_hour": {"used_percentage": five, "resets_at": 1795461600},
                        "seven_day": {"used_percentage": 23, "resets_at": 1795899600},
                        "spend_limit": {"used_percentage": 3}},
    })


def wrap(home: str, stdin: str, extra: dict | None = None) -> tuple[subprocess.CompletedProcess, float]:
    started = time.time()
    r = subprocess.run(["bash", WRAPPER], input=stdin, capture_output=True, text=True, env=env_for(home, extra), timeout=30)
    return r, time.time() - started


def set_original(home: str, command: str) -> None:
    os.makedirs(ops(home, "statusline"), exist_ok=True)
    with open(ops(home, "statusline", "original.cmd"), "w", encoding="utf-8") as f:
        f.write(command)


def lines(home: str) -> list[dict]:
    try:
        return [json.loads(l) for l in open(ops(home, "metrics", "usage-statusline.jsonl"), encoding="utf-8")]
    except OSError:
        return []


def wait_lines(home: str, n: int, seconds: float = 10) -> list[dict]:
    end = time.time() + seconds
    while time.time() < end:
        got = lines(home)
        if len(got) >= n:
            time.sleep(0.2)
            return lines(home)
        time.sleep(0.05)
    return lines(home)


def log(home: str, *args: str, extra: dict | None = None, stdin: str = "") -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, LOG, *args], input=stdin, capture_output=True, text=True,
                          env=env_for(home, extra), timeout=30)


def test_wrapper_passes_output() -> None:
    with tempfile.TemporaryDirectory() as home:
        set_original(home, "printf 'HUD:'; cat; exit 3")
        stdin = statusline_input()
        r, _ = wrap(home, stdin)
        check("래퍼: 원래 명령 출력을 그대로 낸다", r.stdout == "HUD:" + stdin, repr(r.stdout[:80]))
        check("래퍼: 원래 명령 종료 코드를 그대로 낸다", r.returncode == 3, str(r.returncode))
        rows = wait_lines(home, 1)
        check("래퍼: 기록 한 줄", len(rows) == 1, str(rows))
        if rows:
            row = rows[0]
            check("기록 필드", row["session"] == "s1" and row["model"] == "claude-x" and row["cost_usd"] == 1.5
                  and row["input_tokens"] == 100 and row["output_tokens"] == 20 and "ts" in row, str(row))
            check("사용 한도는 받은 모양 그대로 (다른 윈도우 포함)",
                  row["rate_limits"]["spend_limit"] == {"used_percentage": 3}
                  and row["rate_limits"]["five_hour"] == {"used_percentage": 1, "resets_at": 1795461600}, str(row))


def test_wrapper_survives_record_failure() -> None:
    with tempfile.TemporaryDirectory() as home:
        set_original(home, "printf 'HUD:'; cat")
        with open(ops(home, "metrics"), "w") as f:
            f.write("기록 자리를 파일로 막는다")
        stdin = statusline_input()
        r, _ = wrap(home, stdin)
        check("기록 실패: 출력은 원래대로", r.stdout == "HUD:" + stdin and r.returncode == 0, repr(r.stdout[:80]))
        r, _ = wrap(home, "{깨진 입력")
        check("파싱 실패: 출력은 원래대로", r.stdout == "HUD:{깨진 입력" and r.returncode == 0, repr(r.stdout))
        r = log(home, "record", stdin="{깨진 입력")
        check("record 파싱 실패는 조용히 0", r.returncode == 0 and r.stdout == "" and r.stderr == "", r.stderr)


def test_wrapper_does_not_wait_for_record() -> None:
    with tempfile.TemporaryDirectory() as home:
        set_original(home, "printf 'HUD'")
        slow = os.path.join(home, "bin")
        os.makedirs(slow)
        with open(os.path.join(slow, "python3"), "w") as f:
            f.write("#!/bin/sh\nsleep 3\n")
        os.chmod(os.path.join(slow, "python3"), 0o755)
        r, took = wrap(home, statusline_input(), {"PATH": slow + os.pathsep + os.environ.get("PATH", "")})
        check("기록이 느려도 래퍼는 기다리지 않는다", r.stdout == "HUD" and took < 1.5, f"{took:.2f}s")


def test_wrapper_without_original() -> None:
    with tempfile.TemporaryDirectory() as home:
        r, _ = wrap(home, statusline_input())
        check("원래 상태줄 없음: 빈 출력", r.stdout == "" and r.returncode == 0, repr(r.stdout))
        check("원래 상태줄 없음: 기록은 한다", len(wait_lines(home, 1)) == 1)
        set_original(home, 'bash "$HOME/.claude/ops-agent/current/scripts/usage-statusline.sh"')
        r, _ = wrap(home, statusline_input())
        check("원래 명령이 래퍼 자신이면 부르지 않는다", r.stdout == "" and r.returncode == 0, repr(r.stdout))


def test_record_only_on_change() -> None:
    with tempfile.TemporaryDirectory() as home:
        for stdin in (statusline_input(), statusline_input(), statusline_input(session="s2"),
                      statusline_input(cost=2.0), statusline_input(cost=2.0, five=2), statusline_input(cost=2.0, five=2)):
            log(home, "record", stdin=stdin)
        rows = lines(home)
        check("값이 바뀔 때만 한 줄 (세션별 비교)",
              [(r["session"], r["cost_usd"], r["rate_limits"]["five_hour"]["used_percentage"]) for r in rows]
              == [("s1", 1.5, 1), ("s2", 1.5, 1), ("s1", 2.0, 1), ("s1", 2.0, 2)], str(rows))


def test_install_uninstall() -> None:
    with tempfile.TemporaryDirectory() as home:
        settings = os.path.join(home, ".claude", "settings.json")
        os.makedirs(os.path.dirname(settings))
        original = {"model": "x", "statusLine": {"type": "command", "command": "hud --x 'a b'", "padding": 0}}
        with open(settings, "w") as f:
            json.dump(original, f)
        r = log(home, "install")
        after = json.load(open(settings))
        check("설치: 래퍼로 바꾸고 다른 키는 둔다", "usage-statusline.sh" in after["statusLine"]["command"]
              and after["statusLine"]["padding"] == 0 and after["model"] == "x", r.stdout + r.stderr)
        check("설치: 원래 명령을 보관", open(ops(home, "statusline", "original.cmd")).read() == "hud --x 'a b'")
        log(home, "install")
        check("설치 멱등: 다시 설치해도 원래 명령이 래퍼로 덮이지 않는다",
              open(ops(home, "statusline", "original.cmd")).read() == "hud --x 'a b'" and json.load(open(settings)) == after)
        log(home, "uninstall")
        check("해제: 원복", json.load(open(settings)) == original, open(settings).read())
        r = log(home, "uninstall")
        check("해제 멱등: 래퍼가 아니면 바꾸지 않는다", json.load(open(settings)) == original and r.returncode == 0)
    with tempfile.TemporaryDirectory() as home:
        settings = os.path.join(home, ".claude", "settings.json")
        os.makedirs(os.path.dirname(settings))
        with open(settings, "w") as f:
            json.dump({"model": "x"}, f)
        log(home, "install")
        check("상태줄 없을 때 설치: 래퍼만 두고 원래 명령은 비움",
              "usage-statusline.sh" in json.load(open(settings))["statusLine"]["command"]
              and open(ops(home, "statusline", "original.cmd")).read() == "")
        log(home, "uninstall")
        check("상태줄 없을 때 해제: 키를 지운다", json.load(open(settings)) == {"model": "x"})


def iso(t: float) -> str:
    return datetime.datetime.fromtimestamp(t, datetime.timezone.utc).isoformat(timespec="seconds")


def write_jsonl(path: str, rows: list[dict]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def row(t: float, session: str, cost: float, used: int, reset: int) -> dict:
    return {"ts": iso(t), "session": session, "model": "m", "cost_usd": cost, "input_tokens": cost * 100,
            "output_tokens": cost * 10, "rate_limits": {"five_hour": {"used_percentage": used, "resets_at": reset},
                                                        "seven_day": {"used_percentage": 30, "resets_at": 1900000000}}}


def test_estimate() -> None:
    t0 = time.time() - 20 * 3600
    a, b = int(t0 + 5 * 3600), int(t0 + 10 * 3600)
    with tempfile.TemporaryDirectory() as home:
        write_jsonl(ops(home, "metrics", "usage-statusline.jsonl"), [
            row(t0, "s1", 1.0, 10, a),
            row(t0 + 600, "s1", 3.0, 12, a),          # 증가분 2.0
            row(t0 + 1200, "s1", 0.5, 13, a),         # 줄었다: 재시작, 0 으로 세고 새 기준
            row(t0 + 1800, "s1", 1.5, 14, a),         # 증가분 1.0 (레슨런 처리 구간)
            row(t0 + 2000, "s3", 5.0, 14, a),
            row(t0 + 6 * 3600, "s3", 6.0, 22, b),     # 윈도우를 넘는 증가분은 어느 쪽에도 세지 않는다
            row(t0 + 6 * 3600 + 60, "s2", 1.0, 20, b),
            row(t0 + 7 * 3600, "s2", 3.0, 24, b),     # 증가분 2.0
        ])
        write_jsonl(ops(home, "lessons", "judgments.jsonl"), [
            {"ts": iso(t0 + 900), "transcript": "t1", "cost_usd": 9.0,
             "judge_runs": [{"ts": iso(t0 + 300), "cost_usd": 0.4, "usage": {"input_tokens": 7, "output_tokens": 3,
                                                                              "cache_read_input_tokens": 5}},
                            {"ts": iso(t0 + 900), "cost_usd": 0.6, "usage": {"input_tokens": 1}}]},
            {"ts": iso(t0 + 9 * 3600), "transcript": "t2", "cost_usd": 5.0},   # 관측 구간 밖 판정은 세지 않는다
        ])
        write_jsonl(ops(home, "metrics", "usage-marks.jsonl"), [
            {"ts": iso(t0 + 1500), "session": "s1", "task": "learn", "edge": "start"},
            {"ts": iso(t0 + 1900), "session": "s1", "task": "learn", "edge": "end"},
            {"ts": iso(t0 + 7000), "session": "s2", "task": "learn", "edge": "start"},
        ])
        out = log(home, "estimate").stdout
        check("5시간 윈도우: 증가분 · 재시작 · 판정 비용 · 몫 · 추정 한도",
              "| 4% | 4.00 (3.00 + 1.00) | 1.000 | 2.00 | 50.0% | 2.00% (추정) | 108 · 13 · 5 | 308 · 33 |" in out, out)
        check("5시간 윈도우: 윈도우를 넘는 증가분은 세지 않는다",
              "| 4% | 2.00 (2.00 + 0.00) | 2.000 | 0.00 | 0.0% | 0.00% (추정) |" in out, out)
        check("계수 중앙값 · 변동계수", "5시간 계수 (%/달러) | 중앙값 1.500 · 변동계수 0.47 · 표본 2" in out, out)
        check("닫히지 않은 구간은 세지 않고 수만 낸다", "닫히지 않은 레슨런 처리 구간 | 1" in out, out)
        check("주간 윈도우 행", "## 주간 윈도우" in out and "| 0% | 7.00 (6.00 + 1.00) | - |" in out, out)
        log(home, "estimate", "--write")
        check("--write 는 파일로 낸다", os.path.exists(ops(home, "metrics", "usage-estimate.md")))
    with tempfile.TemporaryDirectory() as home:
        r = log(home, "estimate", "--write")
        check("기록이 없으면 파일을 쓰지 않는다", r.returncode == 0 and not os.path.exists(ops(home, "metrics", "usage-estimate.md")))


def weekly_row(t: float, cost: float, used: int, reset: int) -> dict:
    return {"ts": iso(t), "session": "w", "cost_usd": cost,
            "rate_limits": {"seven_day": {"used_percentage": used, "resets_at": reset}}}


def test_weekly_forecast_and_review_lines() -> None:
    now = time.time()
    start = now - 3 * 86400
    past, future = int(start + 86400), int(now + 2 * 86400)
    with tempfile.TemporaryDirectory() as home:
        h = 3600
        write_jsonl(ops(home, "metrics", "usage-statusline.jsonl"), [
            weekly_row(start, 0.0, 10, past),
            weekly_row(start + h, 1.0, 12, past),
            weekly_row(start + 2 * h, 2.0, 14, past),      # 전반: Δ 4% · 2달러 → 계수 2
            weekly_row(start + 3 * h, 3.5, 17, past),
            weekly_row(start + 4 * h, 5.0, 23, past),      # 후반: 3달러 → 예측 6%, 실측 23 - 14 = 9%
            weekly_row(start + 2 * 86400, 6.0, 5, future),
            weekly_row(start + 2 * 86400 + h, 7.0, 5, future),   # 전반 Δ 0 → 표본 부족
            weekly_row(start + 2 * 86400 + 3 * h, 8.0, 6, future),
        ])
        out = log(home, "estimate").stdout
        label = lambda t: datetime.datetime.fromtimestamp(t).strftime("%m-%d %H:%M")  # noqa: E731
        check("주간 예측 대 실측: 전반 계수 × 후반 달러",
              f"| 주간 예측 대 실측 (초기화 {label(past)}) | 예측 6.0% · 실측 9.0% · 비율 1.50 |" in out, out)
        check("주간 예측 대 실측: 전반 Δ% 0 이면 표본 부족",
              f"| 주간 예측 대 실측 (초기화 {label(future)}) | 표본 부족 |" in out, out)
        day, end = datetime.date.fromtimestamp(start), datetime.date.fromtimestamp(now)
        weekdays = sum(1 for i in range((end - day).days + 1) if (day + datetime.timedelta(days=i)).isoweekday() <= 5)
        check("수집 평일 n일째", f"| 수집 평일 | {weekdays}일째 " in out, out)
        check("첫 주간 초기화: 수집 시작 뒤 첫 초기화와 지남 표시", f"| 첫 주간 초기화 | {label(past)} 지남 |" in out, out)
    with tempfile.TemporaryDirectory() as home:
        write_jsonl(ops(home, "metrics", "usage-statusline.jsonl"), [weekly_row(now - 60, 1.0, 1, future)])
        check("첫 주간 초기화: 아직이면 전", f"| 첫 주간 초기화 | {datetime.datetime.fromtimestamp(future).strftime('%m-%d %H:%M')} 전 |"
              in log(home, "estimate").stdout)


def test_mark() -> None:
    with tempfile.TemporaryDirectory() as home:
        log(home, "mark", "learn", "start", extra={"CLAUDE_CODE_SESSION_ID": "abc"})
        r = log(home, "mark", "learn", "end")
        marks = [json.loads(l) for l in open(ops(home, "metrics", "usage-marks.jsonl"), encoding="utf-8")]
        check("구간 표지: 세션 식별자로 남긴다", [(m["session"], m["task"], m["edge"]) for m in marks] == [("abc", "learn", "start")], str(marks))
        check("세션 식별자 없으면 남기지 않고 0", r.returncode == 0)


def test_weekdays_fixed_dates() -> None:
    """실행 요일과 무관하게 주말을 낀 고정 날짜로 평일 계산을 검사한다."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("usage_log", LOG)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    ts = lambda y, m, d: datetime.datetime(y, m, d, 12).timestamp()  # noqa: E731
    check("평일 계산: 금 → 월 은 2일 (주말 제외)", mod.weekdays_since(ts(2026, 11, 20), ts(2026, 11, 23)) == 2)
    check("평일 계산: 월 → 수 는 3일", mod.weekdays_since(ts(2026, 11, 23), ts(2026, 11, 25)) == 3)


def main() -> int:
    test_wrapper_passes_output()
    test_wrapper_survives_record_failure()
    test_wrapper_does_not_wait_for_record()
    test_wrapper_without_original()
    test_record_only_on_change()
    test_install_uninstall()
    test_estimate()
    test_weekly_forecast_and_review_lines()
    test_weekdays_fixed_dates()
    test_mark()
    print(f"통과 {passed} · 실패 {len(failures)}")
    for f in failures:
        print(f"  실패: {f}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
