# 차단 규칙 레퍼런스

`scripts/pre-tool-use.mjs` (PreToolUse hook) 가 실행 전에 막는 다섯 가지 규칙의 정본입니다. 표현 규칙처럼 알리기만 하는 hook 은 [hooks-config.md](hooks-config.md) 에 있습니다.

이 hook 은 판정만 합니다. 세션 컨텍스트 주입은 `scripts/session-start.mjs` 가 맡습니다.

| 규칙 | 막는 것 | 해제 |
|------|---------|------|
| 대외비 가드 | 공개 표면에 노출되는 대외비 키워드·패턴 | 본문 수정 (해제 플래그는 오탐 조정용) |
| 도메인 What 가드 | 커밋·PR·이슈 본문의 구현 세부 | 본문 수정 |
| 한시 권한 | 되돌리기 어려운 행위 | 사용자가 권한을 연다 |
| 최종 점검 통과 기록 | 통과 기록 없는 `gh pr merge` | `final-check.sh` 를 통과합니다. |
| 세션 범위 | 세션 범위 밖 레포로의 첫 쓰기 | 그 레포에 대한 쓰기를 다시 실행합니다. |

---

## 대외비 가드

검사 대상은 공개 표면으로 전송되는 쓰기 명령입니다.

| 명령 | 검사 대상 |
|------|-----------|
| `gh issue` / `gh pr` / `gh release` | 제목·본문·코멘트 |
| `git commit` | 커밋 메시지 + **커밋 대상 diff 의 추가된 줄** |

삭제된 줄은 검사하지 않습니다. 대외비를 제거하는 커밋이 자기 가드에 막히는 모순을 피합니다.

### 검사 시점을 커밋으로 잡은 이유

파일 편집 시점에는 그 파일이 어디로 갈지 알 수 없습니다. gitignore 대상일 수도, 사내 레포일 수도 있습니다. 커밋 시점에는 리모트로 표면을 판정할 수 있고, 추적 대상만 diff 에 올라 로컬 전용 파일이 자연히 제외됩니다. 편집마다가 아니라 커밋당 1회만 돌아 비용도 낮습니다.

편집 시점 검사보다 늦지만 발행 전입니다.

### 표면 셋

호스트만 보면 둘로 나뉘어 비공개 저장소가 공개 표면으로 오판됩니다. 그래서 셋으로 나눕니다.

| 표면 | 판정 | 적용 규칙 |
|------|------|-----------|
| `internal` | 사내 호스트 (`internalHosts` 매칭) | `keywords` + `patterns` + `personalDevOnly` |
| `public` | 사내 호스트 아님 + 공개 확인 | `keywords` + `patterns` + `externalOnly` |
| `private` | 사내 호스트 아님 + 비공개 확인 | `keywords` + `patterns` |

두 방향을 같은 강도로 막습니다. 사내 용어가 공개 표면에 노출되는 것은 대외비 위반이고, 개인 환경 흔적이 사내 공유 표면에 드러나는 것도 막습니다.

호스트 인식은 `gh` 명령이면 `GH_HOST` 환경 변수 또는 `-R host/owner/repo` 플래그에서, `git commit` 이면 현재 레포의 origin 리모트에서 가져옵니다. 공개 여부는 `gh repo view` 로 확인해 7일 캐시하고, **조회가 실패하면 public 으로 닫습니다.**

### 키워드 소스

`~/.claude/ops-agent/confidential-keywords.local.json` 이 정본입니다. 스키마와 작성 예시는 [`templates/confidential-keywords.example.json`](../templates/confidential-keywords.example.json) 에 있습니다.

| 설정 키 | 적용 표면 |
|---------|-----------|
| `keywords` / `patterns` | 전 표면 |
| `externalOnly` | public 만 |
| `personalDevOnly` | internal 만 |
| `allowPaths` | 커밋 diff 검사에서 제외할 경로 정규식 |

