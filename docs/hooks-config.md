# hook·설정 레퍼런스

[설치하고 쓰는 법](usage.md#설치하면-걸리는-것) 에서 요약한 표현 규칙 hook 의 설정 상세와 플러그인 자체 관리 동작입니다. 실행 전에 차단하는 규칙은 [action-gate.md](action-gate.md), 설계 배경은 [design-philosophy.md](design-philosophy.md) 를 참조하세요.

## 표현 가드 룰

금지 표현(과장형 형용사·보고서체·근거 없는 단언·번역투 등)을 응답 출력 직전에 막거나 자동으로 고쳐 쓰지 않습니다.

룰 목록은 컨텍스트에 주입하지 않습니다. 25룰이 매 세션 약 5천 토큰을 차지했기 때문입니다 (#564). 글은 교정 스킬이 `config/style-rules/metrics/tells_count.py` 로 대조하고, 대화 응답은 위반이 검출된 턴에만 UserPromptSubmit 이 교정을 요청합니다.

| hook | 시점 | 싣는 것 |
|------|------|---------|
| Stop (`hooks/forbidden-words-stop.sh`) | 응답 종료 시 | 직전 응답 스캔 → 위반을 `.forbidden-violations-pending` 에 기록 |
| PostToolUse · Stop (`hooks/response-language.py`) | 도구 호출마다 · 응답 종료 시 | 한국어 대화에서 한글 비율 0.3 미만이고 영어 문장이 있는 문단(빈 줄 단위, 코드 · 인라인 코드 · URL · 경로 · 링크 · 표 · 상자 그림 · `>` 인용 · JSON 제외)을 잰다. 글자 20자 미만 문단은 세지 않는다. PostToolUse 는 그 호출 앞의 글을 재서, 한 문단뿐인 진행 문장 · 스킬 호출 문구는 막지 않고 턴에서 처음 한 번 「다음 글부터 한국어로」를 모델에 알린다. 여러 문단이면 다음 글에서 한국어로 다시 내게 한다. 병렬 호출은 첫 호출에서만 잰다. Stop 은 마지막 도구 호출 뒤 글을 재고 막지 않으며, 사용자에게 작업을 마친 뒤 새 세션으로 이어 가라는 안내 한 줄만 낸다. 대화 언어는 한글 비율 0.2 이상인 마지막 사람 입력(로마자 10자 미만 입력은 건너뜀)으로, 사람이 친 입력(CLI 는 origin.kind=human)으로 잰다 (#792, #1080) |
| UserPromptSubmit (`hooks/forbidden-words-prompt.sh`) | 위반이 있는 턴만 | pending 내역으로 교정 요청 후 파일 삭제. 위반이 없으면 무출력 종료 |

이 문서와 [action-gate.md](action-gate.md) 의 비활성 변수(`…_DISABLE=1`)는 사람이 세션 환경에서 켭니다. 어시스턴트가 명령 앞 · `env` · `export` 로 대입하면 PreToolUse 가 막습니다 (action-gate.md 「가드 해제 대입 차단」, #1142).

세션 컨텍스트(provider·git identity·스킬 트리거)는 SessionStart 에서 1회 전달됩니다. `~/.claude/settings.json` 의 `autoMemoryEnabled` 가 `false` 가 아니면 자동 메모리가 켜져 있다는 알림 한 줄이 더해집니다 (#1050). PreToolUse 는 가드 판정만 담당하며 컨텍스트를 싣지 않습니다.

룰은 `config/style-rules/base/ai-tells.md` 의 카테고리 ID(`taxonomyId`)와 1:1 매핑되어, 패턴이 왜 존재하는지 역추적됩니다.

| 위치 | 역할 |
|------|------|
| `config/style-rules/forbidden-words.json` | 룰 전체 (표현 가드 패턴). 기계에 두는 개인 룰 파일은 읽지 않는다 (ADR-0026). |

룰 추가는 JSON 에 객체 하나만 더하면 즉시 반영됩니다(Python 정규식).

## 시범 적용 (trials)

외부 규범·도구를 정식 등재 전에 기간을 두고 써 보는 상태를 SessionStart 가 세션마다 주입합니다. 시범이라도 호출형이 아니라 **상시형**이고, 사용자가 확인을 부르지 않습니다.

| 위치 | 역할 |
|------|------|
| `~/.claude/ops-agent/trials.local.json` | 시범 목록 (사용자 소유). 작업 디렉토리와 무관하게 읽힘 |
| `config/trials.example.json` | 필드 예시 |

`ended` 가 있는 항목은 주입하지 않습니다. 자동 지표(유효한 `metrics` 항목)도 원인 갈래(`cause`)도 없는 항목도 주입하지 않고, 시범 블록 끝에 한 줄로 이름만 알립니다 ([ADR-0043](adr/0043-doc-structure-change-routes-through-expert.md) 결정 4). 어시스턴트가 스스로 적는 `log` 에만 기대는 시범은 판정 근거가 쌓이지 않기 때문입니다.

```
[시범 미등록] a · b: metrics 또는 cause 가 없어 적용하지 않는다 (docs/hooks-config.md 「시범 적용」)
```

**관찰을 남기는 시점은 둘로 정해져 있습니다.** 세션 중 지적이 나온 순간에 기록하는 트리거는 두지 않습니다. 발화에서 교정을 정규식으로 잡는 방식은 측정으로 기각됐습니다 ([lessons.md](lessons.md) 「정규식으로 교정을 판별하지 않는다」).

| 시범이 재는 것 | 남기는 방식 |
|----------------|-------------|
| 사용자 지적 · 교정의 증감 | `cause` 를 지정합니다. 작업 시간 밖 판정(`lessons-judge.py`)이 세션마다 교정을 추리므로, 손으로 쓰는 `log` 없이 원인별 정답률로 효과를 봅니다. 관찰 항목 없이 `cause` 만 있는 시범은 레슨 판정이 잽니다. |
| 그 밖의 산출물 · 관찰 | 세션 마무리 레슨런(`/learn`)에서 이번 세션의 관찰을 `log` 에 한 줄 더합니다. 대상은 `cause` 가 없는 시범과, 검토 조건(`review`)이 `log` 관찰 항목(「~마다 log 에 … 한 줄」)을 정한 시범입니다. 후자는 원인 갈래(`cause`) 유무와 무관합니다. 판정은 원인별 정답률만 내고 시범이 정한 관찰 항목(되물음 수 · 뒤집힌 결정 수 같은 것)은 세지 않기 때문입니다. 해당 없으면 쓰지 않습니다. |

산출물·관찰은 `log` 에 한 줄씩 더하고, 판정은 세션 끝이 아니라 `review` 조건이 충족될 때 합니다. 프로젝트 메모리는 디렉토리별이라 이 용도의 운반체로 쓰지 않습니다 (#442). 판정일이 오면 learn 게이트에서 유지 · 폐기 · 조정을 판정합니다.

선택 필드로 판정 근거를 시범에 붙일 수 있습니다. 세션 시작 때 trial 마다 최대 4줄(지표 · 기준 · 판정일 · 도래 안내)이 더해집니다.

| 필드 | 형식 | 역할 |
|------|------|------|
| `metrics` | `[{ name, source, groupBy \| ratio, since? }]` | `groupBy` 와 `ratio` 중 하나가 있어야 유효한 지표입니다. `groupBy` 는 `source`(jsonl)의 그 필드 값별 줄 수를 집계합니다. `ratio: [분자 필드, 분모 필드]` 는 두 필드가 모두 수인 줄만 합산해 `이름 0.29 (5/17 · 16줄)` 로 냅니다(분모 합이 0 이면 「기록 없음」). `since` 가 없으면 `started` 이후 `ts`(ISO 문자열)만 집계합니다. 파일이 없으면 「기록 없음」으로 냅니다. 파일 이름에 `*` 가 있으면 그 디렉토리에서 글롭으로 맞는 파일을 모두 합쳐 집계합니다(디렉토리 부분의 `*` 는 지원하지 않습니다). 파일이 5MB 를 넘으면 「기록 없음」으로 두지 않고 파일 끝 5MB 만 읽어 집계하며(잘린 첫 줄은 버림) 지표 끝에 `(파일 끝 5MB 만 집계)` 를 붙입니다. |
| `criteria` | 문자열 배열 | 판정 기준입니다. ` / ` 로 이어 한 줄로 냅니다. |
| `cause` | `content`(내용) \| `level`(수준) \| `path`(경로) | 이 시범이 줄이려는 교정의 원인입니다. 경로는 불렀어야 할 스킬 · 전문가 · 검증 단계를 부르지 않아 생긴 교정입니다 ([lessons.md](lessons.md) 「지표」). 있으면 `scripts/lessons-judge.py report` 의 원인별 정답률을 시작일 전 기준선과 비교하라는 줄을 냅니다. 없거나 검토 조건이 `log` 관찰 항목을 정했으면 `log` 안내를 냅니다. |
| `reviewAt` | `YYYY-MM-DD` | 판정일입니다. 오늘이 이 날 이후면 기준과 지표를 대조해 정식 도입 · 폐기 · 재검토를 사용자에게 묻는 안내가 추가됩니다. |

```json
{
  "name": "final-check",
  "started": "2026-09-01",
  "metrics": [{ "name": "차단", "source": "~/.claude/ops-agent/metrics/final-check.jsonl", "groupBy": "result" }],
  "criteria": ["blocked 가 fail 보다 많다", "오탐 신고 0건"],
  "reviewAt": "2026-10-01"
}
```

```
지표: 차단 blocked 3 · pass 5 · fail 2
기준: blocked 가 fail 보다 많다 / 오탐 신고 0건
판정일: 2026-10-01
```

비율 지표는 한 줄에 분자 · 분모가 함께 있는 기록(위임 기록의 부른 수 · 불러야 했던 수)에 씁니다.

```json
{
  "name": "delegation-trial",
  "started": "2026-11-01",
  "metrics": [
    { "name": "호출", "source": "~/.claude/ops-agent/metrics/delegation.jsonl", "ratio": ["calls_made", "calls_expected"] },
    { "name": "결과", "source": "~/.claude/ops-agent/metrics/delegation.jsonl", "ratio": ["done", "items"] }
  ]
}
```

```
지표: 호출 0.29 (14/48 · 16줄) / 결과 0.74 (63/85 · 25줄)
```

`cause` 를 붙인 시범은 `log` 안내 줄 대신 효과 줄이 나옵니다. 원인과 함께 `log` 기록도 필요한 시범은 그 절차를 `review` 문구에 적습니다.

**스킬 사용 기록**: `pre-tool-use.mjs` 가 Skill 도구 호출과 플러그인 설치본(`~/.claude/plugins/` · `~/.claude/ops-agent/current/`)의 `skills/<이름>/SKILL.md` Read 를 스킬 사용으로 세어 `~/.claude/ops-agent/metrics/skill-use-YYYY-MM.jsonl` 에 한 줄 남깁니다 (#1135). 새 스킬은 등록 없이 쌓입니다.

| 항목 | 값 |
|------|-----|
| 필드 | `ts` · `session` · `skill` · `repo`(작업 디렉토리 basename) 넷뿐. Skill 도구의 args · 전체 경로는 남기지 않는다. 스킬 이름 앞 네임스페이스(`ops-agent:`)는 뗀다. |
| 세지 않는 것 | 레포 워킹 카피의 SKILL.md Read(스킬을 쓴 것이 아니라 고치는 것), SKILL.md 가 아닌 파일 Read, 다른 도구 |
| 중복 | 같은 세션 · 같은 스킬은 첫 1회만 센다. 세션별 캐시 `.cache/skill-use/<세션>.txt` 로 판정하고, 14일 지난 캐시는 새 세션 첫 기록 때 지운다. |
| 비용 | Skill · Read 가 아닌 도구 호출은 도구 이름 비교만 하고 파일 접근이 없다. Read 는 경로 정규식만 보고 설치본 SKILL.md 일 때만 캐시를 연다. |
| 파일 | 달마다 나눠 한 파일이 5MB 에 닿는 시점을 늦춘다. 기록 실패는 판정을 바꾸지 않는다. |
| 자체 점검 | `node scripts/selftest-skill-use.mjs` (집계 · 알림 포함) |
| 비활성 | `OPS_AGENT_SKILL_USE_DISABLE=1` |

```json
{
  "name": "skill-trial",
  "started": "2026-11-01",
  "metrics": [{ "name": "스킬 사용", "source": "~/.claude/ops-agent/metrics/skill-use-*.jsonl", "groupBy": "skill" }]
}
```

- 지표: 훅이 자동으로 남기는 jsonl 만, 체감 점수 제외
- 기준 미달: 폐기가 아니라 재검토
- 읽기 실패 · 형식 오류: 조용히 건너뜀, 세션 시작은 막지 않음

```json
{ "pattern": "포괄적|체계적", "replacement": "구체 표현 (무엇을/어떻게)", "reason": "AI 슬롭 (추상적 과장 형용사)" }
```

신규 패턴은 먼저 `base/ai-tells.md` 분류 체계에 카테고리 ID 를 부여하고, S1 으로 판정될 때 등록합니다.

## lint 자동 점검

문서 편집(Edit/Write) 직후 lint 관점(AI 티·가독성·톤·구두점) 자가 점검을 유도하는 PostToolUse hook 입니다. 발동 조건은 둘 중 하나입니다.

| 조건 | 동작 |
|------|------|
| 프로젝트 루트(또는 상위)에 마커 파일 `.ops-agent/lint.json` | 마커의 `include`/`exclude`/`note` 를 적용해 작동. 예전 이름 `.ops-agent/content-verify.json` 도 읽는다 |
| 편집 대상이 `_posts/` 아래 마크다운 | 마커 없이도 작동 (발행물 갈래) |

마커는 모든 프로젝트의 `.md` 편집마다 리마인더가 뜨는 노이즈를 막는 장치입니다. `_posts/` 는 경로가 곧 발행 대상이라는 신호라 노이즈 위험이 다르고, 이 갈래에까지 opt-in 을 요구하면 발행 규칙 backstop 이 가장 필요한 레포일수록 마커가 없어 조용히 꺼집니다. 마커가 있으면서 `exclude` 로 `_posts` 를 제외한 경우는 그 설정을 존중해 발동하지 않습니다.

```json
{
  "include": ["**/*.md", "resume/*.html"],
  "exclude": ["node_modules/**", "CHANGELOG.md"],
  "note": "프로젝트별 추가 안내 (선택, 리마인더에 함께 출력)"
}
```

- `include` 생략 시 기본값은 `["**/*.md"]` 입니다.
- 도메인 특화 검증(예: 이력서 ATS·PDF 동기)은 소비 레포의 프로젝트 스코프 hook 으로 별도 구성합니다.
- 시점 고정 기록(ADR·spec 스냅샷)은 `exclude` 에 넣습니다. 지난 문장을 지금 기준으로 고치면 기록이 아니게 됩니다.

hook 이 내보내는 검출은 두 종류입니다.

| 검출 갈래 | 무엇을 보나 | 구현 |
|-----------|-------------|------|
| 표현 검출 | em dash, AI 슬롭 어휘 | hook 내부 정규식 |
| 구조 검출 | 문단 길이·산문 연속·시각 요소 주기·목록 항목 수·테이블 열 수·헤딩 레벨·코드 언어·서술 문장 종결 부호(PN7)·물결표 취소선(PN8)·불릿 안 머리말(L9) | `config/style-rules/metrics/readability_count.py` |

정규식은 어휘만 봅니다. 산문이 몇 문단 쌓였는지는 세어야 알 수 있어 카운터를 따로 둡니다. 검출 결과가 수치로 실려 오므로 리마인더가 "점검하라" 가 아니라 "여기가 몇이다" 가 됩니다.

카운터가 커버하는 항목과 일부러 빼놓은 항목은 `config/style-rules/base/readability.md` 의 검증 표에 있습니다.

## 컴팩트 재료 보존

컴팩트 요약은 결론과 파일 경로를 남기고 **그 결론을 만든 명령을 버린다.** 결론이 근거보다 오래 살면 「이미 확인함」으로 읽혀 재확인이 일어나지 않는다. 측정과 결정은 [ADR-0013](adr/0013-compact-preserves-conclusion-not-evidence.md).

| hook | 시점 | 하는 일 |
|------|------|--------|
| PreCompact (`hooks/precompact-state.py`) | 컴팩트 직전 | 그 구간의 사용자 발화·실행한 명령·고친 파일을 `~/.claude/state/compact/<세션ID>.md` 에 덧붙인다 |
| SessionStart · matcher `compact` (`hooks/postcompact-pointer.py`) | 컴팩트 직후 | 그 파일 **경로**를 컨텍스트에 주입한다 |

기록 기준은 하나다. **다시 만들 수 있는 것은 남기지 않는다.** 도구 출력은 명령이 있으면 다시 만들어지므로 버리고, 사용자 발화는 다시 만들 수 없으므로 원문으로 남긴다.

본문이 아니라 경로를 주입한다. 본문을 넣으면 다음 컴팩트에서 다시 요약되어 같은 손실이 반복된다.

| 항목 | 값 |
|------|-----|
| 산출물 | `~/.claude/state/compact/<세션ID>.md` (구간별 덧붙임) |
| 커서 | 같은 디렉토리의 `<세션ID>.cursor` — 이미 기록한 줄 번호 |
| 명령 상한 | 구간당 최근 120건. 단독 `cd`·`ls`·`echo` 류는 제외하되 체인이 있으면 남긴다 |
| 네트워크 | 없음. 트랜스크립트를 읽고 로컬 파일만 쓴다 |

## 빌드 스크립트 가드

번들을 쓰는 레포(`<root>/gradle/` 아래 `.gradle` 파일이 있음)에서 모듈 `build.gradle` 에 라이브러리 좌표(`group:artifact`)가 더해지는 `Write` · `Edit` · `MultiEdit` 를 편집 직전에 알린다. 편집은 되돌릴 수 있어 막지 않는다. 모듈 간 의존(`project(':x')`)과 번들 적용(`apply from`)은 통과한다. 루트 `build.gradle` 과 `gradle/` 아래 번들은 대상이 아니다.

근거와 해결은 [flow 구현 가이드](../skills/flow/guides/implement.md) 「모듈 빌드 스크립트에 라이브러리를 더하지 않는다」에 있다.

| 항목 | 값 |
|------|-----|
| 판정 | `scripts/build-guard-rules.mjs` (순수 함수) |
| 자체 점검 | `node scripts/selftest-build-guard.mjs` |
| 비활성 | `OPS_AGENT_BUILD_GUARD_DISABLE=1` |

## DB 클라이언트 경계

DB 클라이언트(`mysql` · `mariadb` · `mysqldump` · `mysqlsh`)를 실행하는 `Bash`, 그 실행을 담은 셸 스크립트(`.sh` · `.bash` · `.zsh` 또는 shebang)를 쓰는 `Write` · `Edit` · `MultiEdit` 직전에, 소비 환경의 접속 자산 경로를 조치 한 줄로 주입한다. 막지 않고 뒤 가드의 판정도 바꾸지 않는다. 인자 자리의 낱말(`grep mysql`) · 드라이버 이름(`mysql2`) · 문서 산문은 대상이 아니다.

알려진 한계: shebang 판정은 본문 전체를 쓰는 `Write` 에서만 한다. 확장자 없는 shebang 스크립트를 `Edit` · `MultiEdit` 로 고치면 알리지 않는다. 클라이언트 경로 대입 꼴은 따옴표 안에 있어도 알린다. 주입만 하는 알림이라 누락 · 과잉의 비용이 작아 판정을 넓히지 않았다.

자리가 비어 있으면 가리킬 곳이 없으니 알리지 않는다. 자산을 부르지 않고 쓰기 스크립트를 짜서 자산에 적힌 실패가 재발한 사례가 근거다 ([docs/lessons.md](lessons.md) 「도구 경계에서 로드한다」, #1197).

| 항목 | 값 |
|------|-----|
| 판정 | `scripts/db-client-boundary.mjs` (순수 함수) |
| 자리 | `~/.claude/ops-agent/dbgate/client.md` (`OPS_AGENT_DB_CLIENT_NOTES` 로 바꾼다). 연결은 소비 환경이 한다 ([dbgate](../skills/dbgate/SKILL.md) 「소비 환경이 채우는 것」). |
| 자체 점검 | `node scripts/selftest-db-client-boundary.mjs` |
| 비활성 | `OPS_AGENT_DB_CLIENT_NOTICE_DISABLE=1` |

## 최종 점검 통과 기록

`pre-tool-use.mjs` 가 `gh pr merge` 를 잡으면 `scripts/final-check.sh` 가 남긴 통과 기록을 로컬에서 확인해, 없거나 head 가 어긋나면 막습니다. 점검 항목과 통과 기록 형식은 [action-gate.md](action-gate.md) 「최종 점검 통과 기록」에 있고, 비활성은 `OPS_AGENT_FINAL_CHECK_DISABLE=1` 입니다.

## 플로우 진입 지표

`pre-tool-use.mjs` 가 커밋 · push · PR 생성 명령을 잡으면, 그 세션 대화 기록에서 플로우 가이드를 읽은 흔적을 찾아 `~/.claude/ops-agent/metrics/flow-entry.jsonl` 에 한 줄 남깁니다. `flow`(loaded · missed · unknown)를 집계합니다 (#769).

가이드를 읽지 않은(missed) 세션의 PR 생성은 막습니다. PR 은 공유 표면에 알림이 나가 되돌릴 수 없고, 사용자가 잡은 초안 생략 두 건이 모두 이 상태의 PR 생성이었습니다 (#773). 커밋 · push 는 되돌릴 수 있어 기록만 하고, 판정하지 못한 경우(unknown)는 막지 않습니다. 가이드를 읽으면 다음 컨텍스트 압축 전까지 통과합니다. 압축은 읽은 가이드를 요약으로 대체하므로, 압축 뒤에는 다시 읽어야 통과합니다 (#891). 읽음은 flow 문서 하나만 읽어도 성립해 PR 가이드의 초안 규칙은 보장하지 못하므로, 초안 여부는 초안 PR 가드([action-gate.md](action-gate.md))가 명령에서 직접 봅니다 (#876).

| 항목 | 값 |
|------|-----|
| 흔적 | 가이드 파일(`skills/flow/SKILL.md` · `skills/flow/guides/`)을 대상으로 한 Read 호출과 flow 스킬 호출. 둘 다 하네스가 내용을 컨텍스트에 넣는다. 셸 명령(출력 · 검색 · 편집 스크립트) · 편집 도구 · 위임 문구 · 트리거 표 · 도구 결과에 든 경로 문자열은 흔적이 아니다 (#1116). |
| 서브에이전트 | 그 에이전트 자신의 대화 기록(`<세션>/subagents/` 아래 `agent-<id>.jsonl`)으로 판정한다. 상위 세션이 읽은 가이드는 서브에이전트 컨텍스트에 없어 인정하지 않는다. 기록을 찾지 못하면 상위 기록으로 본다 (#1114). |
| 비용 | 세션마다 읽은 위치를 `.cache/flow-entry/` 에 두고 이어 읽는다. 예산이 모자라면 unknown 으로 남긴다. |
| 보는 자리 | 세션 시작 「경로 요약」 줄에 최근 7일 커밋 · push 누락 수가 나온다 (#1154). |
| 자체 점검 | `node scripts/selftest-flow-entry.mjs` |
| 비활성 | `OPS_AGENT_FLOW_ENTRY_DISABLE=1` (기록과 차단 모두) |

## 전문가 경유 지표

`pre-tool-use.mjs` 가 공유 표면 쓰기를 통과시킬 때, 그 세션 대화 기록에서 기술 커뮤니케이션 전문가의 판정 흔적을 찾아 `~/.claude/ops-agent/metrics/expert-route-YYYY-MM.jsonl` 에 한 줄 남깁니다 ([ADR-0043](adr/0043-doc-structure-change-routes-through-expert.md) 결정 2). 막지 않습니다. 2주 기록으로 오탐을 실측한 뒤 차단으로 올릴지 판정합니다.

| 항목 | 값 |
|------|-----|
| 대상 표면 | 이슈 생성 어댑터(`gh-issue.sh create`. 명령 머리에서 직접 또는 셸로 실행할 때만 센다. 출력에 든 이름과 도움말 인자(`--help` · `-h`)는 생성이 아니다), `gh pr create`, 본문 인자(`--body` · `-b` · `--body-file` · `-F`)가 있는 `gh issue edit` · `gh pr edit` · `gh issue comment` · `gh pr comment` · `gh pr review`, `gh api` 의 댓글 · 리뷰 쓰기(`issues/<번호>/comments` · `issues/comments/<id>` 는 `api-comment`, `pulls/…/reviews` · `pulls/…/comments` 는 `api-review`, 쓰기 메서드 POST · PATCH · PUT 만, GraphQL 은 댓글 · 리뷰 mutation 이름), 범위 안 md(`*.md` 에서 변경 기록을 뺀 것. 변경 기록은 대소문자를 가리지 않는 `CHANGELOG`, 대문자 `CHANGES` · `HISTORY` · `NEWS` · `RELEASES` · `RELEASE_NOTES`, 그 접미 변형(언어 코드 `CHANGELOG.ko.md` · 판 번호 `CHANGELOG-v2.md` · 보관 `CHANGELOG.old.md` 같은 꼴. 받는 꼴은 판별 도구로 확인한다), `changelog/` · `changelogs/` · `.changeset/` 디렉토리 아래 md 다. 소문자 `history.md` · `changes.md` · `news.md` 는 안내 문서일 때가 많아 레포 문서로 센다. 실제 변경 기록이면 오탐이다. `changelog-guide.md` 같은 안내 문서도 레포 문서로 센다. 범위 표의 「레포 문서」)가 든 커밋(`commit-md`. 커밋에 담길 diff 에 그 파일이 있을 때. 담길 범위는 `scripts/commit-scope.mjs` 가 그 커밋의 인자대로 정한다: `-a` 면 추적 파일 전체, 경로 지정이면 그 경로, `--include` 면 스테이징분과 그 경로, 그 밖은 스테이징분. 인자로 범위를 정하지 못하면(경로를 글자로 알 수 없음 · 셸로 읽지 못함 · 같은 명령 앞에 `git add` · `git stage`) 스테이징분과 추적 파일 전체를 본다. `git add` · `git stage` 가 있으면 새 파일도 본다. 변경 기록을 빼는 것은 범위 표 「다루지 않는다」 칸을 따른다. 같은 칸을 따라 내용 변경 없는 md 파일 삭제 · 이름 변경도 세지 않는다. 파일이 남은 채 줄만 지운 것과 이름을 바꾸며 내용도 고친 것은 센다), 오버레이가 더한 도구. 레포 문서는 초고 쓰기(Write · Edit)가 판정보다 먼저 오므로 쓰는 순간이 아니라 커밋 때 본다. 범위는 [전문가 파일 「범위」](../experts/tech-comm.md#범위) 표의 글이다. 본문 인자가 없는 명령(제목만 편집 · 승인만 · 댓글 삭제)은 보지 않는다. `gh pr create` · `gh issue edit` · `gh pr edit` · `gh issue comment` · `gh pr comment` · `gh pr review` 도 따옴표 밖에 도움말 인자(`--help` · `-h`)가 있으면 도움말만 내고 쓰지 않으므로 보지 않는다. `gh api` 리뷰 이벤트(리뷰 만들기 · 보류 리뷰 제출 · GraphQL 리뷰 만들기 · 제출)도 본문(`body`)과 줄 댓글(`comments`)이 없으면 승인만이라 보지 않는다. 히어닥 본문 줄은 명령이 아니라 입력 글이라 표면으로 읽지 않는다. |
| 경유(via) | 전문가 파일(`experts/tech-comm.md`)을 프롬프트가 가리키는 에이전트 호출의 결과 첫 줄이 `[tech-comm-verdict: pass\|revise\|hold]` 중 하나다. 결과는 도구 결과(동기 호출) · 완료 알림의 result(백그라운드 호출) · 결과 넘김 틀(SubagentHandback) 어느 쪽이든 그 호출에 이어진 것만 본다. |
| 판정 불가(unknown) | 전문가 파일을 직접 읽기만 함(`inline`), 전문가 스킬만 부름(`expert-unspecified`), 대화 기록 파일 없음(`no-transcript`), 예산 부족(`budget`, 서브에이전트가 상위 기록을 다 읽지 못한 경우 포함). |
| 누락(missed) | 흔적이 없거나, 표식 없이 끝난 전문가 호출뿐이거나(trace `agent`), 직전 쓰기보다 앞선 흔적뿐이다(`stale`). |
| 흔적이 아닌 것 | 메인 세션 텍스트의 표식, 사용자 발화 중간에 붙여 넣은 완료 알림 형식(알림은 문자열 머리에서 시작할 때만 본다. 한 문자열의 알림 · 넘김 틀 여럿은 각각 본다), 사용자 발화 · 셸 명령(검색 · 출력)에 든 전문가 파일 경로, 글 작성 스킬 본문의 표식 틀, 다른 에이전트 결과의 표식 |
| 직전 쓰기 | 기록한 쓰기(커밋 포함)가 그때까지의 흔적을 소비한다. 한 호출에 표면이 여럿이면(`git commit … && gh pr create …`) 명령 순서대로 표면마다 한 줄을 남기고, 앞 표면이 소비한 흔적은 뒤 표면에서 stale 이다. 그래서 레포 문서 커밋 뒤의 PR 본문은 따로 판정받아야 경유다. 다음 쓰기는 그 뒤에 생긴 흔적만 경유로 센다. 뒤 가드에 막힌 쓰기는 기록하지 않고 흔적도 소비하지 않는다. |
| 서브에이전트 | 자기 대화 기록(`<세션>/subagents/` 아래 `agent-<id>.jsonl`)의 흔적을 먼저 보고, 직전 쓰기 뒤 흔적이 없으면 상위 세션 기록을 본다(scope `parent`). 직전 쓰기 뒤 흔적이 둘 다 없으면 자기 기록에 앞선 흔적이 있을 때 자기 기준, 상위에만 있을 때 상위 기준으로 누락 · stale 이다. 자기 기록을 찾지 못하면 상위 기록으로 본다. |
| 필드 | `ts` · `session` · `agent`(서브에이전트일 때) · `surface` · `tool` · `repo`(basename) · `bodyLines`(본문 줄 수, 규모별로 나눠 보는 데 쓴다. `gh api` 는 `body` 필드 · `--input` JSON 의 `body`, `commit-md` 는 범위 안 md 의 추가 · 변경 줄 합이고 파일 경로는 남기지 않는다) · `verdict` · `trace`(agent · read · skill · none) · `scope` · `stale` · `afterCompact`(직전 쓰기 뒤 압축) · `reason`(판정 불가일 때) · `verdictValue`(경유일 때 판정 값 pass · revise · hold. 경유로 세는지는 값과 무관하다). 본문 · 제목 · 전체 경로는 남기지 않는다. |
| 기록 시점 | 가드를 모두 통과해 응답하는 자리에서만 남긴다. 대화 기록 경로가 없는 호출(자체 점검 · 수동 실행)은 세지 않는다. |
| 비용 | 공유 표면 쓰기에서만 대화 기록을 읽는다. 세션마다 읽은 위치를 `.cache/expert-route/` 에 두고 이어 읽는다. 75MB 기록 처음 읽기는 훅 전체 212ms(기준 약 100ms), 이어 읽기는 기준과 같다. 커밋은 커밋에 담길 diff 의 파일별 줄 수만 읽어 약 +8ms 이고, 범위 안 md 가 있을 때만 대화 기록을 읽는다 (2026-11-19 실측). 예산이 모자라면 판정 불가로 남긴다. |
| 알려진 미탐 · 오탐 | 설계상 제외: 커밋하지 않은 md · 레포 밖 md 는 공유 전이라 세지 않고, 가드 내부 오류로 검사 없이 통과한 쓰기도 기록하지 않는다. **판별은 도구 결과를 따른다**: 기록된 한 줄이 오탐인지 정상인지는 그 줄의 `session` · `ts` 로 대화 기록에서 명령을 찾아 `node scripts/expert-route-probe.mjs --repo <레포> -- '<명령>'` 로 실행한 결과(기록 여부 · 표면 · 본문 줄 수)로 가린다. 미탐은 기록에 줄이 없으므로, 대화 기록의 공유 표면 쓰기 가운데 기록에 없는 것을 같은 도구로 실행해 확인한다. 커밋(`commit-md`)은 도구가 레포의 지금 스테이징 · 작업 트리로 세므로 그 커밋 직전 상태를 되살린 레포에서 실행한다. 도구는 Bash 명령만 받는다. 아래는 종류이고, 경계(줄 나눔 · 위치 · 접미)는 문장보다 도구가 정확하다. **미탐 종류**: 셸이 감싼 명령(복합 구문 · 명령 대체 · `bash -c` · `eval` · `xargs` 안의 쓰기와 커밋, gh 쓰기와 이슈 생성 어댑터에 한해 `( … )` 안과 `command` · `time` 접두. 위치와 줄 나눔에 따라 기록되기도 한다), 본문 인자 자체를 셸 변수로 넘긴 명령, 본문 인자를 붙여 쓴 편집 · 댓글 · 리뷰(`-b"…"`), 번호가 셸 변수인 `gh api` 경로, `close` · `reopen` 의 `--comment`, `gh api` 로 이슈 · PR 본문을 고치는 호출, 명령 글자에 `body` 낱말이 없는 GraphQL 리뷰 만들기 · 제출(입력 객체(`input`)나 스레드 본문을 통째로 변수로 넘긴 호출. `body:$변수` 처럼 필드 이름이 글자로 있으면 기록된다), `exec` · `bash -o pipefail` 로 실행한 이슈 생성 어댑터, GitHub discussion 댓글 · gist, 오버레이에 없는 도구, 같은 명령의 `git mv` · `git rm` · 파일 쓰기로 담기는 md, 커밋 범위 해석의 한계(셸 변수로 옮긴 디렉토리는 훅이 받은 작업 위치로 보고 세므로 다른 레포의 커밋일 수 있다, #1186). **오탐 종류**(흔적을 소비해 뒤 쓰기를 누락으로 만든다): 실제로 담기지 않는 md 까지 센 커밋(같은 명령 앞의 `git add` 가 디렉토리 · 글롭을 담거나 경로 지정 add 앞에 다른 새 md 가 있을 때, 한 명령의 커밋 여럿, 스테이징을 비운 뒤의 커밋, 커밋하지 않는 `git commit` 옵션), 이름 규칙 밖의 변경 기록과 실제 변경 기록인 소문자 이름. **기록되지만 본문 줄 수가 틀리거나 빈 것**: 셸 변수로 넘긴 본문 · 본문 파일. |
| 보는 자리 | 세션 시작 「경로 요약」 줄 |
| 자체 점검 | `node scripts/selftest-expert-route.mjs` |
| 기록 자리 바꾸기 | `OPS_AGENT_EXPERT_ROUTE_DIR=<디렉토리>` 면 기록 · 캐시를 `~/.claude/ops-agent` 아래가 아니라 `<디렉토리>/metrics/` · `<디렉토리>/.cache/` 에 둔다. 판별 도구가 실제 HOME 그대로 훅을 실행하면서 사용자 지표를 건드리지 않으려고 쓴다. |
| 비활성 | `OPS_AGENT_EXPERT_ROUTE_DISABLE=1`. 가드가 아니라 지표라 대외비 가드 비활성(`OPS_AGENT_CONFIDENTIAL_DISABLE=1`)과 무관하게 기록한다. |

**표면 오버레이**: 사용자 워크플로우의 문서 도구(MCP 도구 · 명령줄 도구 등)는 `~/.claude/ops-agent/route-surfaces.local.json` 으로 더합니다. 예시는 `config/route-surfaces.example.json` 입니다. 파일이 없으면 내장 표면만 보고, 깨졌거나 정규식이 틀리면 알림 한 줄을 내고 내장 표면만 봅니다. 오버레이는 Bash · `mcp__` 도구 호출에서만 읽습니다.

| 필드 | 형식 | 역할 |
|------|------|------|
| `name` | 문자열 | 기록의 `surface` 값 |
| `tool` | 정규식 | 도구 이름(`Bash`, `mcp__<서버>__<도구>`) |
| `pattern` | 정규식 | Bash 면 명령 전체, 그 밖의 도구면 입력을 JSON 으로 직렬화한 문자열에 대조한다. |
| `body` | 문자열 (선택) | 본문이 든 입력 필드 이름. 있으면 그 줄 수를 `bodyLines` 로 남긴다. |

## 세션 시작 경로 요약

SessionStart 가 시범 블록 다음에 한 줄을 냅니다 ([ADR-0043](adr/0043-doc-structure-change-routes-through-expert.md) 결정 5). 불렀어야 할 스킬 · 전문가를 거쳤는지를 기계 기록으로 보는 자리입니다.

```
[경로 · 최근 7일] 공유 표면 쓰기 경유 2 · 누락 5 · 판정 불가 1 / 레슨 원인 「경로」 3건 / 플로우 진입 누락 12건(커밋 · push)
```

| 항목 | 원천 |
|------|------|
| 공유 표면 쓰기 | `metrics/expert-route-*.jsonl` 의 `verdict`, `ts` 기준 최근 7일 |
| 레슨 원인 「경로」 | `lessons/judgments.jsonl` 에서 세션마다 마지막 판정의 `cause: path` 교정 수, 세션 시각(처음 판정한 시각) 기준 최근 7일 |
| 플로우 진입 누락 | `metrics/flow-entry.jsonl` 에서 커밋 · push 가 든 `flow: missed` 줄 수. PR 생성 누락은 차단되므로 넣지 않는다. |

원천 파일이 없는 항목은 빼고, 셋 다 없으면 줄을 내지 않습니다. 파일은 끝 5MB 만 읽고 깨진 줄은 건너뜁니다. 자체 점검은 `node scripts/selftest-skill-use.mjs` 에 있습니다.

## 훅 실행 예산

훅이 하네스 타임아웃에 잘리면 그 호출의 검사는 성립하지 않는다. 잘렸다는 사실도 남지 않아, 가드가 걸려야 할 자리에서 조용히 빠진다.

그래서 **잘리기 전에 스스로 답한다.** `pre-tool-use.mjs` 는 시작 시각 기준으로 예산을 두고 그 안에서 판정을 끝낸다.

| 예산 항목 | 값 |
|-----------|-----|
| 예산 | 1500ms (`OPS_AGENT_HOOK_BUDGET_MS` 로 덮어쓴다) |
| 하위 프로세스 타임아웃 | 남은 예산 안에서만 준다 |
| 예산 초과 시 | 판정을 포기하고 통과시키되, 검사되지 않았다는 사실을 stderr 로 남긴다 |

하위 프로세스 타임아웃을 예산에 종속시키는 이유는 합이 예산을 넘던 구간이 있었기 때문이다. 각 호출이 제 시간을 지켜도 훅 전체가 잘린다.

예산을 1500ms 로 둔 근거는 실측이다. 정상 경로 전체가 37ms 이고 그중 노드 기동이 35ms 다. git 호출은 각 11ms 다. 예산은 그 40배이므로 정상 판정을 자르지 않는다.

**미검사 통과를 통과와 같은 모양으로 두지 않는다.** 예산을 넘기는 상황은 검사 대상이 커서가 아니라 머신 경합이나 입력 지연 쪽이고, 그때 조용히 넘어가면 가드가 있었는지 없었는지 뒤에서 알 수 없다.

## 플러그인 자체 관리

SessionStart 훅이 플러그인 캐시 상태를 확인해 자동 복구합니다.

| 기능 | 동작 |
|------|------|
| git 자동 복원 | `.git` 없으면 자동 init + fetch |
| 버전 자동 동기화 | VERSION ↔ 캐시 디렉토리명 불일치 시 자동 갱신 |
| git identity 자동 설정 | 플러그인 리모트 호스트의 provider identity 로 자동 설정 |
| 구버전 정리 | 캐시 내 이전 버전 디렉토리 자동 삭제 |
