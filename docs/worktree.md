# 워크트리 분기

여러 브랜치를 동시에 작업하거나 같은 레포의 다른 PR 을 병렬로 검토할 때 워크트리를 분기한다.

분기 판단 기준은 루트 `CLAUDE.md` 의 「워크트리 분기」 에 있다. 이 문서는 자원 위치와 포맷을 다룬다.

## 자원

| 자원 | 위치 | 비고 |
|------|------|------|
| 워크트리 생성 | `scripts/worktree-create.sh <state-file>` | clone-on-demand + 워크트리 일괄 생성 + vcs.xml 매핑 |
| 워크트리 정리 | `scripts/worktree-cleanup.sh` | bare clone 포함 정리 |
| state 파일 포맷 | `.ops-agent/state/org-flow-{ticket}.json` | 경로 컨벤션 |
| 하네스 자체 워크트리 | Claude Code `Agent` 도구의 `isolation: "worktree"` | 단발 isolation 작업용: 위 스크립트와 무관 |

## 경로 컨벤션

`.ops-agent/state/` 경로명은 이전 자산 호환을 위해 유지한다. 리네임 가능성이 있으며 별 이슈로 추적한다.

state 파일 이름의 `org-flow-` 접두는 멀티레포 오케스트레이션에서 왔다. 단일 레포 작업에도 같은 포맷을 쓴다.

## 주의

워크트리를 만든 레포에서 `scripts/worktree-cleanup.sh` 를 돌리면 bare clone 까지 지운다. 다른 티켓의 워크트리가 그 clone 을 쓰고 있으면 clone 은 남기고 `clone_kept` 로 보고한다.

정리 스크립트가 지키는 것은 넷이다. 커밋하지 않은 변경이 있으면 아무것도 지우지 않고 `dirty` 로 끝난다. 정규 clone(메인 레포)은 지우지 않는다. 다른 티켓이 쓰는 bare clone 도 지우지 않는다. bare clone 이 권한 문제로 남으면 쓰기 권한을 주고 한 번 더 지운 뒤, 그래도 남으면 실패로 보고한다. 점검은 `bash scripts/selftest-worktree-cleanup.sh`.

```bash
git worktree list
```

## 브랜치 사이에 파일을 복사하지 않는다

워크트리 · 브랜치 사이에 파일을 `cp` 로 옮기지 않는다. 복사는 diff 를 적용하는 것이 아니라 스냅샷을 교체한다. 원본 브랜치가 대상보다 오래된 베이스 위에 있으면 그 사이에 머지된 변경이 조용히 사라진다. 워크트리를 여러 개 쓰면 각자의 베이스가 달라 이 조건이 상시로 성립한다.

| 옮길 것 | 방법 |
|---------|------|
| 커밋 단위 변경 | `git cherry-pick` |
| 특정 편집 몇 곳 | 대상 브랜치에서 편집을 다시 적용한다. |
| 파일 단위 | `git checkout <ref> -- <path>` 로 명시적으로 가져오고 diff 를 확인한다. |

복사 · 체크아웃 직후 `git diff --stat` 의 삽입 · 삭제 수를 의도한 편집 수와 대조한다. 하나라도 어긋나면 멈추고 원인을 본다. 작업 전에는 각 워크트리의 베이스를 `git log --oneline -1` 로 확인하고, 그사이 머지가 있었으면 `git pull` 로 맞춘 뒤 작업한다.