키워드는 문자열 또는 `{ value, wordBoundary, ignoreCase }` 객체로 씁니다.

- `wordBoundary`: ASCII 3글자 이하면 기본 켜집니다. 다른 식별자 안에 묻힌 등장을 히트로 세지 않습니다.
- `ignoreCase`: 기본 꺼져 있습니다. 켜면 표기형을 따로 등록하지 않아도 됩니다.
- 경계 문자 집합에 한글은 넣지 않습니다. 넣으면 조사가 붙은 정상 등장이 통과해 못 잡습니다. 한글만으로 된 키워드에는 경계 옵션이 듣지 않으므로, 오탐이 나면 목록에서 뺍니다.

레포 안에 실제 키워드를 두지 않습니다. 설정 파일은 홈 디렉토리에만 둡니다.

---

## 도메인 What 가드

커밋·풀리퀘스트·이슈 본문이 "무엇이 달라지는가" 대신 구현 방법을 적는 것을 막습니다. 룰 정본은 `scripts/what-guard-rules.mjs` 이고, 다른 트래커를 쓰는 소비자도 같은 모듈을 불러 씁니다. 룰이 호출부마다 복제되면 같은 본문이 경로에 따라 통과와 차단으로 나뉩니다.

| 룰 | 탐지 대상 |
|----|-----------|
| `hexagonal-classname` | `Port`·`Adapter`·`UseCase`·`Service`·`Repository` 등으로 끝나는 클래스명 |
| `annotation` | Spring·Lombok·Jakarta 계열 어노테이션 |
| `tx-phase-const` | 트랜잭션 phase·propagation 상수 |

구현 방법은 본문 최하단 `How` 절에만 씁니다. 형식은 provider 의 풀리퀘스트 템플릿을 따릅니다.

---

## 한시 권한

되돌리기 어렵거나 외부에 영향이 가는 행위를, 사용자가 그 세션에 권한을 열기 전까지 막습니다. 목적은 어시스턴트가 권한을 추측해 실행하는 사고를 막는 것입니다.

앞의 두 가드와 성격이 다릅니다. 가드는 본문을 보고 매번 새로 판정하지만, 이쪽은 갈래와 만료를 갖고 열린 채 유지됩니다. 그래서 게이트라 부르지 않습니다. **게이트는 통과하는 것이고 권한은 여는 것입니다.** 업계에서 just-in-time access 라 부르는 구조와 같습니다. 승인·단기 권한·자동 만료·스코프 제한 넷을 그대로 갖습니다.

### 대상

| 분류 | 명령 | 대상 동작 |
|------|------|-----------|
| 레포 | `gh pr merge` | 머지 |
| 레포 | `gh release` | `create` · `edit` · `delete` |
| 레포 | `gh repo` | `delete` · `archive` |
| 레포 | `git push` | `--force` · `--force-with-lease` · `-f` · `--delete` · 삭제 refspec |
| 클러스터 | `kubectl` | `apply` `patch` `replace` `delete` `edit` `scale` `annotate` `label` `set` `cordon` `drain` `uncordon` `taint` `rollout` `create` `expose` `autoscale` `run` `exec` `cp` `attach` `certificate` |
| 클러스터 | `argocd app/proj/repo/cluster/account/admin` | `create` `delete` `set` `unset` `sync` `rollback` `patch` `add` `rm` `terminate-op` `actions` `update-password` |
| 클러스터 | `helm` | `install` `upgrade` `uninstall` `delete` `rollback` |

명령은 체인 세그먼트(`&&` `||` `;` `|` 개행)로 나눠 각각 판정하고, 앞에 붙은 환경 변수 할당과 `sudo` 는 떼고 봅니다. 따옴표 안의 구분자는 경계로 보지 않습니다. 따옴표가 닫히지 않은 명령은 종전대로 나눕니다.

### 개방 절차

어시스턴트가 권한을 스스로 열지 않습니다. 판정 주체는 항상 사람입니다.

