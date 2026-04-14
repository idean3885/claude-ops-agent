# Multi-Repo Orchestration (org-flow)

멀티레포 프로젝트에서 관련 레포 간 워크트리 동기화 + 파이프라인 추적을 제공한다.
`devex:flow`의 단일 레포 이슈 라이프사이클 위에서 동작한다.

## 트리거

- "org-flow", "멀티레포", "multi-repo"

## 전제조건

프로젝트 루트에 `.devex/project.json` 매니페스트가 존재해야 한다.

```json
{
  "repos": {
    "frontend": {
      "path": "frontend",
      "remote": "https://github.com/org/frontend.git",
      "base": "main",
      "role": "fe"
    },
    "backend": {
      "path": "backend",
      "remote": "https://github.com/org/backend.git",
      "base": "main",
      "role": "be"
    }
  },
  "domains": {
    "user": ["frontend", "backend"],
    "auth": ["frontend", "auth-service"]
  },
  "worktreeRoot": "worktrees"
}
```

## 역할 분담

```
devex:flow   — 이슈 생성/시작/완료 (이슈 트래커 + 주 레포 브랜치)
org-flow     — 스코핑 + 관련 레포 워크트리 + 파이프라인 추적 + 커밋/PR 오케스트레이션
```

| 책임 | 담당 |
|------|------|
| 이슈 생성/시작/완료 | `devex:flow` — **org-flow가 직접 수행 금지** |
| 스코핑 (영향 레포 산정) | org-flow |
| 관련 레포 워크트리 생성 | org-flow (`scripts/worktree-create.sh`) |
| 파이프라인 실행 (구현/검증) | org-flow → 프로젝트 스킬 |
| 각 레포 커밋/PR | org-flow → `devex:flow` commit/PR 위임 |
| 워크트리 정리 | org-flow (`scripts/worktree-cleanup.sh`) |

## 리모트 원소스 전략

로컬에 베이스 브랜치 디렉토리를 두지 않는다.

- 레포가 로컬에 없으면 `git clone --bare` → 워크트리 생성
- 작업 완료 후 워크트리 + bare clone 모두 삭제
- 모든 브랜치는 `origin/{base}`에서 분기 (로컬 base pull 불필요)

## 서브커맨드

### `/org-flow start {설명 또는 티켓번호}`

스코핑 → devex:flow 위임 → 관련 레포 워크트리 생성.

**Step 1: 스코핑**

매니페스트의 `domains`에서 영향 받는 레포를 조회한다.
주 레포 결정: 사용자 입력 또는 도메인 role 기반.

**Step 2: devex:flow 위임 (GATE)**

주 레포 디렉토리에서 devex:flow `issue start`를 호출한다.
org-flow가 이슈 트래커 API를 직접 호출하지 않는다.

위임 완료 후 검증:
- 주 레포에 `feature/{ticket}` 브랜치 존재
- 이슈 상태가 "진행 중"

하나라도 실패 시 다음 단계로 진행하지 않는다.

**Step 3: 워크트리 생성 (스크립트)**

```bash
scripts/worktree-create.sh .omc/state/org-flow-{ticket}.json
```

clone-on-demand: 레포가 없으면 bare clone → 워크트리 생성.
vcs.xml 매핑 자동 추가.

**Step 4: 상태 저장**

`.omc/state/org-flow-{ticket}.json`:

```json
{
  "ticket": "123",
  "taskId": "...",
  "domain": "user",
  "primaryRepo": "frontend",
  "repos": {
    "frontend": {
      "branch": "feature/123",
      "base": "main",
      "worktree": "worktrees/frontend/feature-123"
    }
  },
  "pipeline": [],
  "currentStage": ""
}
```

### `/org-flow status`

관련 레포의 git 상태 + 파이프라인 진행률을 통합 조회한다.

### `/org-flow submit`

검증 → 커밋 → PR → 알림. 각 레포에서 `devex:flow` commit/PR을 위임한다.

**Step 1: 완료 게이트**

프로젝트별 완료 조건 확인 (빌드, 테스트, 린트 등).

**Step 2: 각 레포 커밋/PR**

변경 있는 레포마다 해당 레포의 `devex:flow` commit → PR 스킬을 실행한다.
커밋 메시지는 기능 변경(What)을 기술한다.

### `/org-flow finish`

머지 후 이슈 완료 + 워크트리 정리.

**Step 1: 머지 확인 (GATE)**

모든 관련 레포의 PR이 머지되었는지 확인한다.

**Step 2: devex:flow 위임 (GATE)**

주 레포에서 devex:flow `issue complete`를 호출한다.
완료 후 이슈 상태가 "closed"인지 검증한다.

**Step 3: 워크트리 정리 (스크립트)**

```bash
scripts/worktree-cleanup.sh .omc/state/org-flow-{ticket}.json
```

워크트리 제거 + bare clone 삭제 + vcs.xml 정리 + 상태 파일 삭제.

## 파이프라인 연동

프로젝트별 파이프라인은 `.devex/project.json` 또는 프로젝트 CLAUDE.md에서 정의한다.
org-flow는 `currentStage`를 추적하고 다음 단계를 안내한다.

## 프로젝트별 오버라이드

프로젝트 고유 동작(provider 통합, 파이프라인, 알림)은 프로젝트의
`.claude/skills/org-flow/SKILL.md`에서 이 스킬을 확장한다.

devex의 org-flow는 범용 골격이며, 프로젝트 레벨에서 오버라이드할 수 있다.

## 규칙

- devex:flow 위임 없이 이슈 트래커 API를 직접 호출하지 않는다
- 워크트리 생성/정리는 스크립트로 원자 실행한다
- 프로젝트별 설정은 매니페스트(`.devex/project.json`)에서 읽는다
- 하드코딩된 URL, 조직명, 제품명을 포함하지 않는다
