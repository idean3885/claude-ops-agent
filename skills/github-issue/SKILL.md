# GitHub Issue Skill

GitHub 이슈 생성 및 브랜치 세팅 워크플로우

## 트리거

- "이슈", "issue"

## 워크플로우

1. 이슈 제목 및 내용 파악 (사용자에게 질문)
2. 라벨 자동 매핑:
   | 키워드 | 라벨 | 브랜치 접두사 |
   |--------|------|---------------|
   | 기능, feat | `feat` | `feature/` |
   | 버그, fix | `fix` | `fix/` |
   | 문서, docs | `docs` | `docs/` |
   | 리팩토링 | `refactor` | `refactor/` |
   | 기타 | `chore` | `chore/` |
3. **라벨 존재 여부 확인 및 자동 생성**:
   ```bash
   gh label list --json name --jq '.[].name' | grep -q "^${라벨}$" || gh label create "${라벨}" --color "${색상}"
   ```
   | 라벨 | 색상 |
   |------|------|
   | `feat` | `0E8A16` |
   | `fix` | `d73a4a` |
   | `docs` | `0075ca` |
   | `refactor` | `e4e669` |
   | `chore` | `ededed` |
4. 이슈 본문 작성:
   ```
   ## 작업 내용
   {요약}

   ## 체크리스트
   - [ ] 항목 1
   - [ ] 항목 2
   ```
5. `gh issue create` 실행
6. 브랜치 생성 (사용자에게 방식 제안):
   - **워크트리 (권장)**: `git worktree add ../{프로젝트}-{타입}-{번호} -b {타입}/{번호}`
   - **직접 체크아웃**: uncommitted changes 확인 → `git checkout main && git pull` → `git checkout -b {타입}/{번호}`

## 브랜치 명명 규칙

`{타입}/{이슈번호}` — 설명은 붙이지 않는다.

| 예시 | 설명 |
|------|------|
| `feature/12` | 기능 개발 |
| `fix/15` | 버그 수정 |
| `docs/8` | 문서 작업 |
| `refactor/20` | 리팩토링 |
| `chore/25` | 기타 |

> 이슈 내용은 진행 중 변경될 수 있으므로, 브랜치명에 설명을 포함하지 않는다.

## 규칙

- 이슈 생성은 사용자 승인 후에만
- 라벨이 없으면 자동 생성
- CLAUDE.md 커밋 타입과 라벨 일치
- 브랜치 생성 후 자동 체크아웃
