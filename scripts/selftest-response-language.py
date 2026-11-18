#!/usr/bin/env python3
"""응답 언어 훅 자체 점검 (#792, #1080).

훅을 실제 진입점(표준 입력 JSON → 표준 출력)으로 실행해, 알려야 하는 턴과 통과해야 하는 턴을 고정한다.
Stop 은 막지 않고 사용자 안내만 낸다. PostToolUse 는 답변을 만드는 중에 모델에 알린다.

    python3 scripts/selftest-response-language.py [훅 경로]

훅 경로를 주면 그 파일을 시험한다. 고치기 전 훅으로 실패하는지 볼 때 쓴다.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOOK = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "hooks", "response-language.py")

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


def run(entries: list[dict], **payload) -> dict | None:
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False, encoding="utf-8") as f:
        for e in entries:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")
        path = f.name
    try:
        body = {"hook_event_name": "Stop", "transcript_path": path, "stop_hook_active": False}
        body.update(payload)
        out = subprocess.run([sys.executable, HOOK], input=json.dumps(body), capture_output=True,
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


def main() -> int:
    failed = 0
    for name, entries, payload, expect in CASES + STOP_LAST + POST_CASES:
        got = outcome(run(entries, **payload))
        ok = got == expect
        failed += not ok
        print(f"{'ok  ' if ok else 'FAIL'} {name}" + ("" if ok else f" (기대 {expect}, 실제 {got})"))
    print("전부 통과" if not failed else f"실패 {failed}건")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
