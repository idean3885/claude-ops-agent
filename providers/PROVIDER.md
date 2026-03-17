# Provider Template

이슈 플로우에 사용할 이슈 트래커 provider를 정의하는 템플릿입니다.
`~/.claude/devex/providers/{name}.md` 에 이 템플릿을 기반으로 작성합니다.

## Required

| 항목 | 설명 | 예시 |
|------|------|------|
| name | provider 식별자 | "my-tracker" |
| hostPattern | git remote host 매칭 패턴 | "tracker.company.com" |
| auth | 인증 방식 | `{ type: "env", key: "TRACKER_TOKEN", location: "~/.claude/devex/.env" }` |

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
- 브랜치 패턴 (예: `feature/{number}`)
- 시작 시 추가 동작 (타임스탬프 기록 등)

### complete
- 완료 상태 변경 API
- 결과 기록 형식
- 소요 시간 기록 방법
- 브랜치 정리 규칙

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

1. 이 템플릿을 복사하여 `~/.claude/devex/providers/{name}.md` 로 저장
2. 필수 항목과 Issue Lifecycle 섹션을 채움
3. 인증 토큰을 `~/.claude/devex/.env` 에 추가
4. 필요 시 `~/.claude/devex/overlays/{hostPattern}.json` 에 프로젝트별 설정 추가
5. `/reload-plugins` 로 반영
