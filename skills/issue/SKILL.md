# Issue Skill

이슈 생애주기 관리 — 생성, 시작, 완료

## 트리거

- "이슈", "issue"

## 서브커맨드

### `/issue create`

이슈를 생성한다.

**워크플로우**:
1. 이슈 제목 및 내용 파악 (사용자에게 질문)
2. 현재 provider 확인
3. provider 정의에 따라 라벨/태그 매핑
4. 이슈 본문 작성 (provider의 본문 템플릿 사용)
5. provider의 이슈 생성 API/명령 실행

### `/issue start`

이슈 작업을 시작한다. 이슈 번호 또는 URL을 인자로 받는다.

**워크플로우**:
1. 이슈 식별 (번호, URL, 또는 사용자에게 질문)
2. provider의 상태 변경 API로 "진행 중" 전환
3. 담당자 설정 (provider의 assignee 설정)
4. 시작 일시 기록 (본문에 추가)
5. **코드 작업 여부 확인**: "코드 작업이 필요한 이슈입니까?"
   - **Yes**: provider의 브랜치 패턴으로 브랜치 생성
     - 워크트리 (권장): `git worktree add ../{프로젝트}-{타입}-{번호} -b {브랜치명}`
     - 직접 체크아웃: base 브랜치 pull → 새 브랜치 생성
   - **No**: 브랜치 생성 스킵
6. Extensions 실행 (dailylog 연동 등, 있으면)

### `/issue complete`

이슈를 완료 처리한다. 이슈 번호 또는 URL을 인자로 받는다.

**워크플로우**:
1. 이슈 식별 (번호, URL, 또는 사용자에게 질문)
2. 작업 결과 정리:
   - 사용자에게 작업 결과 요약 질문
   - provider의 완료 기록 형식에 따라 본문에 "작업 결과" 섹션 추가
3. 소요 시간 기록:
   - 시작 일시 ~ 현재 기준으로 실 작업 시간 계산
   - 점심(1h), 주말/공휴일 제외
   - 정수 올림, 일별 분배 형식 (예: `소요 시간: 8h (03/17 4h + 03/18 4h)`)
4. provider의 완료 상태 변경 API 실행
5. 브랜치가 있었으면 정리 (머지/삭제), 없었으면 스킵
6. Extensions 실행 (dailylog 완료 처리 등, 있으면)

## Provider 연동

이슈 생애주기의 구체적 동작은 provider에 위임한다:

| 항목 | provider에서 참조 |
|------|-------------------|
| 이슈 생성 API | `Issue Lifecycle > create` |
| 라벨/태그 매핑 | `Issue Lifecycle > create > 라벨 매핑` |
| 본문 템플릿 | `Issue Lifecycle > create > 본문 템플릿` |
| 상태 변경 | `Issue Lifecycle > start`, `Issue Lifecycle > complete` |
| 브랜치 패턴 | `Issue Lifecycle > start > 브랜치 패턴` |
| 완료 기록 형식 | `Issue Lifecycle > complete > 결과 기록 형식` |
| 소요 시간 형식 | `Issue Lifecycle > complete > 소요 시간 기록 방법` |
| 기본 태그/CC | `Extensions` (있으면 적용) |
| dailylog 등 확장 | `Extensions` (있으면 실행) |

provider가 감지되지 않으면 기본 내장 provider (`providers/github.md`)를 사용한다.

## 규칙

- 이슈 생성/상태 변경은 사용자 승인 후에만
- 브랜치 생성은 코드 작업 이슈에서만 (사용자 확인)
- provider 정의에 라벨 자동 생성이 있으면 실행
- 완료 시 소요 시간은 정수 올림 (8h 초과 허용)