0. **어시스턴트가 상태를 조회한다.** 대상 행위가 계획에 들어온 시점이며, 차단을 만나기를 기다리지 않는다

    ```bash
    bash ~/.claude/ops-agent/current/scripts/action-gate-allow.sh status
    ```

    같은 때 계획에 든 갈래의 하네스 허용 규칙이 `~/.claude/settings.json` 에 있는지 읽는다. 없으면 3단계 개방 명령과 함께 첫 요청에 싣는다. 아래 「하네스 허용 규칙」

1. 어시스턴트는 멈추고, 어떤 행위를 왜 하는지 플랜으로 제시한다

2. 사용자가 플랜을 검토하고 승인한다
3. 사용자가 직접 실행한다. 어시스턴트가 **감지된 갈래를 담은 명령**을 제시한다

    ```bash
    ! bash ~/.claude/ops-agent/current/scripts/action-gate-allow.sh on repo-merge
    ```

4. 어시스턴트는 그 창 동안 그 갈래만 수행한다. 다른 갈래는 다시 차단된다
5. 마무리할 때 사용자가 `off` (선택)

어시스턴트가 개방·해제를 직접 실행하면 자기 수정으로 차단됩니다. 정상 동작이며 우회하지 않습니다. `status` 는 상태를 읽기만 하므로 차단되지 않습니다.

#### 하네스 허용 규칙

승인 채널은 게이트 하나다 ([ADR-0018](adr/0018-gate-is-the-only-approval-channel.md)). 어시스턴트는 대화 속 승인 문장을 요청하지 않는다.

