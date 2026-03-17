# Issue Skill

이슈 생성 및 브랜치 세팅 워크플로우

## 트리거

- "이슈", "issue"

## 워크플로우

1. 이슈 제목 및 내용 파악 (사용자에게 질문)
2. 현재 provider 확인
3. provider 정의에 따라 라벨/태그 매핑
4. 이슈 본문 작성 (provider의 본문 템플릿 사용)
5. provider의 이슈 생성 API/명령 실행
6. 브랜치 생성 (provider의 브랜치 패턴 사용):
   - **워크트리 (권장)**: `git worktree add ../{프로젝트}-{타입}-{번호} -b {브랜치명}`
   - **직접 체크아웃**: uncommitted changes 확인 → base 브랜치 pull → 새 브랜치 생성

## Provider 연동

이슈 생성의 구체적 동작은 provider에 위임한다:

| 항목 | provider에서 참조 |
|------|-------------------|
| 이슈 생성 API | `Issue Lifecycle > create` |
| 라벨/태그 매핑 | `Issue Lifecycle > create > 라벨 매핑` |
| 본문 템플릿 | `Issue Lifecycle > create > 본문 템플릿` |
| 브랜치 패턴 | `Issue Lifecycle > start > 브랜치 패턴` |
| 기본 태그/CC | `Extensions` (있으면 적용) |

provider가 감지되지 않으면 기본 내장 provider (`providers/github.md`)를 사용한다.

## 규칙

- 이슈 생성은 사용자 승인 후에만
- provider 정의에 라벨 자동 생성이 있으면 실행
- 브랜치 생성 후 자동 체크아웃
