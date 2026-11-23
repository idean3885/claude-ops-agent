#!/usr/bin/env python3
"""레슨런 판정을 작업 시간 밖에서 돌리고 정답률을 쌓는다.

    lessons-judge.py spawn                 SessionStart 훅. 판정은 분리 프로세스에 맡기고 바로 끝낸다
    lessons-judge.py worker <paths...>     트랜스크립트를 판정해 judgments.jsonl 에 쌓는다
    lessons-judge.py report [--days N]     정답률 · 원인 · 승인 대기
    lessons-judge.py report --split <시작일>          시범 시작일 전 · 뒤 정답률을 원인별로 비교
    lessons-judge.py report --sessions-from <jsonl> [--days N]  그 지표 파일의 세션들과 나머지의 정답률
    lessons-judge.py samples [--n 5]       사람이 판정할 표본
    lessons-judge.py sample-record <transcript> <answer> <correct|content|level|path>
    lessons-judge.py approve               이번 승인 묶음(등재 후보)을 검토 완료로 바꾼다
    lessons-judge.py wrap                  세션 마무리 훅. 올릴 대기가 있으면 승인 묶음 안내 한 줄 (ADR-0047)
    lessons-judge.py baseline [--sample 20] 기준선 1회: 설치 이전 지난 기록 표본을 판정한다 (다시 실행하지 않는다)
    lessons-judge.py baseline --path [--sample 20]  경로 원인 기준선 1회: 원인 둘 시절에 판정한 세션을 다시 판정한다 (ADR-0043)

설계 원천은 docs/lessons.md 「언제 하는가」 · 「기계가 하는 것과 하지 않는 것」 · 「지표」.
"""

from __future__ import annotations

import datetime
import glob
import re
import json
import os
import random
import subprocess
import sys
import time

QUIET_SECONDS = 30 * 60
WINDOW_DAYS = 14
BATCH = 5
LOCK_STALE_SECONDS = 2 * 60 * 60
NOTICE_DAYS = 7
MAX_FAILS = 3
JUDGE_TIMEOUT = 600
USER_CAP = 1500
ANSWER_CAP = 1200
SAMPLE_GOAL = 50
AGREEMENT_MIN = 0.8      # 사람 표본과의 일치도가 이 값 밑이면 기계 판정 지표를 쓰지 않는다 (ADR-0037)
DAILY_MAX = 10           # 하루 판정 상한. 비용이 사용 한도를 갉아먹지 않게 한다
INPUT_CAP = 150_000      # 판정 입력 글자 상한 (#991 실측: 14만 자 ≈ 0.41달러)
APPROVE_BATCH = 5        # 한 번에 올리고 닫는 등재 후보 수. 세션 마무리 3분 안에 끝나는 양이다 (ADR-0047, 단위는 #1209 부터 후보)
EXPIRE_DAYS = 7          # 이보다 오래된 대기는 만료로 닫는다. 맥락이 사라진 세션은 판정 가치가 낮고, 진짜 교훈은 재발해 다시 올라온다 (ADR-0047)
TAXONOMY = 2             # 원인 갈래 판. 1 = 내용 · 수준 (ADR-0037), 2 = 내용 · 수준 · 경로 (ADR-0043). 판이 다른 행은 경로를 비교하지 않는다
CAUSES = ("content", "level", "path")

PROMPT = """아래는 한 작업 세션의 대화다. A<번호> 는 어시스턴트 답, USER 는 사용자 발화다.
사용자 발화가 직전 답을 바로잡는 경우(사실 · 판단 정정, 같은 것을 다시 물음, 분량 · 단계 · 형식 지적)만 교정으로 센다. 새 지시 · 승인 · 다음 질문은 교정이 아니다.
교정마다 원인을 content(질문에 맞게 답하지 못함), level(정해 둔 수준 · 분량 · 형식에 맞추지 못함), path(불렀어야 할 스킬 · 전문가 · 검증 단계를 부르지 않고 직접 해서 생긴 교정) 중 하나로 분류한다. 사용자 지적이 부르지 않은 스킬 · 전문가 · 단계를 가리키면 path 를 우선한다.
admit: 그 교정에서 남길 것이 등재 조건에 드는지 분류한다. fact(다시 조사하려면 비용이 드는 환경 사실) · procedure(되돌릴 수 없는 작업의 절차) · taste(추측할 수 없는 사용자 취향) · none(그 밖. 판단 · 태도 · 그 자리의 실수).
asset_hint: 그 실수를 막을 수 있던 규칙 · 원칙 · 자산이 대화 안에 언급되었거나 사용자가 「이미 정해 둔 것」이라고 했으면, 대화에 나온 파일 경로나 이름을 그대로 옮긴다(바꿔 부르지 않는다). 없으면 빈 문자열.
JSON 한 줄만 출력: {"answers": <A 개수>, "corrections": [{"answer": "A12", "cause": "content|level|path", "admit": "fact|procedure|taste|none", "why": "<20자>", "asset_hint": ""}]}

"""


