#!/usr/bin/env python3
"""모델 사용량을 쓰는 작업의 비용을 한도 대비 % · 토큰 · 달러로 모으고 역산한다 (#1242).

    usage-log.py record                    상태줄 래퍼가 부른다. stdin 은 상태줄 입력. 세션의 값이 바뀌었을 때만 한 줄 덧붙인다
    usage-log.py mark <작업> <start|end>     대화형 작업 구간 표지. 세션은 CLAUDE_CODE_SESSION_ID
    usage-log.py estimate [--write]        윈도우별 역산을 낸다. --write 면 metrics/usage-estimate.md 에 쓴다
    usage-log.py install                   상태줄 명령을 래퍼로 감싼다. 이미 감쌌으면 그대로 둔다
    usage-log.py uninstall                 감싸기 전 상태줄로 되돌린다

설계 원천은 docs/hooks-config.md 「사용량 지표」와 docs/working-principles.md 「메트릭 수집은 자기 비용을 함께 수집한다」.
모델을 부르지 않는다. record 는 어떤 실패에서도 조용히 끝난다.
"""

from __future__ import annotations

import datetime
import glob
import json
import os
import re
import statistics
import sys
import time

WRAPPER_NAME = "usage-statusline.sh"
WRAPPER_COMMAND = 'bash "$HOME/.claude/ops-agent/current/scripts/usage-statusline.sh"'
SESSION_PATTERN = re.compile(r"[A-Za-z0-9_-]{1,128}")
LAST_KEEP_DAYS = 14      # 세션별 마지막 값 캐시를 지우는 나이. 이보다 오래 쉰 세션은 다시 첫 줄부터 센다
WINDOWS = (("five_hour", "5시간"), ("seven_day", "주간"))
JUDGE_TOKEN_KEYS = ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")


def ops_dir() -> str:
    return os.path.join(os.path.expanduser("~"), ".claude", "ops-agent")


def ops_path(*parts: str) -> str:
    return os.path.join(ops_dir(), *parts)


def settings_path() -> str:
    base = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
    return os.path.join(base, "settings.json")


def now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def read_jsonl(path: str) -> list[dict]:
    rows = []
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if isinstance(row, dict):
                    rows.append(row)
    except OSError:
        pass
    return rows


