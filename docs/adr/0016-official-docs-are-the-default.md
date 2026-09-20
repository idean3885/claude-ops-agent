# ADR-0016: 도구 구성은 공식 문서를 기본값으로 삼는다

- 상태: accepted
- 일시: 2026-09-20
- 관련: 이슈 #507, ADR-0013(컴팩트는 결론이 아니라 재료를 보존한다), `CLAUDE.md` 「검증」

## 배경

전역 CLAUDE.md 에 규칙 조각이 12.5KB(어림 3.6k 토큰) 쌓였다. 디렉토리와 무관하게 모든 세션이 그 양을 시작 시 싣는다. 공식 [Best practices](https://code.claude.com/docs/en/best-practices) 는 반대 방향이다.

> CLAUDE.md is loaded every session, so only include things that apply broadly. For domain knowledge or workflows that are only relevant sometimes, use skills instead.

> For each line, ask: "Would removing this cause Claude to make mistakes?" If not, cut it. Bloated CLAUDE.md files cause Claude to ignore your actual instructions!

> The over-specified CLAUDE.md. If your CLAUDE.md is too long, Claude ignores half of it because important rules get lost in the noise. Fix: Ruthlessly prune. If Claude already does something correctly without the instruction, delete it or convert it to a hook.

> Use hooks for actions that must happen every time with zero exceptions.

스킬은 [Skills](https://code.claude.com/docs/en/skills) 문서가 수치를 준다. `SKILL.md` 는 500줄 이내, `description` 과 `when_to_use` 의 합은 1,536자에서 잘리며 매 턴 실린다, 본문은 호출될 때만 로드되고 참조 파일은 읽을 때만 실린다.

구조를 정할 때 이 문장들을 먼저 찾지 않고 개인 판단으로 갔다. 그렇게 정한 항목이 나중에 원문과 대조되어 뒤집히는 일이 반복됐다. 판단의 출처가 한 사람이면 그 사람이 흔들릴 때 구조가 함께 흔들린다.

## 결정

### 1. 공식 문서가 기본값이다

CLAUDE.md 조각 · 스킬 · 훅 · 서브에이전트의 구조를 정할 때 `code.claude.com/docs` 의 문장을 먼저 찾아 그대로 따른다. 권고가 있는 자리에서 개인 판단은 출발점이 아니다. 「왜 이렇게 하지」는 따른 뒤에 묻는다.

### 2. 벗어날 때는 ADR 이고 판정 기준은 공식 문장이다

권고와 다르게 가려면 ADR 하나를 쓰고 「기각한 대안」 표에 그 공식 문장을 인용한 뒤 반박을 적는다.

이 분야의 전문가 프로파일은 `experts/` 에 만들지 않는다. 판정 기준이 문서 문장 그대로라 프로파일은 그 문장을 사람 말투로 다시 쓰는 것이고, 인용이 더 강하다. 같은 반박이 두 번 이상 같은 모양으로 나오면 그때 프로파일을 검토한다.

### 3. 이번 점검 결과

세 대상을 공식 문장과 대조했다.

| 대상 | 공식 기준 | 실측 | 조치 |
|------|-----------|------|------|
| `config/global-md/base.md` | 줄마다 「지우면 실수하는가」 | 69줄 · 4,925B. 절 6개 중 3개가 훅 · 스킬 · 레포 문서가 이미 하는 일 | 아래 표대로 |
| 스킬 12개 | `SKILL.md` 500줄 이내, description 1,536자 이내 | 최대 400줄(`org-flow`), description 최대 323자 | 없음 |
| 훅 10개 | 매번 일어나야 하는 것은 훅 | CLAUDE.md 가 「매번」이라 적은 것(대외비 가드 · 한시 권한 · 머지 동거 차단 · 편집 후 교정 · 표현 가드 · 규칙 미러)이 모두 훅에 있다. 훅이 사람의 판정을 대신하는 자리는 없다. 게이트는 사람이 열기 전까지 막을 뿐이다 | 없음 |

`base.md` 절별 판정.

| 절 | 지우면 실수하는가 | 조치 |
|----|-------------------|------|
| 자연어 라우팅 정책 | 아니다. SessionStart 훅이 트리거 표를 매 세션 넣는다 | 삭제 |
| 규칙 파일 표 11행 | 아니다. `lint`·`write` 스킬이 그 파일을 직접 가리킨다 | `config/style-rules/README.md` 로 옮기고 조각에는 원천 · 미러 · 고치는 자리 세 줄 |
| 표현 가드 훅 동작 표 | 아니다. 훅이 스스로 돌고 위반을 통지한다 | 삭제. 상세는 `docs/hooks-config.md` |
| 어시스턴트 발화 분량 | 그렇다. 모든 응답에 적용되고 훅으로 대신할 수 없다 | 유지 |
| 외부 서비스 인증 | 부분. 정적 토큰 기본값 금지와 「브라우저 동의 명령은 사용자가 실행」만 항시 | 한 단락으로 줄이고 나머지는 `docs/external-auth.md` |
| ops-agent 개발 룰 | 부분. 어느 디렉토리에서든 이 레포에 이슈 · PR 을 내므로 경로와 반영 경로는 항시 | 경로 · 반영 경로 · 금지 둘만 남긴다 |

## 기각한 대안

| 대안 | 기각 이유 |
|------|-----------|
| 에이전트 구성 전문가 프로파일 신설 | 판정 기준이 공식 문장 그대로다. 프로파일은 문장을 다시 쓰는 것이고 인용보다 약하다 |
| 권고 문장을 조각에 옮겨 적기 | 권고 자체가 링크하고 옮겨 적지 말라고 한다(Exclude 열 「Detailed API documentation (link to docs instead)」). 옮기면 조각이 다시 커진다 |
| 전역 조각을 전부 스킬로 | 항시 규칙에는 트리거가 없다. 발화 분량은 Include 열의 「Repository etiquette」·「Common gotchas」 자리다 |
| 점검 결과를 `docs/lessons.md` 에 한 줄 | 그 파일은 레슨런 절차의 규약이고 실제 레슨런은 소비 프로젝트가 채운다. 이 결정은 규약이 아니라 결정이므로 ADR 자리다 |

## 대가

공식 문서가 바뀌면 기본값이 따라 바뀐다. 어느 문장을 따랐는지 잃지 않도록 인용문을 그대로 적었다.

라우팅 절을 지웠으므로 SessionStart 훅이 실패하면 트리거 표가 사라진다. 훅 실패는 터미널에 찍히고, 같은 시점에 도는 다른 훅이 있어 실패가 눈에 띈다.

파일 표를 옮기면서 전역 조각을 읽는 사람이 규칙 파일 목록을 한 번에 보지 못한다. 목록은 `config/style-rules/README.md` 한 곳에 있다.

## 다시 열어야 하는 조건

| 조건 | 다시 볼 것 |
|------|-----------|
| 공식 문서가 CLAUDE.md · 스킬 · 훅의 경계를 바꾼다 | 결정 1 의 인용문과 결정 3 의 표 |
| 같은 반박이 두 번 같은 모양으로 나온다 | 결정 2 의 프로파일 미신설 |
| 지운 절이 하던 일을 훅이 못 한다 | 결정 3 의 삭제 항목 |
