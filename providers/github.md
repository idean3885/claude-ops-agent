# Provider: github

GitHub Issues + Pull Requests 기반 이슈 플로우 provider.
ops-agent 기본 내장 provider입니다.

## Required

- **name**: github
- **hostPattern**: github.com
- **auth**: `{ type: "cli", tool: "gh", setup: "gh auth login" }`

## Issue Lifecycle

### create

**도구**: `scripts/gh-issue.sh create` (어댑터. 계약은 [PROVIDER.md](PROVIDER.md) 「어댑터 계약」)

```bash
bash ~/.claude/ops-agent/current/scripts/gh-issue.sh create --title "{제목}" --body-file {본문.md} --type {feat|fix|docs|refactor|chore} \
  (--start [--worktree|--checkout] [--base {브랜치}] [--branch {이름}] | --no-start "{사유}") [-R {owner/repo}] [--structure {iss1|iss5|iss6|iss7}]
```

어댑터가 본문 구조 검사(`scripts/issue-body-rules.mjs`) → 라벨 보장 → `gh issue create --label {타입}` → `--start` 면 start 를 이어서 한다. 구조 기본값은 `fix` → ISS1, 그 외 → ISS5. `gh issue create` 직접 호출은 훅이 거부한다. 출력은 JSON 한 줄(`status` · `number` · `url` · `start`).

**라벨 매핑**:
| 키워드 | 라벨 | 브랜치 접두사 | 색상 |
|--------|------|---------------|------|
| 기능, feat | `feat` | `feat/` | `0E8A16` |
| 버그, fix | `fix` | `fix/` | `d73a4a` |
| 문서, docs | `docs` | `docs/` | `0075ca` |
| 리팩토링 | `refactor` | `refactor/` | `e4e669` |
| 기타 | `chore` | `chore/` | `ededed` |

**라벨 자동 생성**:
```bash
gh label list --json name --jq '.[].name' | grep -q "^${라벨}$" || gh label create "${라벨}" --color "${색상}"
```

**본문 템플릿** (`config/style-rules/extensions/issue.md` 「필수 구조」 절. 기능 · 운영은 ISS5, 버그는 ISS1):
```markdown
## What
{도메인 수준 한 줄}

## Why
- {배경 사실}
- {배경 사실}
- 기존 기록: {이전 · 지금 · 바뀐 점 | 없음 · 찾은 자리}
```

**이슈 검색** (기존 이슈 탐색):
```bash
gh issue list --state open --search "{키워드}" --json number,title,labels --limit 10
```

### start

**도구**: `scripts/gh-issue.sh start` (어댑터)

```bash
bash ~/.claude/ops-agent/current/scripts/gh-issue.sh start {이슈번호} [--type {타입}] [-R {owner/repo}] [--worktree|--checkout] [--base {브랜치}] [--branch {이름}]
```

**상태**: GitHub Issues는 별도 상태 전환 API 없음 (open 상태 유지)

**담당자 설정**: 어댑터가 `gh issue edit {이슈번호} --add-assignee @me`

**시작 기록**: 어댑터가 이슈 코멘트로 `작업 시작: {시작일시}`

**타입**: `--type` 이 없으면 이슈의 타입 라벨(feat · fix · docs · refactor · chore)에서 읽는다. 하나가 아니면 종료 코드 1

