# 여러 레포 작업과 조직 매니페스트

이슈 하나의 작업 범위가 여러 레포에 걸치거나, 조직 매니페스트가 이슈 트래커 · 브랜치 규칙을 정할 때 읽는다. 진입점은 flow 하나이고, 레포 수는 작업 범위를 정할 때 갈리는 분기다 ([ADR-0042](../../../docs/adr/0042-one-issue-flow-entry.md)).

| 언제 | 이 가이드의 절 |
|------|----------------|
| 조직 매니페스트가 없다. | [셋업](#셋업) |
| 이슈 시작 | [시작](#시작) (issue 가이드 「/issue start」 6번에서 온다) |
| 커밋 · PR | [제출](#제출) |
| 머지 뒤 이슈 완료 | [완료](#완료) (issue 가이드 「/issue complete」 2번 뒤 · 8번에서 온다) |

이슈 생성 · 시작 · 완료는 issue 가이드가 한다. 이 가이드는 그 앞뒤에 붙는 레포별 일(범위 · 워크트리 · 정리)만 적는다.

## 매니페스트

두 파일이 합성되어 동작한다.

| 파일 | 단위 | 담는 것 |
|------|------|---------|
| 조직 매니페스트 `orgs/<org>.json` | 조직 (원격 주소의 소유자) | 이슈 트래커 지정 · 브랜치 패턴 · 표기 규칙 · 스크립트 대체 |
| 프로젝트 매니페스트 `.ops-agent/project.json` | 프로젝트 루트 | 레포 목록 · 도메인별 레포 · 워크트리 루트 |

### 조직 매니페스트를 찾는다

조직 식별은 원격 저장소 주소의 소유자 구간으로 한다. 디렉토리 이름은 클론 위치에 따라 달라지므로 전제하지 않는다. 원격이 없을 때만 디렉토리 이름으로 떨어지고, 그때는 사용자에게 확인한다.

```bash
node ~/.claude/ops-agent/current/scripts/resolve-manifest.mjs
```

| 출력 | 뜻 |
|------|-----|
| `manifests` | 발견된 매니페스트를 해석 순서대로 담은 목록 |
| `ownerSource` | `remote` 면 확정, `directory` 면 사용자 확인이 필요하다. |
| `notes` | 해석 실패 · 대체 경로 사용 사유. 비어 있지 않으면 그대로 사용자에게 보인다. |

해석기는 부른 디렉토리 하나만 본다. 워크트리 · 하위 디렉토리에서 시작하면 어시스턴트가 현재 디렉토리부터 부모로 6단계까지 올라가며 단계마다 두 가지를 한다: 그 디렉토리에 `.ops-agent/project.json` 이 있는지 보고, 그 디렉토리를 인자로 해석기를 돌린다. `manifests` 가 비지 않은 첫 결과를 쓴다. 6단계까지 둘 다 없으면 단일 레포 작업이라 issue 가이드의 워크트리 시작 그대로 간다. 소유자를 원격에서 얻으므로 어느 경로에서 시작해도 같은 값이 나온다. 커밋 단계의 표기 규칙 해석과 같은 해석기다 ([docs/conventions-slot.md](../../../docs/conventions-slot.md)).

### 조직 매니페스트 키

```json
{
  "org": "<org>",
  "scope": "internal",
  "githubHost": "<host>",
  "rootDir": "/path/to/<org>",
  "providers": { "issue": "<adapter-id>", "dailylog": "<adapter-id>", "apiGuard": "<adapter-id>" },
  "branchPattern": "feature/{ticket}",
  "scriptOverrides": { "worktreeCleanup": "<adapter-id>:scripts/<script>.sh" }
}
```

| 키 | 타입 | 설명 |
|---|---|---|
| `org` | string | 조직 이름 (원격 주소의 소유자) |
| `scope` | "internal" \| "public" | 외부 어댑터 조직인지 내장 provider 조직인지. 셋업 때 정한다. |
| `githubHost` | string | GitHub 호스트 |
| `rootDir` | string | 프로젝트 루트 절대 경로 |
| `providers.*` | string | provider 어댑터 식별자 (선택). 아래 [provider 지정](#provider-지정) |
| `branchPattern` | string | 브랜치 이름 패턴 (선택). 기본 `feature/{ticket}` |
| `scriptOverrides.worktreeCleanup` | string | 본체 정리 스크립트 대신 쓸 외부 경로 (선택) |
| `conventions` | object | 커밋 · 체인지로그 표기 기본값 (선택). 레포 선언이 이긴다 ([docs/conventions-slot.md](../../../docs/conventions-slot.md)). |
| `pullMainsOnStart` | boolean | 시작 때 메인 클론 일괄 갱신 여부 (기본 true) |

### provider 지정

조직 매니페스트의 `providers.*` 키가 있으면 그 어댑터에 위임한다. 없으면 세션 시작 훅이 감지한 provider 를 그대로 쓴다. 호스트로 분기하는 코드를 두지 않는다. 분기는 이 키로만 정한다.

| 키 | 언제 부르나 | 어댑터가 하는 일 |
|----|-------------|------------------|
| `issue` | issue 가이드의 생성 · 시작 · 완료 | 이슈 트래커 API |
| `dailylog` | 시작 뒤 확인 | 일일 계획 항목 존재 확인 |
| `apiGuard` | 시작 전후 | API 폭주 방지 마커 설정 · 해제 |

어댑터 식별자는 외부 어댑터 플러그인의 같은 이름 스킬이나 스크립트를 가리킨다. 외부 어댑터 식별자는 그 어댑터의 네임스페이스 접두(`<adapter>-<service>`)를 붙인다. 내장은 이슈 provider `github` 하나이고, 내장 provider 조직의 매니페스트는 `"providers": { "issue": "github" }` 만 둔다. 발송 어댑터 내장은 없다. 위임 인터페이스는 외부 플러그인 쪽 가이드가 정한다.

### 프로젝트 매니페스트

```json
{
  "repos": {
    "backend": { "path": "backend", "remote": "https://github.com/org/backend.git", "base": "main", "role": "be" }
  },
  "domains": { "user": ["backend"] },
  "worktreeRoot": "worktrees"
}
```

## 셋업

프로젝트 매니페스트는 있는데 해석기의 `manifests` 가 비어 있을 때, 또는 사용자가 셋업을 요청했을 때 들어간다. `notes` 를 넘기고 기본값으로 진행하지 않는다.

1. 한 가지만 묻는다: 「`{org}` 는 외부 어댑터 조직인가, 내장 provider 조직인가?」
2. 답에 따라 위치를 정해 `<org>.json` 을 쓴다. 외부 어댑터 조직이면 해석기 출력의 `adapterRoots` 아래 `<adapter>/orgs/` 에 둔다. 어댑터 루트는 추측하지 않고 `~/.claude/ops-agent/adapters.json` 에서 읽는다. 선언이 없으면 기본값 `{ "roots": ["~/.claude/toolkits"] }` 이 쓰이고, 설치 위치가 다르면 그 파일에 적는다.
3. 프로젝트 매니페스트가 없으면 위 형식을 안내한다.

## 시작

issue 가이드 「/issue start」 6번에서 코드 작업으로 정한 뒤, 조직 매니페스트나 프로젝트 매니페스트가 있으면 이 절을 따른다. 프로젝트 매니페스트 없이 조직 매니페스트만 있으면(레포 하나) 5 · 6번만 하고, 워크트리는 시작 어댑터가 만든다. 둘 다 없으면 issue 가이드의 워크트리 시작 그대로다.

1. **매니페스트 확인**: 위 [조직 매니페스트를 찾는다](#조직-매니페스트를-찾는다) 순서로 두 매니페스트를 찾는다. 프로젝트 매니페스트로 여러 레포를 다루려면 조직 매니페스트도 있어야 하고, 없으면 셋업 밖 경로로 진입하지 않고 [셋업](#셋업)으로 간다.
2. **메인 클론 갱신**: 프로젝트 루트에 메인 클론(분석 참조용 작업 디렉토리)을 두는 조직은 낡은 본문으로 분석하지 않도록 먼저 갱신한다. `pullMainsOnStart: false` 면 건너뛴다.

   ```bash
   bash ~/.claude/ops-agent/current/scripts/pull-mains.sh <project-root>
   ```

   스크립트는 프로젝트 매니페스트의 레포 가운데 작업 디렉토리가 있는 레포만 돈다(bare clone · 없는 레포 · 워크트리는 건너뜀). 브랜치가 base 가 아니면 base 로 바꾸고 fast-forward 로만 갱신한다. 커밋하지 않은 변경이 있는 레포는 건너뛰고(`dirty-skip`) 보고한다. 레포 이름과 파일 수를 사용자에게 알리고 결정을 기다린다. 자동 폐기 · 강제 갱신은 하지 않는다.
3. **작업 범위**: 프로젝트 매니페스트의 `domains` 에서 영향받는 레포를 고른다. 주 레포(이슈 브랜치를 먼저 여는 레포)는 사용자 입력이나 도메인 역할로 정한다.
4. **API 가드 설정**: `providers.apiGuard` 가 있으면 어댑터로 마커를 건다.
5. **브랜치 이름과 분기점**: 이슈 시작 전에 정해 시작 어댑터에 `--branch` · `--base` 로 넘긴다. 이름은 `branchPattern` 을 따른다. `{slug}` 가 있으면 사용자 입력이나 작업 설명에서 만든다. 모든 브랜치는 원격 base(`origin/{base}`)나 통합 브랜치에서 분기하고, 로컬 base 를 갱신하지 않는다.
   - **상위 이슈가 있으면 통합 브랜치에서 분기한다.** 통합 브랜치는 하위 작업 조각이 모이는 브랜치다. 하위 조각을 base 에 바로 넣으면 미완성 조각이 base 에 남는다.
   - 레포마다 통합 브랜치가 원격에 있는지 본다. 없으면 원격 base 에서 만들어 푸시한다(워크트리 없이).
   - 하위 워크트리를 그 통합 브랜치에서 분기하고, 상태 파일에 `parentTicket` 과 레포별 `parentBranch` 를 적는다.
6. **이슈 시작**: 주 레포에서 issue 가이드 「/issue start」 7번(어댑터로 시작)을 실행한다. `providers.issue` 가 있으면 그 어댑터가 트래커를 다룬다. 끝나면 주 레포에 브랜치가 있는지, 이슈가 진행 중인지 본다. `providers.dailylog` 가 있으면 일일 계획 항목도 본다.
7. **상태 파일과 워크트리**: 아래 형식으로 상태 파일을 쓰고 레포별 워크트리를 만든다. 레포가 로컬에 없으면 bare clone 을 받아 워크트리를 만들고, IDE 매핑(`vcs.xml`)을 더한다.

   ```bash
   bash ~/.claude/ops-agent/current/scripts/worktree-create.sh .ops-agent/state/org-flow-{ticket}.json
   ```

8. **API 가드 해제**: `providers.apiGuard` 가 있으면 마커를 푼다.

상태 파일 `.ops-agent/state/org-flow-{ticket}.json`. 이름의 접두는 정리 스크립트와 외부 확장이 읽는 형식이라 그대로 둔다 (ADR-0042 결정 5).

```json
{
  "ticket": "123",
  "taskId": "...",
  "parentTicket": "120",
  "domain": "user",
  "primaryRepo": "backend",
  "repos": {
    "backend": { "branch": "feature/123-요약", "base": "main", "parentBranch": "feature/120", "worktree": "worktrees/backend/feature-123" }
  }
}
```

| 필드 | 필수 | 뜻 |
|------|------|-----|
| `parentTicket` | 선택 | 상위 이슈. 있으면 통합 브랜치 흐름이다. |
| `repos.<repo>.parentBranch` | 선택 | 이 레포의 통합 브랜치. 하위 브랜치가 여기서 분기하고 PR 도 여기를 베이스로 연다. |
| `repos.<repo>.base` | 필수 | 레포의 기본 브랜치. 통합 브랜치가 없으면 여기서 분기한다. |

`startedAt` 은 워크트리 생성 스크립트가 시간대를 포함해 한 번 기록한다.

## 제출

변경이 있는 레포마다 commit 가이드와 PR 가이드를 그대로 따른다. 단계 표를 여기 복제하지 않는다 ([PR 가이드](pr.md)).

- 커밋 전에 레포마다 프로젝트의 완료 조건(빌드 · 테스트 · 린트)을 확인한다.

- PR 베이스는 `parentBranch` 가 있으면 그것, 없으면 `base` 다.
- 통합 브랜치를 베이스로 열면 쌓인 PR 이다. 머지 순서와 브랜치 삭제 시점은 [PR 가이드 「쌓인 PR」](pr.md#쌓인-pr) 을 따른다. 베이스가 먼저 사라지면 그 위 PR 이 닫히고 되돌릴 수 없다.
- 통합 브랜치에서 base 로 가는 PR 은 상위 작업이 모두 끝난 뒤 한 번 연다.
- 레포마다 초안 PR URL 을 모아 한 번에 전달한다.

## 완료

상태 파일이 있으면 issue 가이드 「/issue complete」가 두 자리에서 이 절로 온다. 1번은 이슈를 닫기 전(완료 2번 뒤), 2 · 3번은 브랜치 정리(완료 8번) 자리다.

1. **머지 확인 (이슈를 닫기 전)**: 관련 레포의 PR 이 모두 머지됐는지 본다. 하나라도 아니면 이슈를 닫지 않고 멈춘다.
   - 이슈 완료 처리는 issue 가이드가 한다. 조직 매니페스트가 `providers.issue` 를 지정하면 그 어댑터가 닫는다. 닫은 뒤 상태가 완료인지 보고, 어댑터가 추가 검증을 정의하면 그 어댑터에 맡긴다.
2. **정리 전 검사**: 정리 스크립트는 워크트리와 bare clone 을 백업 없이 지운다. 그래서 지우기 전에 이 이슈의 워크트리를 검사하고, 커밋하지 않은 변경이 하나라도 있으면 아무것도 지우지 않고 `status: dirty` (종료 코드 3)로 끝난다. 그러면 파일 목록을 보고하고, 커밋 · 푸시하거나 사용자가 직접 폐기한 뒤 다시 실행한다. 자동 폐기는 하지 않는다.
3. **정리**: `scriptOverrides.worktreeCleanup` 이 있으면 그 스크립트, 없으면 본체 스크립트를 쓴다. 워크트리 · bare clone · IDE 매핑 · 상태 파일을 지운다. 다른 이슈가 쓰는 bare clone 과 정규 clone 은 남긴다 ([docs/worktree.md](../../../docs/worktree.md)).

   ```bash
   bash ~/.claude/ops-agent/current/scripts/worktree-cleanup.sh .ops-agent/state/org-flow-{ticket}.json
   ```

## 규칙

- 이슈 트래커 API 는 issue 가이드와 provider 어댑터로만 부른다. 이 가이드가 직접 부르지 않는다.
- 워크트리 생성 · 정리는 스크립트로 한 번에 실행한다.
- 조직 이름 · 제품 이름 · URL 을 본체에 두지 않는다. 매니페스트로 뺀다.
