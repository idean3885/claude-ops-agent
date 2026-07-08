# 대외비 가드

퍼블릭 리모트(공개 GitHub 레포 등)에 텍스트가 기록되기 직전 반드시 통과해야 하는 검증 게이트.

## 적용 대상

다음 명령/API는 **공개 표면**에 텍스트를 기록한다. 실행 전 가드 필수.

- `gh issue create`, `gh issue edit`, `gh issue comment`
- `gh pr create`, `gh pr edit`, `gh pr comment`, `gh pr review`
- `gh release create`, `gh release edit`
- `git commit -m`, `git commit --amend` (퍼블릭 리모트 대상 브랜치)
- `git push` (커밋 메시지가 공개됨)

검증 대상 텍스트:
- `--body`, `--body-file`, `--title`, `-m` 옵션 값
- 스테이징된 파일 내용 자체도 노출됨 (단, 파일 대외비는 별도 리뷰 영역)

## 키워드 소스

### 1. 기본 패턴 (플러그인 내장)

플러그인 공개 레포에는 **조직 특화 용어를 하드코딩하지 않는다**. 내장 패턴은 일반 원칙만 다룬다.

- 내부 식별자 변수명: `pageId`, `wikiId`, `driveId` 등 숫자형 ID 필드
- 민감 토큰 패턴: API 키, OAuth 토큰 (GitGuardian 등 기존 도구가 담당)
- 내부 도메인: provider 정의(`hostPattern` 외) 기준

### 2. 로컬 오버라이드 (조직/레포 특화)

조직/레포별 대외비 용어는 사용자 로컬 설정에서 주입:

- 경로: `~/.claude/ops-agent/confidential-keywords.local.json`
- 형식:
  ```json
  {
    "keywords": ["키워드1", "키워드2"],
    "patterns": ["^내부식별자\\d+$"]
  }
  ```
- Git 무시 대상: 로컬 전용, 공개 레포에 올라가지 않음
- 예시 템플릿은 `templates/confidential-keywords.example.json` 참고

### 3. 레포별 CLAUDE.md

레포별 고유 용어는 해당 레포의 `CLAUDE.md`에 "대외비 키워드" 섹션으로 명시. AI가 작업 시 반드시 참조.

## 검증 절차

1. **수집**: 공개 표면 대상 텍스트 전체 (제목/본문/코멘트 모두)
2. **스캔**: 로컬 키워드 리스트 + 기본 패턴으로 매칭
3. **히트 처리**:
   - 히트 없음 → 통과
   - 히트 있음 → **하드 차단**: 히트 위치·원문 사용자에게 표시, 정정 요청
4. **재검증**: 정정 후 1~3 반복

## 드라이런 모드

환경변수 `OPS_AGENT_CONFIDENTIAL_DRYRUN=1` 설정 시 차단 대신 경고만 출력. 키워드 리스트 배포 전 검증, 오탐 확인용.

## 우선순위

이 가드는 `/flow`의 모든 GATE보다 앞선다 (GATE 0). 플랜 승인·커밋 승인 전에 대외비 검증이 선행된다.

## 훅 통합

`scripts/pre-tool-use.mjs`가 Bash 도구 호출을 인터셉트하여 위 적용 대상 명령의 본문을 자동 스캔한다. 히트 시 `permissionDecision: deny`로 차단.

가이드 단계(이슈/커밋/PR)에서의 "검증" 항목은 훅이 실패했을 때의 백업이자, 텍스트 생성 단계에서부터 키워드를 피하도록 유도하는 역할이다.

## 실패 사례 (참고)

초기 버전에서는 `issue.md`에 검증 단계가 누락되어, 사용자 입력의 내부 용어가 공개 이슈 본문으로 유입되는 장애가 발생. 4층 방어선(가이드 + 참조 문서 + 훅 + 로컬 키워드)으로 재발 방지 구조 확립.
