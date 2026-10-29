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
