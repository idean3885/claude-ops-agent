# Issue Skill

이슈 생애주기 관리 - 생성, 시작, 완료

## 트리거

- "이슈", "issue"

## Provider 참조 (필수)

**모든 API 호출 전에 반드시 provider 정의 파일을 읽어야 한다.**

1. 로컬 provider 확인: `~/.claude/devex/providers/` 에서 현재 host와 매칭되는 `.md` 파일
2. 내장 provider 확인: 플러그인 `providers/` 디렉토리
3. 기본값: `providers/github.md`

**금지사항:**
- provider 파일을 읽지 않고 API를 호출하는 행위
- 인증 헤더, endpoint, HTTP method를 추측하는 행위
- provider에 정의된 것과 다른 방식으로 API를 호출하는 행위

provider 파일에 인증 방식, API endpoint, request body 형식, 필드 보존 규칙이 모두 정의되어 있다.
**반드시 provider 파일의 정의를 그대로 따라야 한다.**

## 서브커맨드

### `/issue create`

이슈를 생성한다.

**워크플로우**:
1. provider 정의 파일 읽기 (필수)
2. 이슈 제목 및 내용 파악 (사용자에게 질문)
3. **상위-하위 관계 체크** (필수):
   - 상위 이슈가 존재하는지 확인 (사용자에게 질문 또는 컨텍스트에서 파악)
   - 상위 이슈가 있으면 `parentPostId`를 포함하여 하위 이슈로 생성
   - 기존 이슈 조회 시 상위 판단은 API 응답의 `parent` 객체 사용 (`parent.id`, `parent.number`, `parent.subject`)
   - 상위 이슈가 없으면 독립 이슈로 생성
4. provider 정의에 따라 라벨/태그 매핑
5. 이슈 본문 작성 (provider의 본문 템플릿 사용)
6. provider의 이슈 생성 API/명령 실행 (provider에 정의된 인증·endpoint·body 그대로 사용)
7. **Extensions 실행**: provider에 post-create Extensions이 정의되어 있으면 실행

### `/issue start`

이슈 작업을 시작한다. 이슈 번호 또는 URL을 인자로 받는다.

**워크플로우**:
1. provider 정의 파일 읽기 (필수)
2. 이슈 식별 (번호, URL, 또는 사용자에게 질문)
3. provider의 상태 변경 API로 "진행 중" 전환 (provider의 dedicated API 사용)
4. 담당자 설정 (provider의 assignee 설정)
5. 시작 일시 기록 (본문에 추가, 기존 필드 보존)
6. **코드 작업 여부 확인**: "코드 작업이 필요한 이슈입니까?"
   - **Yes**: provider의 브랜치 패턴으로 브랜치 생성 (반드시 `origin/{base}`에서 분기)
     - 워크트리 (권장): `git fetch origin && git worktree add ../{프로젝트}-{타입}-{번호} -b {브랜치명} origin/{base}`
     - 직접 체크아웃: `git fetch origin && git checkout -b {브랜치명} origin/{base}`
   - **No**: 브랜치 생성 스킵
7. **Extensions 실행**: provider에 post-start Extensions이 정의되어 있으면 실행

### `/issue complete`

이슈를 완료 처리한다. 이슈 번호 또는 URL을 인자로 받는다.

**워크플로우**:
1. provider 정의 파일 읽기 (필수)
2. 이슈 식별 (번호, URL, 또는 사용자에게 질문)
3. 작업 결과 정리:
   - 사용자에게 작업 결과 요약 질문
   - provider의 완료 기록 형식에 따라 본문에 "작업 결과" 섹션 추가
4. 소요 시간 기록:
   - 시작 일시 ~ 현재 기준으로 실 작업 시간 계산
   - 점심(1h), 주말/공휴일 제외
   - 정수 올림, 일별 분배 형식 (예: `소요 시간: 8h (03/17 4h + 03/18 4h)`)
5. provider의 완료 상태 변경 API 실행 (provider의 dedicated API 사용)
6. 본문 업데이트 (provider의 PUT API, 기존 cc·태그·본문 보존 필수)
7. 브랜치가 있었으면 정리, 없었으면 스킵
8. workflow.json의 `currentIssues` 맵에서 현재 브랜치 항목 제거 (`del currentIssues[branch]`)
9. **Extensions 실행**: provider에 post-complete Extensions이 정의되어 있으면 실행

## Provider 연동 상세

이슈 생애주기의 구체적 동작은 provider에 위임한다:

| 항목 | provider에서 참조 |
|------|-------------------|
| 인증 헤더 | `Authentication` 섹션 |
| 이슈 생성 API | `Issue Lifecycle > create` |
| 라벨/태그 매핑 | `Issue Lifecycle > create > 라벨 매핑` |
| 본문 템플릿 | `Issue Lifecycle > create > 본문 템플릿` |
| 상태 변경 (dedicated API) | `Issue Lifecycle > start/complete > Workflow Change` |
| 본문 업데이트 (PUT) | `Issue Lifecycle > start/complete > Update` |
| 필드 보존 규칙 | `Known Bugs` 섹션 |
| 브랜치 패턴 | `Branch Pattern` 섹션 |
| 완료 기록 형식 | `Issue Lifecycle > complete > 결과 기록 형식` |
| 소요 시간 형식 | `Issue Lifecycle > complete > 소요 시간 기록 방법` |
| 기본 태그/CC | `Extensions` (있으면 적용) |
| post-action 확장 | `Extensions` (있으면 실행) |

## 규칙

- **provider 파일을 먼저 읽지 않으면 어떤 API도 호출하지 않는다**
- 이슈 생성/상태 변경은 사용자 승인 후에만
- 브랜치 생성은 코드 작업 이슈에서만 (사용자 확인)
- provider 정의에 라벨 자동 생성이 있으면 실행
- 완료 시 소요 시간은 정수 올림 (8h 초과 허용)
- 본문 업데이트 시 기존 cc, 태그, 본문 내용을 반드시 보존한다
