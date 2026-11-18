#!/usr/bin/env python3
"""응답 언어 훅 자체 점검 (#792, #1080).

훅을 실제 진입점(표준 입력 JSON → 표준 출력)으로 실행해, 알려야 하는 턴과 통과해야 하는 턴을 고정한다.
Stop 은 막지 않고 사용자 안내만 낸다. PostToolUse 는 답변을 만드는 중에 모델에 알린다.

    python3 scripts/selftest-response-language.py [훅 경로]
    python3 scripts/selftest-response-language.py --mutants

훅 경로를 주면 그 파일을 시험한다. 고치기 전 훅으로 실패하는지 볼 때 쓴다.
--mutants 는 훅의 기준값 · 목록 · 제외 패턴 · 판정 분기를 하나씩 되돌린 변형 훅을 만들어, 변형마다 사례가 실패하는지 본다.
실패하지 않는 변형(살아남은 변형)이 있으면 그 동작을 고정하는 사례가 없는 것이다 (#1076).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MUTANTS = "--mutants" in sys.argv
ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
HOOK = ARGS[0] if ARGS else os.path.join(ROOT, "hooks", "response-language.py")

KO_PROMPT = "앱키 재발급 로직을 확인해 주세요. 스키마에서 행을 유지하는 게 맞습니까?"
EN_PROMPT = "Please check the appkey reissue logic and tell me if keeping the row is right."
KO_REPLY = "네, 행은 유지하고 앱키만 바꾸는 게 맞습니다. 스키마가 그렇게 설계되어 있고 코드도 그대로 구현되어 있습니다."
EN_REPLY = "Yes, keeping the row and updating only the appkey is correct. The schema is designed that way."
PROGRESS_EN = "Let me check the schema and the recorder first."
KO_WITH_CODE = (
    "PR #435 를 초안으로 만들었습니다. `ProductActivationEntity` 에 이력 대상을 지정했습니다.\n"
    "```sql\nCREATE TABLE product_activation_aud (activation_id BINARY(16) NOT NULL, rev BIGINT NOT NULL)\n```\n"
    "경로는 product-activation/adapter/src/main/java/com/example/Entity.java 입니다."
)


def user(text: str, **extra) -> dict:
    return {"type": "user", "message": {"role": "user", "content": text}, **extra}


def tool_result() -> dict:
    return {"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "t1", "content": "BUILD SUCCESSFUL in 8s"}]}}


def assistant(*texts: str) -> dict:
    return {"type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "text", "text": t} for t in texts]}}


def tool_use(*ids: str) -> dict:
    return {"type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "tool_use", "id": i, "name": "Bash", "input": {"command": "ls"}} for i in (ids or ("t1",))]}}


def run(entries: list[dict], hook: str | None = None, **payload) -> dict | None:
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False, encoding="utf-8") as f:
        for e in entries:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")
        path = f.name
    try:
        body = {"hook_event_name": "Stop", "transcript_path": path, "stop_hook_active": False}
        body.update(payload)
        out = subprocess.run([sys.executable, hook or HOOK], input=json.dumps(body), capture_output=True,
                             text=True, timeout=10)
        if out.returncode != 0:
            raise RuntimeError(f"훅 종료 코드 {out.returncode}: {out.stderr}")
        return json.loads(out.stdout) if out.stdout.strip() else None
    finally:
        os.unlink(path)


CASES = [
    ("한국어 대화 · 마지막 문단 영어 → 알린다",
     [user(KO_PROMPT), tool_use(), tool_result(), assistant(EN_REPLY)], {}, "warn"),
    ("도구 호출 전 영어 진행 문장 · 한국어 답변 → 턴 끝에서 알리지 않는다",
     [user(KO_PROMPT), assistant("Let me check the schema and the recorder first."), tool_use(), tool_result(),
      assistant(KO_REPLY)], {}, None),
    ("한국어 대화 · 식별자 · 코드 · 경로가 섞인 한국어 → 통과",
     [user(KO_PROMPT), tool_use(), tool_result(), assistant(KO_WITH_CODE)], {}, None),
    ("한국어 대화 · 한국어 응답 → 통과",
     [user(KO_PROMPT), tool_use(), tool_result(), assistant(KO_REPLY)], {}, None),
    ("영어 대화 · 영어 응답 → 통과",
     [user(EN_PROMPT), assistant(EN_REPLY)], {}, None),
    ("다른 Stop 훅이 막아 이어 쓴 턴은 다시 알리지 않는다",
     [user(KO_PROMPT), assistant(EN_REPLY)], {"stop_hook_active": True}, None),
    ("작업 알림 뒤 영어 응답 → 대화 언어는 앞의 사람 입력으로 재서 막는다",
     [user(KO_PROMPT), assistant(KO_REPLY),
      user("<task-notification>\n<status>completed</status>\n<summary>Background build finished</summary>",
           origin={"kind": "task-notification"}),
      assistant(EN_REPLY)], {}, "warn"),
    ("명령만 친 입력 뒤 영어 응답 → 앞의 한국어 입력으로 재서 막는다",
     [user(KO_PROMPT), assistant(KO_REPLY), user("!bash ~/scripts/open-gate.sh on git-force"),
      assistant(EN_REPLY)], {}, "warn"),
    ("짧은 영어 한 줄(글자 수 미달) → 통과",
     [user(KO_PROMPT), assistant("OK, done.")], {}, None),
    ("앞 턴이 영어여도 이번 턴이 한국어면 → 통과",
     [user(KO_PROMPT), assistant(EN_REPLY), user("한글로 답해 주세요."), assistant(KO_REPLY)], {}, None),
    # 실제 항목 형태 (CLI 는 사람 입력에 origin.kind=human 을 붙인다)
    ("CLI 사람 입력(origin.kind=human) 한국어 · 영어 응답 → 알린다",
     [user(KO_PROMPT, origin={"kind": "human"}), assistant(EN_REPLY)], {}, "warn"),
    ("CLI 사람 입력 영어 · 영어 응답 → 통과",
     [user(EN_PROMPT, origin={"kind": "human"}), assistant(EN_REPLY)], {}, None),
    ("중단 표시 뒤 영어 응답 → 앞의 한국어 입력으로 재서 막는다",
     [user(KO_PROMPT, origin={"kind": "human"}), user("[Request interrupted by user for tool use]"),
      assistant(EN_REPLY)], {}, "warn"),
    ("슬래시 명령 입력 뒤 영어 응답 → 앞의 한국어 입력으로 재서 막는다",
     [user(KO_PROMPT, origin={"kind": "human"}),
      user("<command-name>/compact</command-name>\n<command-message>compact</command-message>"),
      assistant(EN_REPLY)], {}, "warn"),
    ("압축 요약 뒤 영어 응답 → 앞의 한국어 입력으로 재서 막는다",
     [user(KO_PROMPT, origin={"kind": "human"}),
      user("This session is being continued from a previous conversation. Summary follows.",
           isCompactSummary=True),
      assistant(EN_REPLY)], {}, "warn"),
    ("영어 대화 · 한글 섞인 bash 출력 뒤 영어 응답 → 통과",
     [user(EN_PROMPT, origin={"kind": "human"}), user("<bash-input>ls</bash-input>"),
      user("<bash-stdout>설계.md 구현.md</bash-stdout>"), assistant(EN_REPLY)], {}, None),
    ("메타 항목(영어)은 대화 언어에서 빠진다 → 알린다",
     [user(KO_PROMPT), user("Caveat: the messages below were generated by the user.", isMeta=True),
      assistant(EN_REPLY)], {}, "warn"),
    ("작업 알림이 턴 경계다: 앞 턴 영어 · 알림 뒤 한국어 → 통과",
     [user(KO_PROMPT), assistant(EN_REPLY),
      user("<task-notification>\n<status>completed</status>", origin={"kind": "task-notification"}),
      assistant(KO_REPLY)], {}, None),
    # 판정 단위 · 원문 범위
    ("한 글 블록 안에서 한국어 문단 사이의 영어 문단 → 알린다",
     [user(KO_PROMPT), assistant(KO_REPLY + "\n\n" + EN_REPLY + "\n\n" + KO_REPLY)], {}, "warn"),
    ("인용(>)으로 옮긴 영어 원문 → 통과",
     [user(KO_PROMPT), assistant("리뷰 봇 지적은 아래와 같습니다. 타당해서 반영하겠습니다.\n"
                                 "> Missing index on the history table for billing lookups by project and appkey, which causes full scans as the table grows over time")], {}, None),
    ("인라인 코드만 영어가 많은 한국어 문단 → 통과",
     [user(KO_PROMPT), assistant("다음 명령을 실행합니다 `./gradlew flywayRepair -Pflyway-profile=alpha --info`")], {}, None),
    ("URL 만 영어가 많은 한국어 문단 → 통과",
     [user(KO_PROMPT), assistant("결과 화면입니다 https://dashboard.example.com?view=deploymentsummary&range=lastweek")], {}, None),
    ("경로만 영어가 많은 한국어 문단 → 통과",
     [user(KO_PROMPT), assistant("파일을 고쳤습니다 product/adapter/src/main/java/com/example/ActivationEntity.java")], {}, None),
    ("슬래시로 이은 한국어 낱말은 경로가 아니다 → 통과",
     [user(KO_PROMPT), assistant("설계/구현/테스트/배포/운영/점검/보고 단계 this is the flow of it all")], {}, None),
    # 기준값 고정 (한글 비율 0.3, 글자 20자)
    ("한글 비율 0.25 → 알린다",
     [user(KO_PROMPT), assistant("확인했습니다 this is the main job ok")], {}, "warn"),
    ("한글 비율 0.29 → 알린다",
     [user(KO_PROMPT), assistant("확인했습니다 this is the big job")], {}, "warn"),
    ("한글 비율 0.32 → 통과",
     [user(KO_PROMPT), assistant("확인했습니다요 this is the big job")], {}, None),
    ("한글 비율 0.35 → 통과",
     [user(KO_PROMPT), assistant("확인했습니다요 this is the ones")], {}, None),
    ("로마자 19자 → 세지 않아 통과",
     [user(KO_PROMPT), assistant("it is the end of all runs")], {}, None),
    ("로마자 20자 → 알린다",
     [user(KO_PROMPT), assistant("this is the end of a run ok")], {}, "warn"),
    # 원문 형태 (영어 문장이 아니라 막지 않는다)
    ("식별자 칸으로 된 표 → 통과",
     [user(KO_PROMPT), assistant("| Entity | Repository | Service |\n|---|---|---|\n"
                                 "| the entity of the row | the repository for this | the service that is used |")], {}, None),
    ("영어 제목 링크 목록 → 통과",
     [user(KO_PROMPT), assistant("- [PostgreSQL Release Notes for the latest version](https://example.com/a)\n"
                                 "- [Envers Reference Guide and the audit tables](https://example.com/b)")], {}, None),
    ("상자 그림 → 통과",
     [user(KO_PROMPT), assistant("Admin ── reissue the appkey ──▶ CAB\nCAB ── send the hook to the service ──▶ GPUaaS")], {}, None),
    ("백틱 없는 식별자 나열 → 통과",
     [user(KO_PROMPT), assistant("ProductActivationEntity ProductActivationRecorder ProductActivationSystemService")], {}, None),
    ("JSON 응답(헤드리스 판정) → 통과",
     [user("판정 결과를 JSON 한 줄로만 출력하라"),
      assistant('{"verdict": "content", "reason": "the answer missed the asked scope and the fix was not shown"}')], {}, None),
    ("~~~ 블록 · 들여쓴 코드 → 통과",
     [user(KO_PROMPT), assistant("~~~\nthis is the log line from the build\n~~~\n    and this is the indented output of it")], {}, None),
    # 사람 입력 정리 (표식만 있는 입력은 대화 언어를 정하지 않는다)
    ("이미지만 붙인 입력 뒤 영어 응답 → 앞의 한국어 입력으로 재서 막는다",
     [user(KO_PROMPT, origin={"kind": "human"}), user("[Image #1] [Image #2]", origin={"kind": "human"}), assistant(EN_REPLY)], {}, "warn"),
    ("붙여넣기만 한 입력 뒤 영어 응답 → 앞의 한국어 입력으로 재서 막는다",
     [user(KO_PROMPT), user("<pasted_content id=\"x\">ERROR the build failed with an exception</pasted_content id=\"x\">"),
      assistant(EN_REPLY)], {}, "warn"),
    ("날 슬래시 입력 뒤 영어 응답 → 앞의 한국어 입력으로 재서 막는다",
     [user(KO_PROMPT), user("/compact summarize"), assistant(EN_REPLY)], {}, "warn"),
    ("한국어 인자를 붙인 슬래시 명령이 첫 입력 · 영어 응답 → 알린다",
     [user("<command-message>flow</command-message>\n<command-name>/flow</command-name>\n"
           "<command-args>이슈 시작합니다</command-args>", origin={"kind": "human"}), assistant(EN_REPLY)], {}, "warn"),
    ("list 형 사람 입력(SDK 화면) 한국어 · 영어 응답 → 알린다",
     [{"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": KO_PROMPT}]}},
      assistant(EN_REPLY)], {}, "warn"),
    ("태그 없는 자동 입력(origin 이 human 아님) 영어 · 영어 응답 → 앞의 한국어 입력으로 재서 막는다",
     [user(KO_PROMPT), user("Scheduled wakeup fired for the loop", origin={"kind": "scheduled"}),
      assistant(EN_REPLY)], {}, "warn"),
    ("로컬 명령 출력 뒤 영어 응답 → 앞의 한국어 입력으로 재서 막는다",
     [user(KO_PROMPT), user("<local-command-stdout>Set model to the default one</local-command-stdout>"),
      assistant(EN_REPLY)], {}, "warn"),
    ("대화 언어가 바뀌면 마지막 사람 입력을 따른다: 한국어 → 영어 입력 · 영어 응답 → 통과",
     [user(KO_PROMPT), assistant(KO_REPLY), user(EN_PROMPT), assistant(EN_REPLY)], {}, None),
    ("백틱 넷 코드 블록(안에 ``` 포함) → 통과",
     [user(KO_PROMPT), assistant("예시입니다.\n\n````\n```\nthis is the inner block of it\n```\n\nand this is the rest of the sample\n````")], {}, None),
    ("겹백틱 인라인 코드 → 통과",
     [user(KO_PROMPT), assistant("다음을 확인합니다 ``echo `this is the value of the command` and the rest``")], {}, None),
    ("영어 대화에 한글 고유명사 한 낱말 · 영어 응답 → 통과",
     [user("Please check the deploy status of the 강남 office cluster before the release", origin={"kind": "human"}),
      assistant(EN_REPLY)], {}, None),
    ("짧은 로마자 입력(ok) 뒤 영어 응답 → 앞의 한국어 입력으로 재서 막는다",
     [user(KO_PROMPT), assistant(KO_REPLY), user("ok"), assistant(EN_REPLY)], {}, "warn"),
]

STOP_LAST = [
    # Stop 시점에는 마지막 글이 기록에 없고 입력으로 온다 (#1080)
    ("기록엔 영어 진행 문장 · 마지막 글은 한국어 → 알리지 않는다 (지나간 문장을 끝에서 잡지 않는다)",
     [user(KO_PROMPT), assistant(PROGRESS_EN), tool_use(), tool_result()], {"last_assistant_message": KO_REPLY}, None),
    ("기록엔 없고 마지막 글이 영어 → 알린다",
     [user(KO_PROMPT), assistant(KO_REPLY), tool_use(), tool_result()], {"last_assistant_message": EN_REPLY}, "warn"),
    ("영어 대화 · 마지막 글 영어 → 통과",
     [user(EN_PROMPT), tool_use(), tool_result()], {"last_assistant_message": EN_REPLY}, None),
]

PROGRESS = "Let me check the schema and the recorder first."
POST = {"hook_event_name": "PostToolUse", "tool_use_id": "t1"}
POST_EVENT = POST

# PostToolUse: 답변을 만드는 중에 알린다 (#1080)
POST_CASES = [
    ("한국어 진행 문장 → 통과",
     [user(KO_PROMPT), assistant("스키마와 기록기를 먼저 확인하겠습니다. 바뀐 필드가 있는지 봅니다."), tool_use()], POST, None),
    ("턴의 첫 영어 진행 문장 → 다음 글부터 한국어로 (막지 않음)",
     [user(KO_PROMPT), assistant(PROGRESS), tool_use()], POST, "remind"),
    ("두 번째 영어 진행 문장 → 이미 알렸으니 통과",
     [user(KO_PROMPT), assistant(PROGRESS), tool_use("t0"), tool_result(), assistant(PROGRESS), tool_use()],
     POST, None),
    ("스킬 호출 문구(영어 한 문단) → 다시 쓰게 하지 않는다",
     [user(KO_PROMPT), assistant("I'll use the flow skill to start the issue."), tool_use()], POST, "remind"),
    ("도구 호출 앞 여러 문단에 영어 문단 → 그 자리에서 한국어로 다시 내게 한다",
     [user(KO_PROMPT), assistant(KO_REPLY + "\n\n" + EN_REPLY), tool_use()], POST, "rewrite"),
    ("병렬 호출의 두 번째 호출 → 같은 글을 다시 알리지 않는다",
     [user(KO_PROMPT), assistant(KO_REPLY + "\n\n" + EN_REPLY), tool_use("t0", "t1")], POST, None),
    ("병렬 호출의 첫 호출 → 알린다",
     [user(KO_PROMPT), assistant(KO_REPLY + "\n\n" + EN_REPLY), tool_use("t1", "t2")], POST, "rewrite"),
    ("영어 대화 · 영어 진행 문장 → 통과",
     [user(EN_PROMPT), assistant(PROGRESS), tool_use()], POST, None),
    ("앞 단계의 영어 문단은 다시 알리지 않는다",
     [user(KO_PROMPT), assistant(KO_REPLY + "\n\n" + EN_REPLY), tool_use("t0"), tool_result(),
      assistant("결과를 확인했습니다. 다음 파일을 보겠습니다."), tool_use()], POST, None),
]

# 오탐 형태 (한국어 응답을 막으면 안 된다, #1076)
PROSE = "정리합니다 "
FALSE_POSITIVE_CASES = [
    ("하이픈 식별자의 조각(be · to · a · it)은 기능어가 아니다 → 통과",
     [user(KO_PROMPT), assistant(PROSE + "AlphaBetaGamma-to DeltaEpsilon ZetaEtaTheta")], {}, None),
    ("한 글자 옵션 명령의 조각은 기능어가 아니다 → 통과",
     [user(KO_PROMPT), assistant("실행합니다 gitcommand -a DeltaEpsilon ZetaEtaTheta")], {}, None),
    ("밑줄 식별자의 조각은 기능어가 아니다 → 통과",
     [user(KO_PROMPT), assistant(PROSE + "AlphaBetaGamma_to DeltaEpsilon ZetaEtaTheta")], {}, None),
    ("줄 머리 | 만 있는 표 줄(칸 하나) → 통과",
     [user(KO_PROMPT), assistant("| this is the cell of the table in it\n| and that is the other one of them")], {}, None),
    ("줄 머리 | 없는 표(구분선 있음) → 통과",
     [user(KO_PROMPT), assistant("항목 | 설명\n--- | ---\nentity | the row of the data\nservice | the one that is used")], {}, None),
    ("줄 머리 | 없는 표(구분선 없음 · 칸 셋) → 통과",
     [user(KO_PROMPT), assistant(PROSE + "\nentity | the row of the data | and it is used\nservice | the one that is used | by it")], {}, None),
    ("ASCII 화살표 그림 → 통과",
     [user(KO_PROMPT), assistant("Admin --reissue the appkey--> CAB\nCAB --send the hook to the service--> GPUaaS")], {}, None),
    ("ASCII 상자 그림 → 통과",
     [user(KO_PROMPT), assistant("+------------------------+\n+-----the box of the diagram of the flow-----+")], {}, None),
    ("한글이 든 줄의 화살표는 설명이라 지우지 않는다 → 알린다",
     [user(KO_PROMPT), assistant("재발급 -> this is the main job of the flow ok")], {}, "warn"),
    ("앞 줄이 한국어인 문단의 JSON 한 줄 → 통과",
     [user(KO_PROMPT), assistant('결과는 다음과 같습니다\n{"verdict": "content", "reason": "the answer missed the asked scope"}')], {}, None),
    ("앞 줄이 한국어인 문단의 여러 줄 JSON → 통과",
     [user(KO_PROMPT), assistant('결과는 다음과 같습니다\n{\n  "reason": "the answer missed the scope of it",\n  "ok": true\n}')], {}, None),
    ("JSON 배열 줄 → 통과",
     [user(KO_PROMPT), assistant('목록입니다\n[\n  "the first one of them",\n  "the second one of them"\n]')], {}, None),
    ("한글 없는 제목 · 이름 나열(기능어 없음) → 통과",
     [user(KO_PROMPT), assistant("Spring Boot Testing Guide Reference")], {}, None),
    ("마침표 없는 한글 없는 영어 낱말 나열 → 통과",
     [user(KO_PROMPT), assistant("Postgres Release Notes Archive Index")], {}, None),
]

# 놓침 형태 (영어를 알려야 한다, #1076)
MISS_CASES = [
    ("기능어가 낱말 연속을 못 이루는 짧은 영어 진행 서술(숫자 · 괄호가 끊음) → 알린다",
     [user(KO_PROMPT), assistant("Next, #12 (schema review notes)")], {}, "warn"),
    ("하이픈 낱말에 기능어가 낀 한글 없는 영어 → 알린다",
     [user(KO_PROMPT), assistant("Now the 2-week trial registration.")], {}, "warn"),
    ("기능어 없는 마침표 문장(한글 없음) → 알린다",
     [user(KO_PROMPT), assistant("Minimum 40GB, resize protection off. Submitting.")], {}, "warn"),
    ("인용에 이어 붙은 줄(> 없음)은 인용의 일부다 → 통과",
     [user(KO_PROMPT), assistant("리뷰 봇 지적은 아래와 같습니다. 타당해서 반영하겠습니다.\n"
                                 "> Missing index on the history table for billing\n"
                                 "lookups by project and appkey, which causes full scans as the table grows")], {}, None),
    ("인용 바로 뒤 목록 항목은 인용이 아니다 → 알린다",
     [user(KO_PROMPT), assistant("인용입니다.\n> the quoted line of the text\n- this is the next item in the list of it")], {}, "warn"),
    ("닫히지 않은 ~~~ 로 시작하는 한국어 입력 · 영어 응답 → 한국어 대화로 알린다",
     [user(EN_PROMPT), user("~~~ 때문에 이 설정을 바꿨습니다. 확인해 주세요."), assistant(EN_REPLY)], {}, "warn"),
    ("닫히지 않은 ``` 로 시작하는 한국어 입력 · 영어 응답 → 한국어 대화로 알린다",
     [user(EN_PROMPT), user("``` 이 부분이 이상합니다. 확인을 부탁드립니다."), assistant(EN_REPLY)], {}, "warn"),
    ("경로로 시작하는 한국어 입력 · 영어 응답 → 한국어 대화로 알린다",
     [user(EN_PROMPT), user("/Users/nhn/work/app.log 파일에서 오류를 찾아 주세요"), assistant(EN_REPLY)], {}, "warn"),
    ("시스템 알림 블록이 앞에 붙은 한국어 입력 · 영어 응답 → 한국어 대화로 알린다",
     [user(EN_PROMPT), user("<system-reminder>The task tools have not been used recently.</system-reminder>\n"
                            "이 부분을 확인해 주세요."), assistant(EN_REPLY)], {}, "warn"),
]

NOTE = user("<task-notification>\n<status>completed</status>\n<summary>Background build finished</summary>",
            origin={"kind": "task-notification"})
MID_HUMAN = user("잠깐, 이것도 같이 확인해 주세요.", origin={"kind": "human"})
MULTI = KO_REPLY + "\n\n" + EN_REPLY

# 턴 중간에 끼어든 입력 앞의 글도 그 턴의 글이다 (#1076)
MID_TURN_CASES = [
    ("도구 호출 뒤 알림이 끼어든 턴: 알림 앞 영어 문단 → 한국어로 다시 내게 한다",
     [user(KO_PROMPT), assistant(MULTI), tool_use("t1"), NOTE, tool_result()], POST_EVENT, "rewrite"),
    ("도구 결과 뒤 사람 입력이 끼어든 턴: 그 앞 영어 문단 → 한국어로 다시 내게 한다",
     [user(KO_PROMPT), assistant(MULTI), tool_use("t1"), tool_result(), MID_HUMAN], POST_EVENT, "rewrite"),
    ("도구 호출 · 결과 사이 사람 입력: 그 앞 영어 진행 문장 → 알린다",
     [user(KO_PROMPT), assistant(PROGRESS_EN), tool_use("t1"), MID_HUMAN, tool_result()], POST_EVENT, "remind"),
    ("글로 끝낸 뒤 알림은 새 턴이다: 앞 턴 영어 문단은 다시 알리지 않는다",
     [user(KO_PROMPT), assistant(EN_REPLY), NOTE, assistant("결과를 확인하겠습니다."), tool_use("t1")], POST_EVENT, None),
    ("글로 끝낸 뒤 사람 입력은 새 턴이다: 앞 턴 영어 문단은 다시 알리지 않는다",
     [user(KO_PROMPT), assistant(EN_REPLY), MID_HUMAN, assistant("확인하겠습니다."), tool_use("t1")], POST_EVENT, None),
]

# 기준값 · 목록 · 제외 패턴 고정 (되돌리면 실패해야 한다, #1076)
GLUE = "그 결과는 this is it 입니다 "
LONG_URL = "https://dashboard.example.com/very/long/path?view=deploymentsummary&range=lastweek"
LONG_PATH = "product/adapter/src/main/java/com/example/ActivationEntity.java"
FUNCTION_WORD_LIST = (
    "the a an is are was were be been being to of and or but in on at for with this that these those "
    "it its i i'll i've i'm i'd we we'll we're you you'll your will would can could should not no so "
    "as by from if then than there here what which who when where how also now first next let me my "
    "our they them their has have had do does did before after still again instead until while about into only just"
).split()
NOT_FUNCTION_WORDS = "git commit push build entity service deploy schema recorder".split()
SYSTEM_INPUT_PREFIXES = (
    "[Request interrupted by user", "<bash-input>", "<bash-stdout>", "<bash-stderr>", "<command-args>",
    "<local-command-stdout>", "<local-command-stderr>", "<task-notification>", "<system-reminder>", "!", "/compact",
)
SYSTEM_BODY = " the background build finished with all the tests passing"

PIN_CASES = [
    ("URL 은 낱말 수에서 뺀다 → 통과", [user(KO_PROMPT), assistant(GLUE + LONG_URL)], {}, None),
    ("경로는 낱말 수에서 뺀다 → 통과", [user(KO_PROMPT), assistant(GLUE + LONG_PATH)], {}, None),
    ("영어 문장은 낱말 둘로 못 이룬다 → 통과",
     [user(KO_PROMPT), assistant("정리합니다 ActivationEntity. RecorderService. The Row.")], {}, None),
    ("영어 문장은 낱말 셋이면 이룬다 → 알린다",
     [user(KO_PROMPT), assistant("정리합니다 ThisIsAnAuditTrail is not")], {}, "warn"),
    ("한글이 있는 문단은 기능어가 낱말 연속 밖에 있으면 영어로 보지 않는다 → 통과",
     [user(KO_PROMPT), assistant("정리합니다 ActivationEntity. The RecorderServiceName. MoreNameHere.")], {}, None),
    # 입력 기준값: 한글 비율 0.2, 로마자 10자
    ("입력 한글 비율 0.235 → 한국어 대화 · 영어 응답 → 알린다",
     [user(EN_PROMPT), user("확인 부탁드립니다 please look at the output again"), assistant(EN_REPLY)], {}, "warn"),
    ("입력 한글 비율 0.188 → 영어 대화 · 영어 응답 → 통과",
     [user(KO_PROMPT), user("확인해 주세요 please look at the output again"), assistant(EN_REPLY)], {}, None),
    ("로마자 입력 9자 → 언어를 못 정해 앞의 한국어 입력으로 잰다 → 알린다",
     [user(KO_PROMPT), user("okay thank"), assistant(EN_REPLY)], {}, "warn"),
    ("로마자 입력 10자 → 영어 입력 · 영어 응답 → 통과",
     [user(KO_PROMPT), user("okay thanks"), assistant(EN_REPLY)], {}, None),
]
PIN_CASES += [
    (f"기능어 「{w}」 가 낱말 연속에 있으면 영어 문장 → 알린다",
     [user(KO_PROMPT), assistant(f"정리합니다 AlphaBetaGammaXX {w} DeltaEpsilonZeta")], {}, "warn")
    for w in FUNCTION_WORD_LIST
]
PIN_CASES += [
    (f"기능어가 아닌 「{w}」 → 통과",
     [user(KO_PROMPT), assistant(f"정리합니다 AlphaBetaGammaXX {w} DeltaEpsilonZeta")], {}, None)
    for w in NOT_FUNCTION_WORDS
]
PIN_CASES += [
    (f"시스템 입력 접두 「{prefix}」 뒤 영어 → 사람 입력이 아니라 앞의 한국어 입력으로 잰다 → 알린다",
     [user(KO_PROMPT), user(prefix + SYSTEM_BODY), assistant(EN_REPLY)], {}, "warn")
    for prefix in SYSTEM_INPUT_PREFIXES
]


def outcome(result: dict | None) -> str | None:
    """훅 출력을 판정 이름으로. 형태가 어긋나면 'bad'."""
    if not result:
        return None
    if "decision" in result:
        return "bad"  # 막으면 지나간 문단의 번역이 덧붙는다 (#1080)
    if "systemMessage" in result:
        return "warn" if "새 세션" in result["systemMessage"] else "bad"
    context = result.get("hookSpecificOutput", {}).get("additionalContext", "")
    if "다시 쓰지 않는다" in context:
        return "remind"
    if "한국어로 한 번 다시 내고" in context and "감싼다" in context:
        return "rewrite"
    return "bad"


ALL_CASES = (CASES + STOP_LAST + POST_CASES + FALSE_POSITIVE_CASES + MISS_CASES + MID_TURN_CASES + PIN_CASES)

# 되돌릴 동작: (이름, 훅 원문의 한 조각, 바꿀 조각). 조각이 훅에 없으면 점검이 낡은 것이라 실패로 친다
MUTANT_EDITS = [
    ("URL 제외 제거", "LINK, URL, PATH, QUOTE", "LINK, PATH, QUOTE"),
    ("경로 제외 제거", "URL, PATH, QUOTE", "URL, QUOTE"),
    ("인용 제외 제거", "PATH, QUOTE, TABLE_ROW", "PATH, TABLE_ROW"),
    ("인라인 코드 제외 제거", "INDENTED_CODE, INLINE, LINK", "INDENTED_CODE, LINK"),
    ("링크 제외 제거", "INLINE, LINK, URL", "INLINE, URL"),
    ("들여쓴 코드 제외 제거", "(INDENTED_CODE, INLINE", "(INLINE"),
    ("표 줄 제외 제거", "QUOTE, TABLE_ROW, TABLE_PIPES", "QUOTE, TABLE_PIPES"),
    ("상자 그림 제외 제거", "DIAGRAM_ROW, ASCII_ARROW_ROW", "ASCII_ARROW_ROW"),
    ("줄 머리 | 없는 표 제외 제거", "TABLE_ROW, TABLE_PIPES,", "TABLE_ROW,"),
    ("표 구분선 판정 제거", "if TABLE_SEPARATOR.search(text):", "if False:"),
    ("ASCII 화살표 제외 제거", "ASCII_ARROW_ROW, ASCII_BOX_ROW", "ASCII_BOX_ROW"),
    ("ASCII 화살표 한글 줄 보존 제거", "(?![^\\n]*[가-힣])", ""),
    ("ASCII 상자 제외 제거", "ASCII_BOX_ROW, JSON_ROW", "JSON_ROW"),
    ("문단 안 JSON 줄 제외 제거", "ASCII_BOX_ROW, JSON_ROW)", "ASCII_BOX_ROW)"),
    ("인용 이어지는 줄 제거", "(?:\\n(?![ \\t]*(?:\\n|[#>|`~]|[-*+][ \\t]|\\d+[.)][ \\t]))[^\\n]+)*", ""),
    ("인용 이어지는 줄이 새 블록도 삼킴", "(?:\\n|[#>|`~]|[-*+][ \\t]|\\d+[.)][ \\t])", "(?:\\n)"),
    ("하이픈 · 밑줄 식별자 제외 제거", 'HYPHEN_ID.sub(" ¦ ", OPTION.sub(" ¦ ", body))', "OPTION.sub(\" ¦ \", body)"),
    ("옵션 조각 제외 제거", 'HYPHEN_ID.sub(" ¦ ", OPTION.sub(" ¦ ", body))', 'HYPHEN_ID.sub(" ¦ ", body)'),
    ("밑줄 식별자 제외 제거", "|[A-Za-z0-9]*_[A-Za-z0-9_]*\")", "\")"),
    ("한글 없는 문단 기능어 판정 제거", "if len(words) >= 3 and any(", "if False and any("),
    ("한글 없는 문단 문장 판정 제거", "return len(words) >= 4 and len(lower)", "return False and len(lower)"),
    ("한글 있는 문단에 한글 없는 문단 판정 적용", "if HANGUL.search(body):\n        return False", "if False:\n        return False"),
    ("낱말 셋 → 둘", "){2,}\")", "){1,}\")"),
    ("낱말 셋 → 넷", "){2,}\")", "){3,}\")"),
    ("기능어 the 제거", '"the a an', '"a an'),
    ("기능어 will 제거", " will would ", " would "),
    ("기능어 next 제거", " next let ", " let "),
    ("기능어 just 제거", " just\".split", "\".split"),
    ("기능어 목록에 git 추가", '"the a an', '"git the a an'),
    ("기능어 목록에 push 추가", " just\".split", " just push\".split"),
    ("한글 비율 0.3 → 0.25", "THRESHOLD = 0.3", "THRESHOLD = 0.25"),
    ("한글 비율 0.3 → 0.35", "THRESHOLD = 0.3", "THRESHOLD = 0.35"),
    ("글자 수 20 → 19", "MIN_LETTERS = 20", "MIN_LETTERS = 19"),
    ("글자 수 20 → 21", "MIN_LETTERS = 20", "MIN_LETTERS = 21"),
    ("입력 한글 비율 0.2 → 0.15", "KOREAN_INPUT_RATIO = 0.2", "KOREAN_INPUT_RATIO = 0.15"),
    ("입력 한글 비율 0.2 → 0.25", "KOREAN_INPUT_RATIO = 0.2", "KOREAN_INPUT_RATIO = 0.25"),
    ("입력 로마자 10자 → 9자", "MIN_INPUT_LETTERS = 10", "MIN_INPUT_LETTERS = 9"),
    ("입력 로마자 10자 → 11자", "MIN_INPUT_LETTERS = 10", "MIN_INPUT_LETTERS = 11"),
    ("`!` 입력 제외 제거", 'not head.startswith("!") and', "True and"),
    ("슬래시 명령 제외 제거", "not SLASH_COMMAND.match(head) and", "True and"),
    ("경로 입력도 슬래시 명령으로 봄", "SLASH_COMMAND.match(head)", 'head.startswith("/")'),
    ("압축 요약 제외 제거", 'if entry.get("isCompactSummary"):', "if False:"),
    ("시스템 알림 블록 제거(판정)", 'SYSTEM_REMINDER.sub("", text).lstrip()', "text.lstrip()"),
    ("시스템 알림 블록 제거(언어 재기)", 'text = SYSTEM_REMINDER.sub(" ", text)', "pass"),
    ("닫힌 블록만 지우기 제거", "closed_only=True", "closed_only=False"),
    ("턴 중간 입력 판정 제거", "return previous is not None and (", "return False and ("),
    ("작업 알림(origin 이 human 아님) 제외 제거", 'if origin and (not isinstance(origin, dict) or origin.get("kind") != "human"):', "if False:"),
] + [
    (f"시스템 입력 접두 「{prefix}」 제거", f'"{prefix}",', "")
    for prefix in ("[Request interrupted", "<bash-input>", "<bash-stdout>", "<bash-stderr>", "<command-args>",
                   "<local-command-stdout>", "<local-command-stderr>", "<task-notification>", "<system-reminder>")
]


def check_cases(hook: str | None = None) -> list[str]:
    """사례를 모두 돌려 실패한 사례 이름 목록을 돌려준다."""
    def one(case):
        name, entries, payload, expect = case
        return name, expect, outcome(run(entries, hook, **payload))
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(one, ALL_CASES))
    failed = []
    for name, expect, got in results:
        ok = got == expect
        if hook is None:
            print(f"{'ok  ' if ok else 'FAIL'} {name}" + ("" if ok else f" (기대 {expect}, 실제 {got})"))
        if not ok:
            failed.append(name)
    return failed


def check_mutants() -> int:
    source = open(HOOK, encoding="utf-8").read()
    survivors = 0
    for name, old, new in MUTANT_EDITS:
        if old not in source:
            print(f"낡음 {name}: 훅에서 되돌릴 조각을 못 찾았다")
            survivors += 1
            continue
        with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8") as f:
            f.write(source.replace(old, new, 1))
            path = f.name
        try:
            failed = check_cases(path)
        finally:
            os.unlink(path)
        print(f"{'잡음' if failed else '생존'} {name}" + (f" ({len(failed)}건 실패)" if failed else ""))
        survivors += not failed
    print("변형 전부 잡힘" if not survivors else f"살아남은 변형 {survivors}건")
    return 1 if survivors else 0


def main() -> int:
    if MUTANTS:
        return check_mutants()
    failed = check_cases()
    print("전부 통과" if not failed else f"실패 {len(failed)}건")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
