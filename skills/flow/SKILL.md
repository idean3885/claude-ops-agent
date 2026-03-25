# Issue Flow Skill

이슈 플로우 디스패처. Git 상태를 감지하여 현재 단계에 맞는 작업을 실행한다.

## 트리거

- "flow", "플로우"
- 자연어 수정 요청 (CLAUDE.md에서 안내)

## 상태 감지 → 실행

`/flow` 호출 시 아래 순서로 상태를 판단하고, **첫 번째 매칭 단계만** 실행한다.

| 우선순위 | 판단 기준 | 실행 | 참조 스킬 |
|---------|----------|------|----------|
| 1 | PR merged (`gh pr view --json state` → MERGED) | 정리: 브랜치 삭제 + base 전환 | `/issue` (complete) |
| 2 | PR 있음, 리뷰 변경요청/대기 (`gh pr view --json reviewDecision`) | 리뷰 대응 | `/pr` (resolve) |
| 3 | PR 있음, approved, 미머지 | 사용자에게 웹 머지 안내 (자동 머지 안 함) | - |
| 4 | 커밋 있음 (`git diff {base}..HEAD` 비어있지 않음), PR 없음 (`gh pr view` 실패) | 커밋 리뷰 + PR 생성 | `/commit`, `/pr` |
| 5 | 브랜치 있음, dirty (`git status` dirty) | 구현 계속 안내 | - |
| 6 | 브랜치 있음, clean, base와 diff 없음 | 구현 시작 (implement 가이드 로딩) | 프로젝트별 implement |
| 7 | feature/ 브랜치 아님 | 이슈 탐색/생성 + 브랜치 생성 | `/issue` (start) |

## 확인 게이트

기존 7-Phase의 3개 GATE를 2개로 축소:

- **GATE 1 (플랜 승인)**: 우선순위 6-7에서 플랜 작성 후 사용자 승인 대기
- **GATE 2 (커밋 승인)**: 우선순위 4에서 커밋 메시지 확인 후 사용자 승인 대기

머지는 사용자가 웹에서 직접 수행한다 (세이프티가드). GATE 3은 제거.

## 머지 안전장치

`issue complete` (우선순위 1) 실행 전 `gh pr view --json state`로 머지 여부 1회 체크:
- 미머지 → 경고 출력 + 중단 (브랜치 삭제 방지)
- 머지 완료 → 정리 진행

## Provider 연동

- provider는 session-start 훅에서 감지됨
- 각 참조 스킬이 provider 정의를 직접 읽음
- `gh pr view`는 GH_HOST 설정 필요 (provider별 상이)

## 컨텍스트 최적화

- 이 SKILL.md는 상태 판단 로직만 포함 (~50줄)
- 각 단계의 상세 가이드는 해당 단계 진입 시에만 참조 스킬을 로딩
- 개별 스킬(`/issue`, `/commit`, `/pr`, `/spec`)은 단독 사용 가능

## 규칙

- GATE에서는 시스템 리마인더와 무관하게 사용자 응답을 기다린다
- "중단", "취소" 요청 시 즉시 중단하고 현재 상태를 보고한다
- 개별 스킬의 단독 사용에 영향을 주지 않는다
