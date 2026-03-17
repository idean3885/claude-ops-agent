# Provider: github

GitHub Issues + Pull Requests 기반 이슈 플로우 provider.
devex 기본 내장 provider입니다.

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

**브랜치 패턴**: `{타입}/{이슈번호}`
> 이슈 내용은 변경될 수 있으므로 설명은 붙이지 않는다.

**브랜치 생성 방식**:
- **워크트리 (권장)**: `git worktree add ../{프로젝트}-{타입}-{번호} -b {타입}/{번호}`
- **직접 체크아웃**: `git checkout main && git pull && git checkout -b {타입}/{번호}`

### complete

**PR 생성**: `gh pr create`

**타겟 브랜치 결정**:
```bash
gh pr list --state merged --limit 10 --json baseRefName --jq '.[].baseRefName' | sort | uniq -c | sort -rn
```
- 가장 많이 사용된 브랜치를 기본값으로 제안
- 반드시 사용자에게 확인 후 진행

**PR 본문 템플릿 (단일 커밋)**:
```markdown
## 작업 내용
{요약}

## 변경 사항
- 항목 1

## 자가 검증
| 항목 | 결과 | 비고 |
|------|------|------|
| 빌드 | ✅ 통과 / ⬜ 해당없음 | {명령어 또는 사유} |
| 테스트 | ✅ 통과 / ⬜ 해당없음 | {명령어 또는 사유} |
| 문서 동기화 | ✅ 완료 / ⬜ 해당없음 | {변경된 문서 또는 사유} |

Closes #{이슈번호}
```

**PR 본문 템플릿 (복수 커밋)**:
```markdown
## 작업 내용
{요약}

## 커밋 내역
| 커밋 | 내용 |
|------|------|
| `타입: 제목` | 작업 설명 |

## 자가 검증
| 항목 | 결과 | 비고 |
|------|------|------|
| 빌드 | ✅ 통과 / ⬜ 해당없음 | {명령어 또는 사유} |
| 테스트 | ✅ 통과 / ⬜ 해당없음 | {명령어 또는 사유} |
| 문서 동기화 | ✅ 완료 / ⬜ 해당없음 | {변경된 문서 또는 사유} |

Closes #{이슈번호}
```

**PR 머지 + 정리**:
```bash
gh pr merge {PR번호} --merge
git checkout {타겟브랜치} && git pull
```
워크트리 사용 시: `git worktree remove ../{워크트리 경로}`

## Extensions

(GitHub 기본 provider는 별도 확장 없음)