def append_jsonl(path: str, row: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def write_atomic(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


# --- record ---

def snapshot(data: dict) -> dict:
    """상태줄 입력에서 남길 값. 사용 한도 값은 받은 모양 그대로 둔다 (다른 윈도우 · 모델별 한도 포함)."""
    cost = data.get("cost") if isinstance(data.get("cost"), dict) else {}
    window = data.get("context_window") if isinstance(data.get("context_window"), dict) else {}
    model = data.get("model") if isinstance(data.get("model"), dict) else {}
    row = {
        "model": model.get("id"),
        "cost_usd": cost.get("total_cost_usd"),
        "input_tokens": window.get("total_input_tokens"),
        "output_tokens": window.get("total_output_tokens"),
        "rate_limits": data.get("rate_limits"),
    }
    for key, value in data.items():
        if key != "rate_limits" and ("model_scoped" in key or key.endswith("rate_limits")):
            row[key] = value
    return row


def cmd_record() -> None:
    data = json.loads(sys.stdin.read())
    session = str(data.get("session_id") or "")
    if not SESSION_PATTERN.fullmatch(session):
        return
    row = snapshot(data)
    key = json.dumps(row, sort_keys=True, ensure_ascii=False)
    last = ops_path(".cache", "usage-last", f"{session}.json")
    try:
        with open(last, encoding="utf-8") as f:
            if f.read() == key:
                return
    except OSError:
        pass
    append_jsonl(ops_path("metrics", "usage-statusline.jsonl"), {"ts": now_iso(), "session": session, **row})
    write_atomic(last, key)


# --- mark ---

def cmd_mark(args: list[str]) -> int:
    if len(args) != 2 or args[1] not in ("start", "end"):
        print("사용법: usage-log.py mark <작업> <start|end>", file=sys.stderr)
        return 2
    session = os.environ.get("CLAUDE_CODE_SESSION_ID", "")
    if not session:
        print("세션 식별자(CLAUDE_CODE_SESSION_ID)가 없어 구간을 남기지 않았다", file=sys.stderr)
        return 0
    append_jsonl(ops_path("metrics", "usage-marks.jsonl"),
                 {"ts": now_iso(), "session": session, "task": args[0], "edge": args[1]})
    return 0


# --- estimate ---

def epoch(ts) -> float | None:
    try:
        return datetime.datetime.fromisoformat(str(ts)).timestamp()
    except ValueError:
        return None


def number(value) -> float:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0.0


def window_of(row: dict, name: str) -> tuple[int | None, float | None]:
    limits = row.get("rate_limits") if isinstance(row.get("rate_limits"), dict) else {}
    w = limits.get(name) if isinstance(limits.get(name), dict) else {}
    reset, used = w.get("resets_at"), w.get("used_percentage")
    if not isinstance(reset, (int, float)) or isinstance(reset, bool):
        return None, None
    return int(reset), (float(used) if isinstance(used, (int, float)) and not isinstance(used, bool) else None)


def increments(rows: list[dict]) -> list[dict]:
    """세션별 앞뒤 두 줄의 증가분. 누적값이 줄면 재시작으로 보고 그 값을 새 기준으로 삼는다(그 걸음은 0).
    세션의 첫 줄도 기준만 잡는다. 기록 전에 쌓인 값을 이번 구간의 사용으로 세지 않기 위해서다."""
    prev: dict[str, dict] = {}
    out = []
    for row in rows:
        session = row.get("session")
        t = epoch(row.get("ts"))
        if not session or t is None:
            continue
        before = prev.get(session)
        prev[session] = row
        if before is None:
            continue
        step = {"session": session, "ts": t, "prev_ts": epoch(before.get("ts"))}
        for field in ("cost_usd", "input_tokens", "output_tokens"):
            a, b = number(before.get(field)), number(row.get(field))
            step[field] = b - a if b >= a else 0.0
        for name, _ in WINDOWS:
            step[name] = (window_of(before, name)[0], window_of(row, name)[0])
        out.append(step)
    return out


def intervals(marks: list[dict], task: str) -> tuple[list[tuple[str, float, float]], int]:
    """작업 구간 (세션, 시작, 끝). 끝이 없는 시작은 구간으로 세지 않고 수만 돌려준다."""
    open_at: dict[str, float] = {}
    spans, unclosed = [], 0
    for m in marks:
        if m.get("task") != task:
            continue
        t = epoch(m.get("ts"))
        session = m.get("session")
        if t is None or not session:
            continue
        if m.get("edge") == "start":
            if session in open_at:
                unclosed += 1
            open_at[session] = t
        elif m.get("edge") == "end" and session in open_at:
            spans.append((session, open_at.pop(session), t))
    return spans, unclosed + len(open_at)


def judge_runs(rows: list[dict]) -> list[dict]:
    """레슨런 판정 실행마다 (시각, 비용, 토큰). 같은 세션을 다시 판정하면 옛 실행은 judge_runs 로 이어진다."""
    last: dict[str, dict] = {}
    for r in rows:
        last[str(r.get("transcript", ""))] = r
    runs = []
    for r in last.values():
        history = r.get("judge_runs")
        if not isinstance(history, list):
            history = [{"ts": r.get("ts"), "cost_usd": r.get("cost_usd"), "usage": r.get("usage")}]
        for run in history:
            t = epoch(run.get("ts")) if isinstance(run, dict) else None
            if t is None:
                continue
            usage = run.get("usage") if isinstance(run.get("usage"), dict) else {}
            runs.append({"ts": t, "cost_usd": number(run.get("cost_usd")),
                         **{k: number(usage.get(k)) for k in JUDGE_TOKEN_KEYS}})
    return runs


def in_spans(step: dict, spans: list[tuple[str, float, float]]) -> bool:
    return any(s == step["session"] and start < step["ts"] <= end for s, start, end in spans)


def windows(rows: list[dict], steps: list[dict], runs: list[dict], spans: list, name: str) -> list[dict]:
    """윈도우(resets_at)마다 표본. 사용률 변화는 그 윈도우에서 관측한 최대 - 최소,
    비용은 앞뒤 두 줄이 모두 그 윈도우에 든 증가분 합에 관측 구간 안의 판정 비용을 더한다."""
    seen: dict[int, dict] = {}
    for row in rows:
        reset, used = window_of(row, name)
        t = epoch(row.get("ts"))
        if reset is None or t is None:
            continue
        w = seen.setdefault(reset, {"reset": reset, "first": t, "last": t, "used": []})
        w["first"], w["last"] = min(w["first"], t), max(w["last"], t)
        if used is not None:
            w["used"].append(used)
    out = []
    for reset in sorted(seen):
        w = seen[reset]
        inside = [s for s in steps if s[name] == (reset, reset)]
        learn = [s for s in inside if in_spans(s, spans)]
        judged = [r for r in runs if w["first"] <= r["ts"] <= w["last"]]
        status_cost = sum(s["cost_usd"] for s in inside)
        judge_cost = sum(r["cost_usd"] for r in judged)
        learn_cost = sum(s["cost_usd"] for s in learn)
        total = status_cost + judge_cost
        delta = (max(w["used"]) - min(w["used"])) if w["used"] else 0.0
        lesson = judge_cost + learn_cost
        share = lesson / total if total > 0 else None
        out.append({
            "reset": reset, "delta": delta, "status_cost": status_cost, "judge_cost": judge_cost,
            "total": total, "lesson": lesson, "share": share,
            "coef": delta / total if total > 0 and delta > 0 else None,
            "estimate": share * delta if share is not None else None,
            "lesson_tokens": {
                "input": sum(r["input_tokens"] for r in judged) + sum(s["input_tokens"] for s in learn),
                "output": sum(r["output_tokens"] for r in judged) + sum(s["output_tokens"] for s in learn),
                "cache": sum(r["cache_creation_input_tokens"] + r["cache_read_input_tokens"] for r in judged),
            },
            "total_tokens": {
                "input": sum(s["input_tokens"] for s in inside) + sum(r["input_tokens"] for r in judged),
                "output": sum(s["output_tokens"] for s in inside) + sum(r["output_tokens"] for r in judged),
            },
        })
    return out


def forecast(rows: list[dict], steps: list[dict], runs: list[dict], name: str, reset: int) -> dict | None:
    """주간 예측 대 실측. 관측 구간을 시각으로 반으로 나눠 전반 계수(%/달러)에 후반 달러를 곱한 예측 Δ% 를
    후반 실측 Δ%(후반 최대 - 전반 최대)와 대조한다. 같은 표본으로 잡은 계수를 같은 표본에 쓰면 예측이 늘 맞으므로 나눈다.
    전반 Δ% · 달러가 0 이거나 후반 관측이 없으면 None(표본 부족)."""
    seen = [(epoch(r.get("ts")), window_of(r, name)) for r in rows]
    seen = [(t, used) for t, (w, used) in seen if t is not None and w == reset and used is not None]
    if not seen:
        return None
    first, last = min(t for t, _ in seen), max(t for t, _ in seen)
    mid = (first + last) / 2
    early = [u for t, u in seen if t <= mid]
    late = [u for t, u in seen if t > mid]
    inside = [s for s in steps if s[name] == (reset, reset)]
    early_cost = sum(s["cost_usd"] for s in inside if s["ts"] <= mid) + sum(r["cost_usd"] for r in runs if first <= r["ts"] <= mid)
    late_cost = sum(s["cost_usd"] for s in inside if s["ts"] > mid) + sum(r["cost_usd"] for r in runs if mid < r["ts"] <= last)
    early_delta = max(early) - min(early)
    if not late or early_delta <= 0 or early_cost <= 0:
        return None
    predicted = early_delta / early_cost * late_cost
    actual = max(late) - max(early)
    return {"predicted": predicted, "actual": actual, "ratio": actual / predicted if predicted > 0 else None}


def spread(values: list[float]) -> tuple[float | None, float | None]:
    """중앙값과 변동계수(표본 표준편차 / 평균). 표본이 둘 밑이면 변동계수는 없다."""
    if not values:
        return None, None
    median = statistics.median(values)
    if len(values) < 2:
        return median, None
    mean = statistics.mean(values)
    return median, (statistics.stdev(values) / mean if mean else None)


def weekdays_since(start: float, now: float) -> int:
    day = datetime.date.fromtimestamp(start)
    end = datetime.date.fromtimestamp(now)
    count = 0
    while day <= end:
        if day.weekday() < 5:
            count += 1
        day += datetime.timedelta(days=1)
    return count


def local(t: float) -> str:
    return datetime.datetime.fromtimestamp(t).strftime("%m-%d %H:%M")


def fmt(value, pattern: str) -> str:
    return "-" if value is None else pattern.format(value)


def render(now: float) -> str | None:
    rows = read_jsonl(ops_path("metrics", "usage-statusline.jsonl"))
    times = [t for t in (epoch(r.get("ts")) for r in rows) if t is not None]
    if not times:
        return None
    steps = increments(rows)
    runs = judge_runs(read_jsonl(ops_path("lessons", "judgments.jsonl")))
    spans, unclosed = intervals(read_jsonl(ops_path("metrics", "usage-marks.jsonl")), "learn")
    start = min(times)
    weekly_resets = sorted({w for w in (window_of(r, "seven_day")[0] for r in rows) if w is not None})
    first_weekly = next((w for w in weekly_resets if w > start), None)
    lines = [
        f"# 사용량 역산 ({datetime.datetime.fromtimestamp(now).strftime('%Y-%m-%d %H:%M')} 생성)",
        "",
        "몫은 이 기기 기록에서 낸 정확값이다. 한도 % 는 계정 전체 사용률에서 역산한 추정값이다 (이 기기 밖 사용 · 정수 해상도).",
        "",
        "## 재판단 자리",
        "",
        "| 항목 | 값 |",
        "|---|---|",
        f"| 수집 시작 | {datetime.datetime.fromtimestamp(start).strftime('%Y-%m-%d %H:%M')} |",
        f"| 수집 평일 | {weekdays_since(start, now)}일째 (3일째부터 5시간 계수의 흩어짐으로 % 환산 유지 · 폐기를 판정) |",
        f"| 첫 주간 초기화 | {local(first_weekly) + (' 지남' if now >= first_weekly else ' 전') if first_weekly else '-'} |",
    ]
    for name, label in WINDOWS:
        samples = windows(rows, steps, runs, spans, name)
        median, cv = spread([s["coef"] for s in samples if s["coef"] is not None])
        lines.append(f"| {label} 계수 (%/달러) | 중앙값 {fmt(median, '{:.3f}')} · 변동계수 {fmt(cv, '{:.2f}')} · 표본 {sum(1 for s in samples if s['coef'] is not None)} |")
    for reset in weekly_resets:
        f = forecast(rows, steps, runs, "seven_day", reset)
        value = "표본 부족" if f is None else (
            f"예측 {f['predicted']:.1f}% · 실측 {f['actual']:.1f}% · 비율 {fmt(f['ratio'], '{:.2f}')}")
        lines.append(f"| 주간 예측 대 실측 (초기화 {local(reset)}) | {value} |")
    if unclosed:
        lines.append(f"| 닫히지 않은 레슨런 처리 구간 | {unclosed} (끝 표지가 없어 세지 않았다) |")
    for name, label in WINDOWS:
        samples = windows(rows, steps, runs, spans, name)
        lines += [
            "",
            f"## {label} 윈도우",
            "",
            "| 초기화 | Δ사용률 | 전체 달러 (상태줄 + 판정) | 계수 %/달러 | 레슨런 달러 | 레슨런 몫 | 레슨런 추정 한도 % | 레슨런 토큰 (입력 · 출력 · 캐시) | 전체 토큰 (입력 · 출력) |",
            "|---|---|---|---|---|---|---|---|---|",
        ]
        for s in samples:
            lt, tt = s["lesson_tokens"], s["total_tokens"]
            lines.append(
                f"| {local(s['reset'])} | {s['delta']:.0f}% | {s['total']:.2f} ({s['status_cost']:.2f} + {s['judge_cost']:.2f}) | "
                f"{fmt(s['coef'], '{:.3f}')} | {s['lesson']:.2f} | {fmt(None if s['share'] is None else s['share'] * 100, '{:.1f}%')} | "
                f"{fmt(s['estimate'], '{:.2f}% (추정)')} | {lt['input']:.0f} · {lt['output']:.0f} · {lt['cache']:.0f} | {tt['input']:.0f} · {tt['output']:.0f} |")
    return "\n".join(lines) + "\n"


def prune_last(now: float) -> None:
    for path in glob.glob(ops_path(".cache", "usage-last", "*.json")):
        try:
            if now - os.path.getmtime(path) > LAST_KEEP_DAYS * 86400:
                os.remove(path)
        except OSError:
            pass


def cmd_estimate(args: list[str]) -> int:
    now = time.time()
    text = render(now)
    if "--write" in args:
        prune_last(now)
        if text:
            write_atomic(ops_path("metrics", "usage-estimate.md"), text)
        return 0
    print(text or "상태줄 기록 없음: usage-log.py install 로 수집을 켠다")
    return 0


# --- install / uninstall ---

def load_settings() -> dict:
    try:
        with open(settings_path(), encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def save_settings(settings: dict) -> None:
    write_atomic(settings_path(), json.dumps(settings, ensure_ascii=False, indent=2) + "\n")


def is_wrapper(status_line) -> bool:
    return isinstance(status_line, dict) and WRAPPER_NAME in str(status_line.get("command", ""))


def cmd_install() -> int:
    settings = load_settings()
    current = settings.get("statusLine")
    if is_wrapper(current):
        print("이미 감쌌다. 바꾸지 않는다")
        return 0
    command = current.get("command", "") if isinstance(current, dict) else ""
    write_atomic(ops_path("statusline", "original.json"), json.dumps({"statusLine": current}, ensure_ascii=False) + "\n")
    write_atomic(ops_path("statusline", "original.cmd"), str(command))
    wrapped = dict(current) if isinstance(current, dict) else {}
    wrapped["type"] = "command"
    wrapped["command"] = WRAPPER_COMMAND
    settings["statusLine"] = wrapped
    save_settings(settings)
    print(f"상태줄을 감쌌다. 원래 명령: {'있음' if command else '없음 (기록만 하고 빈 출력)'} · 되돌리기: usage-log.py uninstall")
    return 0


def cmd_uninstall() -> int:
    settings = load_settings()
    if not is_wrapper(settings.get("statusLine")):
        print("상태줄이 래퍼가 아니다. 바꾸지 않는다")
        return 0
    try:
        with open(ops_path("statusline", "original.json"), encoding="utf-8") as f:
            original = json.load(f).get("statusLine")
    except (OSError, ValueError):
        print("보관한 원래 상태줄이 없다. 설정을 바꾸지 않는다", file=sys.stderr)
        return 1
    if original is None:
        settings.pop("statusLine", None)
    else:
        settings["statusLine"] = original
    save_settings(settings)
    for name in ("original.json", "original.cmd"):
        try:
            os.remove(ops_path("statusline", name))
        except OSError:
            pass
    print("상태줄을 되돌렸다")
    return 0


def main(argv: list[str]) -> int:
    cmd, args = (argv[1] if len(argv) > 1 else ""), argv[2:]
    if cmd == "record":
        try:
            cmd_record()
        except Exception:  # noqa: BLE001 상태줄 기록은 어떤 실패도 작업 흐름에 올리지 않는다
            pass
        return 0
    handlers = {
        "mark": lambda: cmd_mark(args),
        "estimate": lambda: cmd_estimate(args),
        "install": cmd_install,
        "uninstall": cmd_uninstall,
    }
    if cmd not in handlers:
        print(__doc__)
        return 2
    return handlers[cmd]()


if __name__ == "__main__":
    sys.exit(main(sys.argv))
