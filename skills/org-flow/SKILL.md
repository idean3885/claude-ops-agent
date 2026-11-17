---
name: org-flow
description: flow 로 합쳐진 옛 진입점. 여러 레포 작업과 조직 매니페스트는 flow 의 여러 레포 가이드가 맡는다. 이 스킬은 옛 이름으로 들어온 요청을 flow 로 넘기는 안내만 둔다.
---

# org-flow (flow 로 합쳐짐)

이슈 플로우의 진입점은 flow 하나다 ([ADR-0042](../../docs/adr/0042-one-issue-flow-entry.md)). 이 이름으로 들어온 요청은 flow 로 진행한다.

| 옛 서브커맨드 | 지금 자리 |
|---------------|-----------|
| 셋업 · 매니페스트 · provider 지정 | [flow 여러 레포 가이드 「매니페스트」 · 「셋업」](../flow/guides/multi-repo.md#매니페스트) |
| `start` | flow issue 가이드 「/issue start」 → [여러 레포 가이드 「시작」](../flow/guides/multi-repo.md#시작) |
| `submit` | flow commit · PR 가이드 → [여러 레포 가이드 「제출」](../flow/guides/multi-repo.md#제출) |
| `finish` | flow issue 가이드 「/issue complete」 → [여러 레포 가이드 「완료」](../flow/guides/multi-repo.md#완료) |

`status` 서브커맨드, 파이프라인 단계 추적, 프로젝트 로컬 확장 경로, 제출 때의 레포 간 계약 대조는 옮기지 않았다 (ADR-0042 결정 3).

이 스킬은 외부 확장이 진입 계약을 flow 로 옮긴 뒤 지운다.
