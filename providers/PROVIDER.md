# Provider Template

이슈 플로우에 사용할 이슈 트래커 provider를 정의하는 템플릿입니다.
`~/.claude/ops-agent/providers/{name}.md` 에 이 템플릿을 기반으로 작성합니다.

## Required

| 항목 | 설명 | 예시 |
|------|------|------|
| name | provider 식별자 | "my-tracker" |
| hostPattern | git remote host 매칭 패턴 | "tracker.company.com" |
| auth | 인증 방식 | `{ type: "env", key: "TRACKER_TOKEN", location: "~/.claude/ops-agent/.env" }` |

## Issue Lifecycle

각 단계별 다음 항목을 정의합니다:

### create
- API endpoint 및 HTTP method
- 필수 필드 (제목, 본문, 담당자 등)
- 본문 템플릿
- 응답에서 이슈 ID 추출 방법

### start
- 상태 변경 API
- 담당자 설정 방법
- 브랜치 패턴 (예: `feat/{number}`)
- 시작 시 추가 동작 (타임스탬프 기록 등)

### 어댑터 계약 (create · start)

생성과 시작은 provider 가 어댑터 스크립트 하나로 제공한다. 생성 API 직접 호출은 훅이 거부한다. 경로가 하나여야 본문 규칙 · 시작 결정이 실행된다.

| 항목 | 계약 |
|------|------|
| 필수 판단 | 생성 시 `--start` \| `--no-start "<사유>"`. 둘 다 없으면 생성하지 않는다. |
| 본문 검사 | 생성 전에 `scripts/issue-body-rules.mjs` 로 구조를 검사한다. 실패하면 생성하지 않는다. |
| 종료 코드 | 0 성공 · 1 인자 · 본문 검사 실패(생성 안 됨) · 2 API 오류(생성 실패) · 3 생성됐으나 시작 실패 |
| 출력 | JSON 한 줄. 성공은 stdout, 오류는 stderr. `status`(`ok` \| `error`) · `start`(`started` \| `skipped` \| `failed`) · `reason`(`--no-start` 사유) · 식별자(키는 provider 가 정한다. github `number`) |
| 생성 뒤 실패 | 식별자를 반드시 담는다. 이슈는 남아 있으므로 start 를 다시 부른다. |

내장 github 구현은 `scripts/gh-issue.sh` 다.

### complete
- 완료 상태 변경 API
- 결과 기록 형식
- 소요 시간 기록 방법
- 브랜치 정리 규칙

## Git Identity

커밋/푸시 시 사용할 git 계정 정보.
크리덴셜(gh auth) 계정과 일치해야 한다.

| 항목 | 설명 | 예시 |
|------|------|------|
| user.name | git commit author name | "my-username" |
| user.email | git commit author email | "me@example.com" |

session-start 훅이 provider의 Git Identity를 감지하여 세션 컨텍스트에 주입한다.
커밋/푸시 전에 `git config user.name/email`이 provider 설정과 일치하는지 자동 검증한다.

## Extensions

provider별 확장 기능을 자유롭게 정의합니다.
아래는 확장 가능한 영역의 예시입니다:

| 영역 | 설명 |
|------|------|
| 일일 계획 연동 | 외부 스킬 호출을 통한 일일 계획 동기화 |
| 자동 태그 | 이슈 생성 시 기본 태그 자동 부여 |
| 기본 참조자 | 이슈 생성 시 기본 CC/참조자 |
| 마일스톤 | 기본 마일스톤 설정 |
| 담당자 | 고정 담당자 ID |
| 브랜치 패턴 | 커스텀 브랜치 네이밍 규칙 |

## 설치 방법

1. 이 템플릿을 복사하여 `~/.claude/ops-agent/providers/{name}.md` 로 저장
2. 필수 항목과 Issue Lifecycle 섹션을 채움
3. 인증 토큰을 `~/.claude/ops-agent/.env` 에 추가
4. 필요 시 `~/.claude/ops-agent/overlays/{hostPattern}.json` 에 프로젝트별 설정 추가
5. `/reload-plugins` 로 반영
