# Provider: github

GitHub Issues + Pull Requests 기반 이슈 플로우 provider.
ops-agent 기본 내장 provider입니다.

## Required

- **name**: github
- **hostPattern**: github.com
- **auth**: `{ type: "cli", tool: "gh", setup: "gh auth login" }`

## Issue Lifecycle

### create

**도구**: `gh issue create`

**라벨 매핑**:
| 키워드 | 라벨 | 브랜치 접두사 | 색상 |
|--------|------|---------------|------|
| 기능, feat | `feat` | `feature/` | `0E8A16` |
| 버그, fix | `fix` | `fix/` | `d73a4a` |
| 문서, docs | `docs` | `docs/` | `0075ca` |
| 리팩토링 | `refactor` | `refactor/` | `e4e669` |
| 기타 | `chore` | `chore/` | `ededed` |

**라벨 자동 생성**:
```bash
gh label list --json name --jq '.[].name' | grep -q "^${라벨}$" || gh label create "${라벨}" --color "${색상}"
```

**본문 템플릿**:
```markdown
## 작업 내용
{요약}

## 체크리스트
- [ ] 항목 1
- [ ] 항목 2
```

**이슈 검색** (기존 이슈 탐색):
```bash
gh issue list --state open --search "{키워드}" --json number,title,labels --limit 10
```

### start

**상태**: GitHub Issues는 별도 상태 전환 API 없음 (open 상태 유지)

**담당자 설정**:
```bash
gh issue edit {이슈번호} --add-assignee @me
```

**시작 기록**: 이슈 코멘트로 시작 일시 기록
```bash
gh issue comment {이슈번호} --body "작업 시작: {시작일시}"
```

**브랜치 생성** (코드 작업 이슈만):
- 브랜치 패턴: `{타입}/{이슈번호}`
- 이슈 내용은 변경될 수 있으므로 설명은 붙이지 않는다
- **워크트리 (권장)**: `git worktree add ../{프로젝트}-{타입}-{번호} -b {타입}/{번호}`
- **직접 체크아웃**: `git checkout main && git pull && git checkout -b {타입}/{번호}`

### complete

#### 코드 작업 이슈 (브랜치 있음)

**PR 생성**: `gh pr create`

**타겟 브랜치 결정**:
```bash
gh pr list --state merged --limit 10 --json baseRefName --jq '.[].baseRefName' | sort | uniq -c | sort -rn
```
- 가장 많이 사용된 브랜치를 기본값으로 제안
- 반드시 사용자에게 확인 후 진행

**PR 본문 템플릿** (단일·복수 커밋 공통):
```markdown
{이슈/티켓 링크}

## What
- 도메인 행위·사용자 가치 (so-what — 그래서 무엇이 달라지나)

## Why
- 배경·결정 사유·트레이드오프 (필요 시)

## How (선택 · 최하단)
- 구현 접근 요약. 클래스·yaml 키·파일 경로 등 기법은 여기에만.

Closes #{이슈번호}
```
> 규칙 (상세: `skills/flow/guides/pr.md`):
> - **첫 줄 = 이슈/티켓 링크** (최상단 고정). 제목엔 URL 합치지 않는다.
> - `Closes #` 는 github.com + Issues 일 때만. GHE + 외부 트래커면 생략 — 최상단 링크로 대체.
> - **자가 검증 표·변경 파일 표·커밋 내역 표는 넣지 않는다** (CI·`Files changed`·git log 에 이미 표시).

**PR 머지 + 정리**:
```bash
gh pr merge {PR번호} --merge
git checkout {타겟브랜치} && git pull
```
워크트리 사용 시: `git worktree remove ../{워크트리 경로}`

#### 코드 없는 이슈 (브랜치 없음)

**이슈 닫기**:
```bash
gh issue close {이슈번호} --comment "## 작업 결과\n{결과 요약}\n\n소요 시간: {시간}"
```

#### 공통

**소요 시간 기록**:
- 시작 일시 ~ 현재 기준으로 실 작업 시간 계산
- 점심(1h), 주말/공휴일 제외
- 정수 올림, 일별 분배 형식 (예: `소요 시간: 8h (03/17 4h + 03/18 4h)`)

## Git Identity

커밋/푸시 시 사용할 git 계정.
크리덴셜(gh auth) 계정과 일치해야 한다.

| Field | Value |
|-------|-------|
| user.name | `idean3885` |
| user.email | `dykimDev3885@gmail.com` |

## Extensions

(GitHub 기본 provider는 별도 확장 없음)