**브랜치 생성** (코드 작업 이슈만. `--worktree` 또는 `--checkout` 을 줄 때):
- 브랜치 패턴: `{타입}/{이슈번호}`. `--branch` 로 덮는다.
- 이슈 내용은 변경될 수 있으므로 설명은 붙이지 않는다.
- 어댑터가 `gh issue develop {번호} --name {브랜치} --base {base}` 로 이슈에 연결된 브랜치를 원격에 만들고, `git fetch origin` 뒤 그 브랜치를 연다. 브랜치 이름만으로는 이슈와 연결되지 않는다 (#813).
- **워크트리 (권장)**: `--worktree` → `git worktree add ../{프로젝트}-{타입}-{번호} -b {브랜치} --track origin/{브랜치}`
- **직접 체크아웃**: `--checkout` → `git checkout -b {브랜치} --track origin/{브랜치}`
- 연결된 브랜치의 PR 은 이슈에 자동 연결되고, 기본 브랜치에 머지되면 이슈가 닫힌다. PR 이 여러 개인 이슈는 브랜치 인자 없이 `start` 하고, 앞 PR 의 브랜치는 직접 분기해 본문에 `Refs #{이슈번호}` 를 단다. 마지막 PR 의 브랜치만 `gh issue develop {번호} --name {브랜치} --base {base}` 로 만들고 fetch 뒤 추적 브랜치로 연다 (`skills/flow/guides/issue.md` 「/issue start」 5번).

### complete

#### 코드 작업 이슈 (브랜치 있음)

**PR 생성**: `gh pr create --draft`

PR 은 초안으로 생성한다. 작성자가 렌더된 변경분을 웹에서 먼저 보고, 리뷰어를 부를 시점을 직접 정한다.

**준비 완료 전환**: `gh pr ready {PR번호}`

전환과 리뷰 요청은 작성자가 한다 ([PR 가이드](../skills/flow/guides/pr.md#초안으로-생성하고-작성자가-먼저-본다)).

**타겟 브랜치 결정**:
```bash
gh pr list --state merged --limit 10 --json baseRefName --jq '.[].baseRefName' | sort | uniq -c | sort -rn
```
- 가장 많이 사용된 브랜치를 기본값으로 제안
- 반드시 사용자에게 확인 후 진행

**PR 본문 템플릿** (단일·복수 커밋 공통). 이슈 연결은 위 브랜치 생성이 맡아 본문에 링크를 두지 않는다:
```markdown

## What
- 도메인 행위·사용자 가치 (so-what — 그래서 무엇이 달라지나)

## Why
- 배경·결정 사유·트레이드오프 (필요 시)

## How (선택 · 최하단)
- 구현 접근 요약. 클래스·yaml 키·파일 경로 등 기법은 여기에만.
```
> 규칙 (상세: `skills/flow/guides/pr.md`):
> - GitHub Issues 레포는 이슈에서 만든 브랜치가 PR 을 이슈에 연결한다. 본문 첫 줄 링크와 `Closes #` 를 두지 않는다. 같은 이슈의 앞 PR 만 `Refs #{이슈번호}` 를 단다.
> - 외부 트래커를 쓰는 레포(GHE 등)는 첫 줄에 이슈/티켓 링크를 두고 `Closes` 를 쓰지 않는다.
> - **자가 검증 표·변경 파일 표·커밋 내역 표는 넣지 않는다** (CI·`Files changed`·git log 에 이미 표시).

**PR 머지 + 정리**: 머지 전 `final-check.sh` 통과 기록이 있어야 한다 (`skills/flow/guides/pr.md` 「머지 전 최종 점검과 상황 보고」). 업무 · 사상 유형 레포는 사람이 웹에서 병합하고 아래는 정리만 한다. 저장소 유형 레포만 어시스턴트가 병합한다.
```bash
gh pr merge {PR번호} --merge --match-head-commit {HEAD}   # 저장소 유형만
git checkout {타겟브랜치} && git pull
```
워크트리 사용 시: `git worktree remove ../{워크트리 경로}`

#### 코드 없는 이슈 (브랜치 없음)

**이슈 닫기**:
```bash
gh issue close {이슈번호} --comment "## 작업 결과\n{결과 요약}"
```

## Git Identity

커밋/푸시 시 사용할 git 계정.
크리덴셜(gh auth) 계정과 일치해야 한다.

| Field | Value |
|-------|-------|
| user.name | `idean3885` |
| user.email | `dykimDev3885@gmail.com` |

## Extensions

(GitHub 기본 provider는 별도 확장 없음)