def home_dir() -> str:
    return os.path.join(os.path.expanduser("~"), ".claude")


def lessons_dir() -> str:
    path = os.path.join(home_dir(), "ops-agent", "lessons")
    os.makedirs(path, exist_ok=True)
    return path


def work_dir() -> str:
    """판정용 자식 세션의 작업 디렉토리. 이 디렉토리의 기록은 판정 대상에서 뺀다."""
    path = lesson_path("work")
    os.makedirs(path, exist_ok=True)
    return path


def lesson_path(name: str) -> str:
    return os.path.join(lessons_dir(), name)


def load_state() -> dict:
    try:
        with open(lesson_path("state.json"), encoding="utf-8") as f:
            state = json.load(f)
    except (OSError, ValueError):
        state = {}
    state.setdefault("last_scan", 0)
    state.setdefault("judged", {})
    state.setdefault("last_approval", None)
    state.setdefault("fails", {})
    # why: 설치 전 세션까지 판정하면 첫 설치 때 수십 건이 한꺼번에 비용을 쓴다. 설치 시점부터 센다
    state.setdefault("since", time.time())
    return state


def save_state(state: dict) -> None:
    tmp = lesson_path("state.json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False)
    os.replace(tmp, lesson_path("state.json"))


def read_jsonl(path: str) -> list[dict]:
    rows = []
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    continue
    except OSError:
        pass
    return rows


def rewrite_jsonl(path: str, rows: list[dict]) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    os.replace(tmp, path)


def append_jsonl(path: str, row: dict) -> None:
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def today() -> str:
    return datetime.date.today().isoformat()


# --- 추출 ---

def extract(path: str) -> list[tuple[str, str]]:
    """[("USER", 글) | ("A<번호>", 글)] 를 순서대로 돌려준다."""
    items: list[tuple[str, str]] = []
    count = 0
    for row in read_jsonl(path):
        kind = row.get("type")
        content = (row.get("message") or {}).get("content")
        if kind == "user":
            if isinstance(content, str) and content.strip() and not content.lstrip().startswith("<"):
                items.append(("USER", content.strip()[:USER_CAP]))
        elif kind == "assistant" and isinstance(content, list):
            text = "\n".join(
                b.get("text", "") for b in content
                if isinstance(b, dict) and b.get("type") == "text"
            ).strip()
            if text:
                count += 1
                items.append((f"A{count}", text[:ANSWER_CAP]))
    return items


def render(items: list[tuple[str, str]]) -> str:
    return "\n\n".join(f"{label}: {text}" for label, text in items)


def count_answers(items: list[tuple[str, str]]) -> int:
    return sum(1 for label, _ in items if label != "USER")


# --- spawn ---

def pending_count() -> int:
    return sum(1 for r in read_jsonl(lesson_path("judgments.jsonl")) if r.get("status") == "pending")


def open_candidates(row: dict) -> list[dict]:
    """대기 세션에서 아직 사람이 보지 않은 등재 후보. 판정 전 행(admit 없음)도 후보다."""
    return [c for c in row.get("corrections", []) if c.get("admit") != "none" and not c.get("reviewed")]


def batch_candidates(rows: list[dict]) -> list[tuple[dict, dict]]:
    """이번 승인 묶음. 세션이 아니라 등재 후보 APPROVE_BATCH 개를 고른다.
    why: 세션 단위면 교정이 많은 세션 하나가 후보 수십 개를 끌고 와 마무리 3분 안에 못 열고 만료된다 (#1209)
    순서: 같은 자산이 2회 이상 걸린 후보(재발)를 먼저, 그다음 오래된 세션부터"""
    hints: dict[str, int] = {}
    for c in (c for r in rows for c in r.get("corrections", [])):
        h = (c.get("asset_hint") or "").strip()
        if h:
            hints[h] = hints.get(h, 0) + 1
    pool = [(r, c) for r in rows if r.get("status") == "pending" for c in open_candidates(r)]
    pool.sort(key=lambda rc: 0 if hints.get((rc[1].get("asset_hint") or "").strip(), 0) >= 2 else 1)
    return pool[:APPROVE_BATCH]


def pending_candidate_count() -> int:
    rows = [r for r in read_jsonl(lesson_path("judgments.jsonl")) if r.get("status") == "pending"]
    return sum(len(open_candidates(r)) for r in rows)


def days_since(date_text: str) -> float:
    d = datetime.date.fromisoformat(date_text)
    return (datetime.date.today() - d).days


def project_dir_name(path: str) -> str:
    """Claude Code 가 작업 디렉토리를 projects 하위 디렉토리 이름으로 바꾸는 규칙 (영숫자 외는 -)."""
    return re.sub(r"[^A-Za-z0-9]", "-", os.path.abspath(path))


def is_judge_transcript(path: str) -> bool:
    """판정용 자식 세션의 기록인가. 첫 사용자 발화가 판정 프롬프트로 시작하면 그렇다."""
    head = PROMPT.splitlines()[0]
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                if d.get("type") == "user":
                    c = (d.get("message") or {}).get("content")
                    return isinstance(c, str) and c.startswith(head)
    except OSError:
        return False
    return False


def select_targets(state: dict, session_id: str, now: float, baseline: bool = False) -> list[str]:
    pattern = os.path.join(home_dir(), "projects", "*", "*.jsonl")
    # why: 판정용 자식 세션도 기록을 남긴다. 그 기록을 다시 판정하면 판정이 판정을 낳는다
    judge_dir = project_dir_name(lesson_path("work"))
    picked = []
    for path in glob.glob(pattern):
        if os.path.basename(os.path.dirname(path)) == judge_dir:
            continue
        if session_id and os.path.splitext(os.path.basename(path))[0] == session_id:
            continue
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            continue
        if now - mtime < QUIET_SECONDS:
            continue
        if now - mtime > WINDOW_DAYS * 86400:
            continue
        if not baseline and mtime < state["since"]:
            continue
        if state["judged"].get(path) == mtime:
            continue
        if is_judge_transcript(path):
            state["judged"][path] = mtime
            continue
        picked.append((mtime, path))
    picked.sort()
    if baseline:
        return [p for _, p in picked if _ < state["since"]]
    return [p for _, p in picked[:BATCH]]


def lock_active() -> bool:
    try:
        return time.time() - os.path.getmtime(lesson_path("judge.lock")) < LOCK_STALE_SECONDS
    except OSError:
        return False


def acquire_lock() -> bool:
    """판정 · 승인이 같은 파일을 동시에 고치지 않게 잡는다. 만들기와 확인을 한 번에 한다."""
    path = lesson_path("judge.lock")
    if os.path.exists(path) and not lock_active():
        try:
            os.remove(path)
        except OSError:
            pass
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        return False
    os.write(fd, str(os.getpid()).encode())
    os.close(fd)
    return True


def release_lock() -> None:
    try:
        os.remove(lesson_path("judge.lock"))
    except OSError:
        pass


def cmd_spawn() -> None:
    if os.environ.get("OPS_AGENT_LESSONS_JUDGE") or os.environ.get("OPS_AGENT_LESSONS_DISABLE") == "1":
        return
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        data = {}
    session_id = data.get("session_id") or ""
    first = not os.path.exists(lesson_path("state.json"))
    state = load_state()
    if first:
        # why: 설치 시점(since)을 지금 저장하지 않으면 매 실행마다 「지금」이 되어 판정이 영영 시작되지 않는다
        save_state(state)
    now = time.time()
    close_stale()
    targets = select_targets(state, session_id, now)
    if targets and not lock_active():
        log = open(lesson_path("judge.log"), "a", encoding="utf-8")
        env = dict(os.environ)
        env["OPS_AGENT_LESSONS_JUDGE"] = "1"
        subprocess.Popen(
            [sys.executable, os.path.abspath(__file__), "worker", *targets],
            start_new_session=True, stdin=subprocess.DEVNULL, stdout=log, stderr=log, env=env,
        )
        state["last_scan"] = now
        save_state(state)
    pending = pending_count()
    last = state.get("last_approval")
    # why: 첫 승인 전에는 설치 시점부터 기한을 센다. 비어 있다고 바로 기한 경과로 치면 설치 첫 주에 매 세션 고지가 뜬다
    stale = (time.time() - state["since"]) / 86400 > NOTICE_DAYS if last is None else days_since(last) > NOTICE_DAYS
    if pending >= 1 and stale:
        print(json.dumps({"systemMessage": f"레슨런 승인 대기 {pending}건 · 정리: /learn"}, ensure_ascii=False))


# --- worker ---

def log_line(text: str) -> None:
    with open(lesson_path("judge.log"), "a", encoding="utf-8") as f:
        f.write(f"{now_iso()} {text}\n")


def parse_verdict(stdout: str) -> tuple[dict, float]:
    outer = json.loads(stdout)
    cost = float(outer.get("total_cost_usd") or outer.get("cost_usd") or 0)
    body = outer.get("result", outer) if isinstance(outer, dict) else outer
    if isinstance(body, str):
        start, end = body.find("{"), body.rfind("}")
        body = json.loads(body[start:end + 1])
    if not isinstance(body, dict) or not isinstance(body.get("corrections"), list):
        raise ValueError("corrections 없음")
    return body, cost


def judge(text: str) -> tuple[dict, float]:
    claude = os.environ.get("OPS_AGENT_LESSONS_CLAUDE") or "claude"
    proc = subprocess.run(
        [claude, "-p", "--model", "sonnet", "--output-format", "json"],
        input=PROMPT + text, capture_output=True, text=True, timeout=JUDGE_TIMEOUT,
        cwd=work_dir(),
    )
    if proc.returncode != 0:
        raise RuntimeError(f"claude 종료 코드 {proc.returncode}: {proc.stderr[-200:]}")
    return parse_verdict(proc.stdout)


def judge_one(path: str, state: dict) -> None:
    mtime = os.path.getmtime(path)
    items = extract(path)
    # why: 입력 상한으로 잘린 뒤쪽은 판정이 보지 못한다. 분모도 잘린 범위 안의 답만 센다
    text = render(items)[:INPUT_CAP]
    answers = sum(1 for label, _ in items if label != "USER" and f"\n{label}: " in "\n" + text)
    # why: 경로 기준선은 지난 세션을 한 번 다시 보는 일이라, 평소 판정의 공용 상태(판정한 세션 · 실패 횟수)를 바꾸지 않는다
    path_baseline = bool(os.environ.get("OPS_AGENT_LESSONS_PATH_BASELINE"))
    if answers == 0:
        if not path_baseline:
            state["judged"][path] = mtime
        return
    try:
        verdict, cost = judge(text)
    except Exception as e:  # noqa: BLE001 판정 실패는 로그로 남기고 다음에 다시 한다
        if path_baseline:
            log_line(f"경로 기준선 판정 실패 {path}: {e}")
            return
        fails = state["fails"].get(path, 0) + 1
        state["fails"][path] = fails
        log_line(f"판정 실패 {fails}/{MAX_FAILS} {path}: {e}")
        if fails >= MAX_FAILS:
            state["judged"][path] = mtime
            log_line(f"skip {path}")
        return
    corrections = [
        {k: c.get(k, "") for k in ("answer", "cause", "admit", "why", "asset_hint")}
        for c in verdict["corrections"] if isinstance(c, dict)
    ]
    if path_baseline:
        record_path_baseline(path, mtime, answers, corrections, state)
        return
    # why: 쉬었다 이어 쓴 세션은 다시 판정된다. 옛 줄을 남기면 답 수 · 교정 · 승인 대기가 두 번 센다
    out = lesson_path("judgments.jsonl")
    old = read_jsonl(out)
    prev = next((r for r in reversed(old) if r.get("transcript") == path), None)
    rows = [r for r in old if r.get("transcript") != path]
    # why: 이어 쓴 세션을 다시 판정해도 이미 승인한 교정을 다시 올리지 않고, 기간은 처음 판정한 시점의 세션 시각으로 고정한다
    # why: 기각 · 만료로 닫힌 세션도 검토가 끝난 것이다. reviewed 만 보면 그 세션을 다시 판정할 때 옛 교정이 후보로 되살아난다
    closed = bool(prev) and prev.get("status") != "pending"
    seen = {c.get("answer") for c in prev.get("corrections", [])} if closed else set()
    # why: 승인 묶음은 후보 단위로 닫는다. 대기 중에 다시 판정해도 이미 본 후보를 다시 올리지 않는다 (#1209)
    reviewed_before = {c.get("answer") for c in prev.get("corrections", []) if c.get("reviewed")} if prev else set()
    for c in corrections:
        if c.get("answer") in reviewed_before:
            c["reviewed"] = True
    status = "pending" if any(c.get("answer") not in seen for c in corrections) or not closed else prev.get("status", "reviewed")
    first_mtime = (prev.get("first_mtime") or prev.get("mtime")) if prev else mtime
    baseline = bool(os.environ.get("OPS_AGENT_LESSONS_BASELINE"))
    if status == "pending" and not has_candidate(corrections, seen):
        status = "rejected"
    if baseline:
        status = "reviewed"
    rows.append({
        "ts": now_iso(),
        "transcript": path,
        "project": os.path.basename(os.path.dirname(path)),
        "session": os.path.splitext(os.path.basename(path))[0],
        "mtime": mtime,
        "first_mtime": first_mtime,
        "answers": answers,
        "model_answers": verdict.get("answers"),
        "corrections": corrections,
        "cost_usd": cost,
        "status": status,
        "baseline": baseline,
        "taxonomy": TAXONOMY,
    })
    rewrite_jsonl(out, rows)
    state["judged"][path] = mtime
    state["fails"].pop(path, None)
    if os.environ.get("OPS_AGENT_LESSONS_BASELINE") and not state.get("baseline_at"):
        state["baseline_at"] = today()


def has_candidate(corrections: list[dict], seen: set) -> bool:
    """사람에게 올릴 교정이 있는가. 판정 전 행(admit 없음)은 후보로 둔다. 확인 없이 닫지 않는다."""
    return any(c.get("answer") not in seen and c.get("admit") != "none" and not c.get("reviewed") for c in corrections)


def close_stale() -> None:
    """올릴 것이 없는 대기를 닫는다. 교정이 없거나 모두 등재 조건 없음이면 기각, 기한이 지나면 만료.

    판정이 잠금을 쥐고 있으면 이번에는 건너뛴다. 다음 세션 시작이나 보고에서 다시 닫는다.
    """
    if not acquire_lock():
        return
    try:
        path = lesson_path("judgments.jsonl")
        rows = read_jsonl(path)
        cutoff = time.time() - EXPIRE_DAYS * 86400
        changed = False
        for r in rows:
            if r.get("status") != "pending":
                continue
            if not has_candidate(r.get("corrections", []), set()):
                r["status"] = "rejected"
                changed = True
            elif session_time(r) < cutoff:
                r["status"] = "expired"
                changed = True
        if changed:
            rewrite_jsonl(path, rows)
    finally:
        release_lock()


def record_path_baseline(path: str, mtime: float, answers: int, corrections: list[dict], state: dict) -> None:
    """경로 기준선 한 세션. 기존 판정 행은 덮지 않고 경로 교정 수만 path-baseline.jsonl 에 남긴다.
    why: 판정 행을 새 판정으로 덮으면 원인 둘 시절의 내용 · 수준 기준선과 승인 상태까지 바뀐다 (ADR-0043 결정 3)"""
    prev = next((r for r in reversed(read_jsonl(lesson_path("judgments.jsonl"))) if r.get("transcript") == path), None)
    out = lesson_path("path-baseline.jsonl")
    rows = [r for r in read_jsonl(out) if r.get("transcript") != path]
    rows.append({
        "ts": now_iso(),
        "transcript": path,
        "session": os.path.splitext(os.path.basename(path))[0],
        "first_mtime": (prev.get("first_mtime") or prev.get("mtime")) if prev else mtime,
        "answers": answers,
        "taxonomy": TAXONOMY,
        "corrections": [c for c in corrections if c.get("cause") == "path"],
    })
    rewrite_jsonl(out, rows)
    if not state.get("path_baseline_at"):
        state["path_baseline_at"] = today()


def judged_today() -> int:
    day = today()
    # 기준선 판정은 하루 상한과 따로 센다. 경로 기준선은 판정 기록에 쌓이지 않는다 (path-baseline.jsonl)
    return sum(1 for r in read_jsonl(lesson_path("judgments.jsonl"))
               if not r.get("baseline")
               and parse_ts(r["ts"]).astimezone().date().isoformat() == day)


def cmd_baseline(args: list[str]) -> None:
    """기준선 1회: 설치 이전(since 전) 지난 WINDOW_DAYS 일 세션에서 표본을 판정해 기준선으로 둔다.
    why: 기준선을 미래에 쌓으려고 변경 머지를 미루면 이슈가 레거시가 된다. 지난 기록은 파일로 남아 있다"""
    n = option(args, "--sample", 20)
    if "--path" in args:
        cmd_path_baseline(n)
        return
    state = load_state()
    # why: 기준선은 한 번이다. 다시 돌리면 부를 때마다 표본 20개 비용이 든다
    if state.get("baseline_at"):
        print(f"기준선은 {state['baseline_at']} 에 이미 만들었다. 다시 만들지 않는다")
        return
    if lock_active():
        print("판정이 진행 중이다. 끝난 뒤 다시 실행한다")
        return
    targets = select_targets(state, "", time.time(), baseline=True)
    picks = random.sample(targets, min(n, len(targets)))
    if not picks:
        print("기준선 표본 없음: 설치 이전 지난 14일 세션 기록이 없다")
        return
    log = open(lesson_path("judge.log"), "a", encoding="utf-8")
    env = dict(os.environ)
    env["OPS_AGENT_LESSONS_JUDGE"] = "1"
    env["OPS_AGENT_LESSONS_BASELINE"] = "1"
    subprocess.Popen(
        [sys.executable, os.path.abspath(__file__), "worker", *picks],
        start_new_session=True, stdin=subprocess.DEVNULL, stdout=log, stderr=log, env=env,
    )
    print(f"기준선 판정 {len(picks)}세션을 뒤에서 시작했다. 끝나면 report --split <시작일> 로 비교한다")
    # 완료 표시(baseline_at)는 worker 가 기준선 행을 처음 쌓을 때 남긴다. 판정이 모두 실패하면 다시 실행할 수 있다


def cmd_path_baseline(n: int) -> None:
    """경로 원인 기준선 1회 (ADR-0043 결정 3, ADR-0037 결정 5 의 예외).
    why: 원인 둘 시절의 판정에는 「경로」가 없어 경로 원인의 시작 전 구간이 비어 있다. 그 시절에 판정한 세션 중
    기록이 남은 것을 새 갈래로 다시 판정한다. 설치 이전 표본은 이미 판정 기간 밖이라 쓰지 않는다"""
    state = load_state()
    if state.get("path_baseline_at"):
        print(f"경로 기준선은 {state['path_baseline_at']} 에 이미 만들었다. 다시 만들지 않는다")
        return
    if lock_active():
        print("판정이 진행 중이다. 끝난 뒤 다시 실행한다")
        return
    rows = latest_per_transcript(read_jsonl(lesson_path("judgments.jsonl")))
    targets = [r["transcript"] for r in rows
               if r.get("taxonomy", 1) < TAXONOMY and r.get("transcript") and os.path.exists(r["transcript"])]
    picks = random.sample(targets, min(n, len(targets)))
    if not picks:
        print("경로 기준선 표본 없음: 원인 둘 시절에 판정한 세션 기록이 남아 있지 않다")
        return
    log = open(lesson_path("judge.log"), "a", encoding="utf-8")
    env = dict(os.environ)
    env["OPS_AGENT_LESSONS_JUDGE"] = "1"
    env["OPS_AGENT_LESSONS_PATH_BASELINE"] = "1"
    subprocess.Popen(
        [sys.executable, os.path.abspath(__file__), "worker", *picks],
        start_new_session=True, stdin=subprocess.DEVNULL, stdout=log, stderr=log, env=env,
    )
    print(f"경로 기준선 판정 {len(picks)}세션을 뒤에서 시작했다. 끝나면 report --split <시작일> 의 원인 경로 행으로 비교한다")


def cmd_worker(paths: list[str]) -> None:
    if not acquire_lock():
        return
    try:
        for path in paths:
            backfill = os.environ.get("OPS_AGENT_LESSONS_BASELINE") or os.environ.get("OPS_AGENT_LESSONS_PATH_BASELINE")
            if not backfill and judged_today() >= DAILY_MAX:
                log_line(f"하루 상한 {DAILY_MAX}건 도달, 나머지는 다음 실행으로")
                break
            # why: 기준선처럼 길게 돌면 잠금이 낡은 것으로 지워져 판정이 겹칠 수 있다. 건마다 갱신한다
            try:
                os.utime(lesson_path("judge.lock"), None)
            except OSError:
                pass
            state = load_state()
            try:
                judge_one(path, state)
            except Exception as e:  # noqa: BLE001
                log_line(f"오류 {path}: {e}")
            save_state(state)
    finally:
        release_lock()


# --- report / samples / approve ---

def parse_ts(text: str) -> datetime.datetime:
    return datetime.datetime.fromisoformat(text)


def option(args: list[str], name: str, default: int) -> int:
    if name in args:
        return int(args[args.index(name) + 1])
    return default


def session_time(r: dict) -> float:
    """세션이 일어난 시각. 판정 시각(ts)이 아니라 트랜스크립트 수정 시각으로 기간을 나눈다."""
    return float(r.get("first_mtime") or r.get("mtime") or parse_ts(r["ts"]).timestamp())


def accuracy(rows: list[dict], cause: str = "") -> str:
    answers = sum(r.get("answers", 0) for r in rows)
    wrong = sum(1 for r in rows for c in r.get("corrections", []) if not cause or c.get("cause") == cause)
    return f"{(1 - wrong / answers) * 100:.1f}% ({len(rows)}세션 · 답 {answers})" if answers else "-"


def cmd_split(rows: list[dict], start: str) -> None:
    """시범 시작일 전(기준선)과 뒤의 정답률을 원인별로 나란히 낸다."""
    t = datetime.datetime.fromisoformat(start).timestamp()
    before = [r for r in rows if session_time(r) < t]
    after = [r for r in rows if session_time(r) >= t]
    print(f"## 기준선 비교 (시작일 {start})\n")
    print("| 구분 | 기준선 (전) | 시범 (뒤) |\n|---|---|---|")
    # why: 전체(교정 수)는 원인 갈래와 무관하다. 내용 · 수준은 판 2 가 경로를 먼저 갈라 판 1 과 뜻이 달라, 같은 판끼리만 비교한다
    print(f"| 전체 | {accuracy(before)} | {accuracy(after)} |")
    kinds = {r.get("taxonomy", 1) for r in before + after}
    for name, cause in (("원인 내용", "content"), ("원인 수준", "level")):
        if len(kinds) > 1:
            print(f"| {name} | 비교 불가 (판이 섞임: {', '.join(str(k) for k in sorted(kinds))}) | {accuracy(after, cause)} |")
        else:
            print(f"| {name} | {accuracy(before, cause)} | {accuracy(after, cause)} |")
    # why: 원인 둘 시절(판 1) 행은 경로를 분류하지 않았다. 섞으면 경로 교정이 없던 것처럼 정답률이 높게 나온다.
    # 경로 기준선(path-baseline.jsonl)은 판 1 세션을 다시 판정한 경로 수다. 판 2 판정 행이 있는 세션은 그 행을 쓴다
    before2 = [r for r in before if r.get("taxonomy", 1) >= TAXONOMY]
    have = {r.get("transcript") for r in rows if r.get("taxonomy", 1) >= TAXONOMY}
    before2 += [r for r in latest_per_transcript(read_jsonl(lesson_path("path-baseline.jsonl")))
                if r.get("transcript") not in have and session_time(r) < t]
    after2 = [r for r in after if r.get("taxonomy", 1) >= TAXONOMY]
    if not before2:
        print(f"| 원인 경로 | 비교 불가 (경로 기준선 없음: baseline --path 를 한 번 실행) | {accuracy(after2, 'path')} |")
    else:
        print(f"| 원인 경로 | {accuracy(before2, 'path')} | {accuracy(after2, 'path')} |")


def cmd_report(args: list[str]) -> None:
    close_stale()
    rows = latest_per_transcript(read_jsonl(lesson_path("judgments.jsonl")))
    if "--split" in args:
        cmd_split(rows, args[args.index("--split") + 1])
        return
    if "--sessions-from" in args:
        cmd_sessions_from(rows, args[args.index("--sessions-from") + 1], args)
        return
    days = option(args, "--days", 7)
    cutoff = time.time() - days * 86400
    recent = [r for r in rows if session_time(r) >= cutoff]
    samples = read_jsonl(lesson_path("samples.jsonl"))
    answers = sum(r.get("answers", 0) for r in recent)
    corrections = [c for r in recent for c in r.get("corrections", [])]
    rate = f"{(1 - len(corrections) / answers) * 100:.1f}%" if answers else "-"
    by_cause = {k: sum(1 for c in corrections if c.get("cause") == k) for k in CAUSES}
    pending = sum(1 for r in rows if r.get("status") == "pending")
    print(f"## 레슨런 판정 보고 (최근 {days}일)\n")
    print(f"대리 지표 (사람 표본 {len(samples)}/{SAMPLE_GOAL}): 기계 판정 집계다. 표본 일치도와 섞지 않는다.\n")
    print("| 항목 | 값 |\n|---|---|")
    print(f"| 세션 수 | {len(recent)} |")
    print(f"| 답 수 | {answers} |")
    print(f"| 교정 수 | {len(corrections)} |")
    print(f"| 정답률 | {rate} |")
    print(f"| 원인 내용 | {by_cause['content']} |")
    print(f"| 원인 수준 | {by_cause['level']} |")
    print(f"| 원인 경로 | {by_cause['path']} |")
    print(f"| 승인 대기 | {pending}건 |")
    print(f"| 승인 대기 후보 | {sum(len(open_candidates(r)) for r in rows if r.get('status') == 'pending')}개 |")
    print(f"| 자동 기각 | {sum(1 for r in rows if r.get('status') == 'rejected')}건 |")
    print(f"| 기한 만료 | {sum(1 for r in rows if r.get('status') == 'expired')}건 |")
    base = [r for r in rows if r.get("baseline")]
    print(f"| 기준선 | {len(base)}세션{'' if base else ' (없음: baseline 을 한 번 실행)'} |")
    hints: dict[str, int] = {}
    # why: 자산 무시는 기간과 무관하게 같은 자산에서 2회면 후보다
    for c in (c for r in rows for c in r.get("corrections", [])):
        h = (c.get("asset_hint") or "").strip()
        if h:
            hints[h] = hints.get(h, 0) + 1
    if hints:
        print("\n자산이 있었는데 틀린 답 (2회 이상은 도구 경계 로드 구조 수정 후보)\n")
        print("| 자산 | 횟수 | 후보 |\n|---|---|---|")
        for h, n in sorted(hints.items(), key=lambda x: -x[1]):
            print(f"| {h} | {n} | {'예' if n >= 2 else ''} |")
    if samples:
        agree = sum(1 for s in samples if s.get("human") == s.get("machine"))
        ratio = agree / len(samples)
        verdict = "" if len(samples) < SAMPLE_GOAL else (" · 기준 충족" if ratio >= AGREEMENT_MIN else " · 기준 미달: 사람 표본 주기 점검으로 전환")
        print(f"\n표본 일치도: {agree}/{len(samples)} ({ratio * 100:.0f}%, 기준 {AGREEMENT_MIN * 100:.0f}%){verdict}")
    waiting = batch_candidates(rows)
    if waiting:
        print(f"\n이번 승인 묶음 (후보 {len(waiting)}개, approve 가 이 후보만 닫는다)\n")
        for r, c in waiting:
            hint = (c.get("asset_hint") or "").strip()
            recur = " · 재발" if hint and hints.get(hint, 0) >= 2 else ""
            print(f"- {r['transcript']} {c.get('answer', '')} · 원인 {c.get('cause', '')} · 등재 조건 {c.get('admit') or '미판정'}"
                  f" · {c.get('why', '')}{' · 자산 ' + hint if hint else ''}{recur}")


def cmd_sessions_from(rows: list[dict], source: str, args: list[str]) -> None:
    """지표 파일(문구 감지 등)에 세션 식별자가 남은 세션의 정답률을 나머지와 나란히 낸다.
    why: 문구 감지 지표는 발동 수만 센다. 발동한 세션의 결과가 나았는지는 이 비교로 본다"""
    sessions, missing = set(), 0
    for r in read_jsonl(source):
        if r.get("session"):
            sessions.add(str(r["session"]))
        else:
            missing += 1
    if "--days" in args:
        cutoff = time.time() - option(args, "--days", 7) * 86400
        rows = [r for r in rows if session_time(r) >= cutoff]
    inside = [r for r in rows if r.get("session") in sessions]
    rest = [r for r in rows if r.get("session") not in sessions]
    print(f"## 세션 집합 정답률 ({os.path.basename(source)})\n")
    print("| 구분 | 정답률 |\n|---|---|")
    print(f"| 세션 집합 | {accuracy(inside)} |")
    print(f"| 나머지 | {accuracy(rest)} |")
    if missing:
        print(f"\n세션 식별자 없는 줄 {missing}: 식별자를 남기기 전 기록이라 어느 쪽에도 넣지 않았다")


def latest_per_transcript(rows: list[dict]) -> list[dict]:
    last: dict[str, dict] = {}
    for r in rows:
        last[r.get("transcript", "")] = r
    return list(last.values())


def machine_label(row: dict, answer: str) -> str:
    for c in row.get("corrections", []):
        if c.get("answer") == answer:
            return c.get("cause", "content")
    return "correct"


def excerpt(items: list[tuple[str, str]], label: str) -> tuple[str, str, str]:
    for i, (lab, text) in enumerate(items):
        if lab == label:
            prev = next((t for l, t in reversed(items[:i]) if l == "USER"), "")
            nxt = next((t for l, t in items[i + 1:] if l == "USER"), "")
            return prev, text, nxt
    return "", "", ""


def cmd_samples(args: list[str]) -> None:
    n = option(args, "--n", 5)
    rows = read_jsonl(lesson_path("judgments.jsonl"))[-50:]
    plain, flagged = [], []
    for r in rows:
        marked = {c.get("answer") for c in r.get("corrections", [])}
        for i in range(1, r.get("answers", 0) + 1):
            (flagged if f"A{i}" in marked else plain).append((r, f"A{i}"))
    want_flagged = min(len(flagged), max(1, n // 5)) if n > 1 else 0
    picks = random.sample(plain, min(len(plain), n - want_flagged)) + random.sample(flagged, want_flagged)
    for r, label in picks:
        prev, answer, nxt = excerpt(extract(r["transcript"]), label)
        print(f"### {r['transcript']} {label}\n직전 사용자: {prev[:300]}\n답: {answer[:500]}\n다음 사용자: {nxt[:300]}")
        print(f"기록: sample-record {r['transcript']} {label} <correct|content|level|path>\n")


def cmd_sample_record(args: list[str]) -> None:
    transcript, answer, human = args[:3]
    if human not in ("correct", *CAUSES):
        raise SystemExit("판정은 correct|content|level|path 중 하나")
    rows = [r for r in read_jsonl(lesson_path("judgments.jsonl")) if r.get("transcript") == transcript]
    if not rows:
        raise SystemExit("판정 기록에 없는 트랜스크립트")
    append_jsonl(lesson_path("samples.jsonl"), {
        "ts": now_iso(), "transcript": transcript, "answer": answer,
        "human": human, "machine": machine_label(rows[-1], answer),
    })


def cmd_approve() -> None:
    """report 가 보인 승인 묶음(등재 후보 APPROVE_BATCH 개)만 닫는다. 보이지 않은 후보는 남긴다.
    세션은 남은 후보가 없을 때 검토 완료가 된다 (#1209)"""
    if not acquire_lock():
        raise SystemExit("판정이 진행 중이다. 잠시 뒤 다시 실행한다")
    try:
        path = lesson_path("judgments.jsonl")
        rows = latest_per_transcript(read_jsonl(path))
        for _, c in batch_candidates(rows):
            c["reviewed"] = True
        for r in rows:
            if r.get("status") == "pending" and not open_candidates(r):
                r["status"] = "reviewed"
        rewrite_jsonl(path, rows)
        state = load_state()
        state["last_approval"] = today()
        save_state(state)
    finally:
        release_lock()


def cmd_wrap() -> None:
    """세션 마무리 훅이 부른다. 올릴 대기가 있을 때만 승인 묶음 안내 한 줄을 낸다 (ADR-0047)."""
    close_stale()
    pending = pending_count()
    cands = pending_candidate_count()
    if pending:
        print(f"레슨 승인 대기 {pending}건 · 후보 {cands}개: 판결 전에 /learn 으로 승인 묶음 후보 {min(cands, APPROVE_BATCH)}개만 연다. "
              f"3분 상한이고, 남은 건은 다음 마무리로 넘긴다. {EXPIRE_DAYS}일이 지난 대기는 만료로 닫힌다.")


def main(argv: list[str]) -> int:
    cmd, args = (argv[1] if len(argv) > 1 else ""), argv[2:]
    if cmd == "spawn":
        try:
            cmd_spawn()
        except Exception:  # noqa: BLE001 세션 시작을 막지 않는다
            pass
        return 0
    handlers = {
        "worker": lambda: cmd_worker(args),
        "report": lambda: cmd_report(args),
        "samples": lambda: cmd_samples(args),
        "sample-record": lambda: cmd_sample_record(args),
        "approve": cmd_approve,
        "wrap": cmd_wrap,
        "baseline": lambda: cmd_baseline(args),
    }
    if cmd not in handlers:
        print(__doc__)
        return 2
    handlers[cmd]()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