하네스(Claude Code)에도 판정자가 있다. 게이트 대상 명령이 하네스 허용 규칙에 없으면 창이 열려 있어도 오토 모드 분류기가 막을 수 있다. 규칙에 맞으면 분류기를 거치지 않고 게이트 훅만 판정한다. 평가 순서는 공식 문서 [Permission modes](https://code.claude.com/docs/en/permission-modes) 가 정본이다.

묶은 명령은 하위 명령마다 규칙에 맞아야 한다 ([Configure permissions](https://code.claude.com/docs/en/permissions) 「Compound commands」). 머지 앞에 물리는 검사 스크립트도 규칙에 둔다.

| 갈래 | 허용 규칙 |
|------|-----------|
| `repo-merge` | `Bash(gh pr merge *)` · `Bash(./scripts/pre-merge-check.sh *)` |
| `repo-release` | `Bash(gh release *)` |
| `git-force` | `Bash(git push origin --delete *)` · `Bash(git push --force-with-lease *)` |
| `worktree-destructive` | `Bash(git branch -D *)` · `Bash(git reset --hard *)` · `Bash(git clean *)` · `Bash(git restore *)` |

`cluster-write` · `repo-delete` · `git-default-push` 는 규칙에 두지 않는다. 운영에 닿는 민감 작업은 사용자가 `!` 로 직접 실행하고, 기본 브랜치 직접 push 는 금지다.

규칙은 사용자가 넣는다. 규칙에 맞는 명령은 분류기의 다른 검사도 거치지 않는다는 대가가 있다.

#### 0단계를 앞세운 이유

이 절차는 원래 1번부터 시작했고, 발동 조건이 「차단이 나면」이었습니다. 차단을 만나기 전까지 어시스턴트는 자기가 어디 서 있는지 몰랐고, 그 공백을 사용자의 자연어 문장으로 메꿔 진행하는 사고가 났습니다.

게이트가 필요하다는 것을 작업 도중에 알았다면 그 시점에 요청합니다. 멈추기 어려우면 게이트 없이 되는 일을 먼저 끝내고 마지막에 요청합니다. 미루는 것은 요청이지 행위가 아니며, 대상 행위는 창이 열린 뒤에만 실행합니다.

**판정 근거는 마커의 `scopes` 와 `expiresAt` 뿐입니다.** 「승인」·「게이트 오픈」 같은 사용자의 문장은 2단계를 통과시키고 3단계를 예고할 뿐, 권한을 열지 않습니다. 2와 3은 합쳐지지 않습니다.

세션 허용은 환경 변수 `OPS_AGENT_ACTION_GATE_ALLOW=1` 또는 마커 파일(`~/.claude/ops-agent/.cache/action-gate-allow.json`, 만료 시각·허용 갈래·세션 바인딩을 가짐)로 판정합니다. 마커를 직접 읽는 대신 `status` 를 씁니다. 만료 여부를 사람이 계산하지 않아도 됩니다.

#### 갈래

시간만으로 열면 그 창 안에서 승인 대상이 아니던 행위까지 통과합니다. PR 머지를 위해 연 창에서 기본 브랜치 직접 push 가 통과한 사례가 있습니다. 둘 다 되돌리기 어려운 행위이고 전역 금지 규칙이 있는 쪽이 뒤였습니다.

| 갈래 | 대상 명령 |
|------|-----------|
| `cluster-write` | kubectl · argocd · helm mutation |
| `repo-merge` | `gh pr merge` |
| `repo-release` | `gh release create/edit/delete` |
| `repo-delete` | `gh repo delete/archive` |
| `git-force` | force push · 원격 브랜치 삭제 |
| `git-default-push` | 기본 브랜치 직접 push |
| `worktree-destructive` | `git reset --hard` · `clean` · `branch -D` · `restore` |
| `all` | 전부 |

갈래를 이 형태로 둔 판단입니다.

| 설계 결정 | 근거 |
|-----------|------|
| 갈래는 `category` 보다 좁다 | `repo-merge` 와 `git-default-push` 가 둘 다 `repo` 라 category 단위로는 나뉘지 않는다 |
| 갈래를 사람이 고르지 않는다 | 차단 메시지가 감지된 갈래를 담은 명령을 싣고 사용자는 그대로 실행한다. 갈래를 좁히면서 열기 절차가 무거워지지 않게 하는 자리다 |
| `on` 은 기존 마커를 **대체한다** | 합집합으로 열면 TTL 도 함께 연장되어 먼저 연 갈래의 창이 사람이 의도한 길이를 넘는다. 마커는 사람이 마지막으로 승인한 것을 그대로 담는다 |
| 합치는 일은 차단 메시지가 한다 | 이미 열린 갈래를 개방 명령에 함께 실어 한 줄로 제시한다. 두 갈래가 순차로 필요한 작업에서 개방 → 차단 → 개방이 반복되던 문제를 막는다 (ADR 0007) |
| TTL 은 창의 길이만 정한다 | 범위는 갈래가 정한다. 옛 형식(`on 30`)은 전체 개방으로 읽어 진행 중인 창을 끊지 않는다 |

스크립트도 살아 있는 마커를 덮어쓸 때 **잃는 갈래가 있으면** 알립니다. 새 목록이 이전을 모두 포함하면 사라지는 것이 없으므로 알리지 않습니다.

#### 다른 명령과 한 블록에 두지 않는다

권한 대상 행위 **앞에** 다른 명령이 같은 블록에 있으면, 갈래가 열려 있어도 차단합니다.

앞선 명령의 출력을 읽기 전에 그 행위가 실행되기 때문입니다. 실측에서 머지 전 버전 대조가 「멈춤」 두 줄을 출력한 블록에서 `gh pr merge` 가 그대로 실행되어, 기본 브랜치의 버전이 뒤로 밀리고 CHANGELOG 에 같은 버전 헤더가 둘이 됐습니다. 판정은 정확했고 막지 못한 것은 실행 순서였습니다.

| 형태 | 판정 |
|------|------|
| `gh pr merge …` 단독 | 통과 |
| `cd <경로> && gh pr merge …` | 통과 (디렉토리 이동·환경 설정·주석은 판정 출력이 없다) |
| `gh pr merge … && git worktree remove …` | 통과 (뒤에 오는 정리는 이미 실행된 행위에 딸린 것이다) |
| `git log …` 다음 줄에 `gh pr merge …` | **차단** |
| `bash scripts/pre-merge-check.sh … && gh pr merge …` | 통과 (아래 예외) |

예외는 판정을 **종료 코드로** 돌려주는 검사 하나입니다. `scripts/pre-merge-check.sh` 는 검출하면 종료 코드 1 이라, `&&` 로 물리면 사람이 출력을 읽지 않아도 다음 명령이 실행되지 않습니다. 문자열로만 「멈춤」을 알리는 스니펫과 다른 점이 이 하나입니다.

「분리해서 실행하라」를 지시로만 두면 잊었을 때 걸리는 것이 없습니다. 그래서 지시가 아니라 훅이 거릅니다.

#### 판정 자체 점검

차단은 발동할 때만 존재가 드러납니다. 조용히 무력화되면 아무 신호가 없으므로, `scripts/pre-tool-use.mjs` 를 고쳤으면 점검을 돌립니다.

```bash
node scripts/selftest-action-gate.mjs
```

훅 판정 13건과 개방 안내 9건을 봅니다. 훅 판정은 갈래를 전부 열어(`OPS_AGENT_ACTION_GATE_ALLOW=1`) 돌립니다. 동거 검사는 창이 열린 상태에서만 발동하고, 그 상태가 사고가 난 조건입니다.

통과 기록 판정은 임시 HOME 과 임시 레포의 origin 추적 브랜치로 6건을 봅니다(없음 · 일치 · head 불일치 · 다른 PR · 브랜치명 · 값 플래그). 동거 검사 케이스는 통과 기록 검사를 끄고(`OPS_AGENT_FINAL_CHECK_DISABLE=1`) 돌립니다.

세션 범위 판정은 임시 HOME 과 임시 레포 둘로 8건과 지표 1건을 봅니다(첫 쓰기 · 다른 레포 차단 · 재시도 통과 · 범위 레포 · 읽기 · 비 git 경로 · git 조회 · 전역 `-R` 이 앞서는 gh 쓰기). 기존 훅 판정 케이스는 세션 범위를 끄고(`OPS_AGENT_SESSION_SCOPE_DISABLE=1`) 돌립니다.

개방 안내는 마커를 만들지 않도록 함수만 불러 씁니다(`OPS_AGENT_GATE_LIB=1`). 점검이 사용자의 열린 창을 덮어쓰면 안 됩니다.

### 한계

최상위 명령만 봅니다. `bash deploy.sh` 처럼 스크립트 내부에서 실행되는 명령은 탐지하지 못합니다. 의도된 배포 스크립트 경로는 승인된 것으로 간주하고, 직접 타이핑하는 일회성 명령을 막는 안전망으로 둡니다.

---

## 최종 점검 통과 기록

머지 직전 점검이 어시스턴트의 기억에 달려 있으면, 게이트가 열린 순간 점검 없이 머지됩니다. 그래서 `gh pr merge` 는 게이트 개방과 별개로 **머지할 커밋에 묶인 통과 기록**을 요구합니다 (#612).

| 층 | 수단 |
|----|------|
| 트리거 | PreToolUse 가 `gh pr merge` 를 잡으면 통과 기록을 확인합니다. 머지 호출에서만 동작합니다. |
| 결정적 점검 | `scripts/final-check.sh <PR번호> --notes <파일> [--no-comment]` |
| 판단 점검 | 노트의 세 절을 어시스턴트가 채웁니다. 스크립트는 절이 비었는지만 봅니다. |
| 무효화 | 푸시로 HEAD 가 바뀌면 통과 기록의 head 가 어긋나 무효가 됩니다. |

### 점검 항목

하나라도 걸리면 실패 목록을 출력하고 종료 코드 1 입니다.

| 항목 | 실패 조건 |
|------|-----------|
| a. 체크 | 실패 · 취소 · 대기 중인 체크가 있습니다. |
| b. 리뷰 스레드 | 미해결 스레드가 있습니다. |
| c. 리뷰 봇 | `.coderabbit.yaml` 이 있고 CodeRabbit 마지막 리뷰의 `commit_id` 가 HEAD 가 아닌데 노트의 `## 자체 검증` 이 비어 있습니다. |
| d. 레포 체크리스트 | `.ops-agent/final-check.sh` 가 있고 종료 코드가 0 이 아닙니다. |
| e. 변경 문서 | PR 이 **추가한 줄**에 PN7 검출이 있습니다. 기존 줄의 PN7 은 건수만, 다른 규칙 검출은 출력만 합니다. |
| f. 판단 노트 | `## 설계 반영` · `## 서브 에이전트 산출물` · `## 교정` 중 없거나 비어 있는 절이 있습니다. |

체크 상태 SUCCESS 는 리뷰 여부와 무관합니다. 리뷰 봇은 `commit_id` 로 판정합니다.

증분 리뷰가 꺼진 레포는 수정 커밋을 건너뜁니다. 한도에 걸려도 같습니다. 이때 바뀐 부분을 자체 검증하고 그 사실을 `## 자체 검증` 에 적습니다.

「해당 없음」 같은 한 줄은 본문으로 인정합니다. 비워 두는 것만 막습니다.

레포별 체크리스트는 레포가 `.ops-agent/final-check.sh` 로 선언합니다. 스크립트가 PR 번호를 인자와 `FINAL_CHECK_PR` 로 받습니다.

GitHub API 조회는 PR 주소의 호스트로 보냅니다. GitHub Enterprise 원격 레포에서도 `GH_HOST` 를 넘기지 않아도 됩니다. `GH_HOST` 를 직접 넘기면 그 값을 씁니다.

### 통과 시 기록

통과하면 노트를 PR 댓글로 올리고 통과 기록을 남깁니다.

`--no-comment` 를 주면 댓글을 올리지 않습니다. PR 정보를 본문으로만 관리해 댓글이 알림 노이즈가 되는 경우에 씁니다. 노트는 통과 기록의 `notes` 에 남습니다.

| 항목 | 값 |
|------|-----|
| 통과 기록 | `~/.claude/ops-agent/.cache/final-check/<owner>__<repo>__<PR>.json` = `{pr, head, branch, repo, at, notes}` |
| 지표 | `~/.claude/ops-agent/metrics/final-check.jsonl` 에 매 실행 한 줄. 점검은 `{ts, repo, pr, result: pass\|fail, failed, duration_ms}`, 훅 차단은 `{ts, repo, pr, result: blocked, reason}` |

### 훅 판정

판정은 로컬에서만 합니다. 통과 기록의 head 와 `git rev-parse refs/remotes/origin/<통과 기록 branch>` 를 비교합니다. 네트워크 호출이 없어 훅 예산 안에서 끝납니다.

PR 번호는 명령의 첫 positional 에서 얻습니다. 없으면 현재 브랜치명으로 통과 기록을 찾습니다. repo 는 명령 cwd 의 origin 에서 얻습니다.

통과 기록이 없거나 head 가 어긋나면 차단합니다. 메시지가 실행할 명령 한 줄과 노트 세 절의 제목을 싣습니다.

게이트가 닫혀 있으면 게이트 차단이 먼저 나옵니다. 통과 기록 확인은 게이트가 열린 뒤에도 따로 실행됩니다.

```bash
bash "$CLAUDE_PLUGIN_ROOT/scripts/final-check.sh" <PR번호> --notes <파일>
```

점검이 끝나면 한 이슈의 생애가 끝난 것이므로 세션을 종료하거나 `/clear` 합니다.

---

## 세션 범위

한 세션이 다른 주제의 레포까지 쓰기 시작하는 것을 한 번 멈춰, 이슈 분리를 묻습니다 (#613). 시범 적용이며 최소 형태입니다.

| 항목 | 내용 |
|------|------|
| 범위 | 세션에서 처음 쓰기 행위가 일어난 git 레포의 toplevel 입니다. 워크트리는 본 레포로 환원합니다. |
| 기록 | `~/.claude/ops-agent/.cache/session-scope/<session_id>.json` = `{repo, acknowledged}` |
| 보는 행위 | `Edit` · `Write` · `MultiEdit` · `NotebookEdit` 의 파일 경로. Bash 의 `git commit` · `git push` · `gh issue` · `gh pr` 의 create · comment · edit · merge · close · ready |
| 대상 레포 | 파일은 경로의 toplevel, Bash 는 `cd` · `git -C` 로 정한 디렉토리의 toplevel 입니다. `gh -R owner/repo` 가 있으면 그 slug 입니다. |
| 통과 | 읽기, git 레포가 아닌 경로 (`~/.claude` 메모리 · 스크래치 · `/tmp`), `session_id` 가 없는 호출 |

대상이 범위와 다르고 `acknowledged` 에 없으면 한 번 차단하고 그 레포를 `acknowledged` 에 넣습니다. 그 레포에 대한 쓰기를 다시 실행하면 통과합니다. 확인 단위는 호출이 아니라 레포입니다. 다른 주제면 이슈로 분리하고 새 세션에서 진행하며, 이 작업의 연계면 그 레포에 쓰기를 다시 실행합니다.

판정 순서는 최종 점검 통과 기록과 게이트 차단보다 뒤입니다. 그 차단이 먼저 나오면 이 판정은 하지 않습니다.

지표는 `~/.claude/ops-agent/metrics/session-scope.jsonl` 에 남깁니다.

| 결과 | 시점 |
|------|------|
| `{ts, session, scope, target, result: blocked}` | 차단마다 |
| `{ts, session, scope, target, result: ack}` | 차단 뒤 같은 대상 쓰기가 통과할 때 첫 1회. 같은 호출에 차단 대상이 있으면 기록하지 않습니다. 중복 기록을 막으려 캐시에 `ackLogged` 를 함께 둡니다. |

### 한계

- 같은 레포 안에서의 주제 이탈은 잡지 못합니다. 판정 단위가 레포라서 범위 레포 안의 다른 이슈 작업은 통과합니다.
- 스크립트 내부에서 실행되는 쓰기와 셸 변수로 정한 경로는 탐지하지 못합니다.
- 첫 쓰기가 `-R` 로 레포를 지목한 호출이면 범위를 기록하지 않습니다. slug 에서 로컬 경로를 알 수 없습니다.
- 대외비 가드 비활성(`OPS_AGENT_CONFIDENTIAL_DISABLE=1`)은 훅 판정 전체를 끄므로 이 판정도 함께 꺼집니다.

---

## 플래그

오탐 조정과 파이프라인 실행용입니다. 상시 사용을 전제하지 않습니다.

| 규칙 | 드라이런 (경고만) | 비활성 |
|------|------------------|--------|
| 대외비 가드 | `OPS_AGENT_CONFIDENTIAL_DRYRUN=1` | `OPS_AGENT_CONFIDENTIAL_DISABLE=1` |
| What 가드 | `OPS_AGENT_WHAT_GUARD_DRYRUN=1` | `OPS_AGENT_WHAT_GUARD_DISABLE=1` |
| 한시 권한 | `OPS_AGENT_ACTION_GATE_DRYRUN=1` | `OPS_AGENT_ACTION_GATE_DISABLE=1` |
| 최종 점검 통과 기록 | 없음 | `OPS_AGENT_FINAL_CHECK_DISABLE=1` |
| 세션 범위 | 없음 | `OPS_AGENT_SESSION_SCOPE_DISABLE=1` |

새 키워드를 등록할 때는 드라이런으로 먼저 돌려 오탐을 확인합니다.
