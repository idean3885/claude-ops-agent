#!/usr/bin/env node
/**
 * ops-agent PreToolUse hook
 *
 * 세션 컨텍스트 주입은 SessionStart 훅(scripts/session-start.mjs)이 담당한다.
 * 이 훅은 가드 판정만 수행한다.
 *
 * 1. 대외비 가드 (GATE 0): 공개 표면 쓰기 명령(gh issue/pr/release, git commit)의
 *    본문·제목·메시지에서 대외비 키워드/패턴 히트 시 하드 차단.
 *    git commit 은 메시지 외에 **커밋 대상 diff 의 추가된 줄**도 검사한다. 파일로 들어간
 *    대외비(예시 문자열 등)가 메시지 검사만으로는 걸러지지 않기 때문이다.
 *    삭제된 줄은 검사하지 않는다 — 대외비를 제거하는 커밋이 막히면 안 된다.
 *    제외 경로: 설정의 `allowPaths` 정규식.
 *
 *    타겟 호스트 인식:
 *    - `gh` 명령: GH_HOST 환경 변수 또는 `-R host/owner/repo` 플래그에서 호스트 추출
 *    - `git commit`: 현재 레포의 origin remote URL 검사
 *    - 타겟이 `internalHosts` 에 포함되면 `externalOnly` 키워드/패턴은 허용
 *    - `keywords` / `patterns` (루트) 는 타겟 무관 항상 차단 (예: 위키)
 *
 * 2. 도메인 What 추상화 가드: 커밋·PR·이슈 본문의 구현 세부(클래스명·어노테이션·yaml 키 등) 차단.
 * 3. 한시 권한: 되돌리기 어려운/외부 영향 행위(클러스터 mutation·PR 머지·릴리즈·force push
 *    ·리소스 삭제)를 세션 명시 허용 전까지 차단. 권한 추측 실행을 기계적으로 차단.
 *    세션 허용: OPS_AGENT_ACTION_GATE_ALLOW=1 또는 action-gate-allow.sh on 마커.
 *    드라이런 OPS_AGENT_ACTION_GATE_DRYRUN=1 · 비활성 OPS_AGENT_ACTION_GATE_DISABLE=1.
 *    (레거시 OPS_AGENT_CLUSTER_WRITE_ALLOW / _GUARD_* · cluster-write-allow.json 도 계속 인식)
 *    레포 유형 (ADR-0028): `.ops-agent/repo-type.json` 선언을 AI 가 쓰지 못하게 막고,
 *    업무 · 사상 유형(기본값 work) 레포의 `gh pr merge` 는 갈래가 열려 있어도 거부한다.
 * 4. 최종 점검 통과 기록 (#612): `gh pr merge` 는 게이트 개방과 별개로 scripts/final-check.sh 가 남긴
 *    통과 기록이 있어야 통과한다. 판정은 로컬만이다. 통과 기록 head 와 origin 추적 브랜치를 비교한다.
 *    비활성 OPS_AGENT_FINAL_CHECK_DISABLE=1.
 * 5. 플로우 진입 (#769 · #773 · #891 · #1114 · #1116): 커밋 · push · PR 생성 직전에 마지막 압축 뒤 플로우 가이드 읽음 여부를 기록하고,
 *    읽지 않은(missed) 세션의 PR 생성은 차단한다. 서브에이전트는 자기 대화 기록으로 본다. 비활성 OPS_AGENT_FLOW_ENTRY_DISABLE=1.
 * 6. 초안 PR (#876): `gh pr create` 에 초안 플래그가 없으면 차단한다. 가이드를 읽었는지가 아니라 규칙을 본다.
 *    드라이런 OPS_AGENT_PR_DRAFT_GUARD_DRYRUN=1 · 비활성 OPS_AGENT_PR_DRAFT_GUARD_DISABLE=1.
 * 7. 레포 허용 목록 (#969): 도구 호출이 닿는 레포를 원격 주소로 식별해 ~/.claude/ops-agent/repo-allowlist.local.json
 *    과 대조한다. 판정 호스트의 레포가 목록에 없으면 읽기부터, 읽기 전용이면 쓰기를 막는다. 목록 파일은 사람이 쓴다.
 *    다른 가드의 비활성 플래그와 무관하게 돈다. 목록 파일이 없으면 판정하지 않는다. 규칙은 repo-allowlist-rules.mjs.
 * 8. 글 판정 가드 (#1112): 이슈 · PR 본문 · 코멘트를 보내기 전에 문서 규칙 카운터로 확정 항목(L9 · PN8)을 판정해
 *    걸리면 차단한다. 비활성 OPS_AGENT_BODY_LINT_DISABLE=1.
 * 9. 가드 해제 대입 차단 (#1142): Bash 명령 글자에서 이름이 `_DISABLE` 로 끝나는 변수를 대입하면(명령 머리 · env · export
 *    · declare -x) 차단한다. 비활성 변수는 모두 사람이 세션 환경에서 켠다. 비활성 OPS_AGENT_DISABLE_ASSIGN_GUARD_DISABLE=1.
 * 10. 전문가 경유 지표 (#1154, ADR-0043): 공유 표면 쓰기(이슈 · PR 생성 · 본문 편집 · 댓글, PR 리뷰, gh api 댓글 · 리뷰, 범위 안 md 를 담은 커밋, 오버레이가 더한 도구)가
 *    통과할 때 그 세션의 기술 커뮤니케이션 전문가 판정 흔적을 찾아 경유 · 누락 · 판정 불가로 남긴다. 막지 않는다.
 *    경유는 전문가 호출 결과의 첫 줄 판정 표식뿐이다. 메인 텍스트의 표식 · 전문가 파일 직접 읽기는 경유가 아니다.
 *    오버레이 ~/.claude/ops-agent/route-surfaces.local.json. 비활성 OPS_AGENT_EXPERT_ROUTE_DISABLE=1.
 *
 * 키워드 소스: ~/.claude/ops-agent/confidential-keywords.local.json
 * 드라이런: OPS_AGENT_CONFIDENTIAL_DRYRUN=1 설정 시 차단 대신 경고만 출력
 * 비활성: OPS_AGENT_CONFIDENTIAL_DISABLE=1 설정 시 가드 전체 스킵
 */
import { execSync, execFileSync } from 'child_process';
import {
  readFileSync, existsSync, readdirSync, mkdirSync, appendFileSync, writeFileSync, openSync, readSync, closeSync, statSync,
  mkdtempSync, rmSync,
} from 'fs';
import { join, dirname, basename, resolve as resolvePath } from 'path';
import { homedir, tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { scanWhatViolations, snippet } from './what-guard-rules.mjs';
import { findIntrusions } from './han-intrusion.mjs';
import { detectGitRiskActions, stripGitGlobalOptions } from './git-guard-rules.mjs';
import { delegatedScopes, declaredScopes, DELEGATION_FILE_RE, DELEGATION_PHRASE } from './push-delegation.mjs';
import { changesOf, scanBuildScriptChange } from './build-guard-rules.mjs';
import { analyzeCommits, broadScopes } from './commit-scope.mjs';
import { harnessShapeMismatch, bashAllowRulesFrom } from './harness-rule-shape.mjs';
import {
  ALLOWLIST_FILE_RE, DENY_HEADER as ALLOWLIST_DENY_HEADER, registerHint, checkRepoAllowlist, loadAllowlist, runsRegisterScript,
} from './repo-allowlist-rules.mjs';
// 규칙 로딩·공개 여부 판정은 confidential-scan.mjs 와 공유한다.
// 복제하면 가드와 스캐너의 판정이 달라진다.
import {
  loadConfig, isEmptyConfig, parseRemote, lookupVisibility, shellQuote, findKeywordHits,
} from './confidential-rules.mjs';

// ─── 실행 예산 ───
// 훅이 하네스 타임아웃에 잘리면 그 호출의 검사는 성립하지 않고, 잘렸다는 사실도 남지 않는다.
// 가드가 걸려야 할 자리에서 조용히 빠지는 상태다. 그래서 잘리기 전에 스스로 답한다.
//
// 정상 경로 실측은 전체 37ms 이고 그중 노드 기동이 35ms 다. git 호출은 각 11ms 다.
// 예산 1500ms 는 그 40배이므로 정상 판정을 자르지 않는다. 예산을 넘기는 상황은
// 검사 대상이 커서가 아니라 머신 경합·입력 지연 쪽이고, 그때는 판정을 포기하고 알린다.
const HOOK_START = Date.now();
const HOOK_BUDGET_MS = Number(process.env.OPS_AGENT_HOOK_BUDGET_MS) || 1500;
const remainingMs = () => HOOK_BUDGET_MS - (Date.now() - HOOK_START);
// 하위 프로세스 타임아웃은 남은 예산 안에서만 준다. 내부 타임아웃 합이 예산을 넘으면
// 각 호출은 제 시간을 지켜도 훅 전체가 잘린다 (remote 2000 + diff 1200 > 예산이었다).
const budgeted = (want) => Math.max(150, Math.min(want, remainingMs()));
let budgetExceeded = false;
// 검사를 마치지 못한 채 통과시키는 것은 통과가 아니라 미검사다. 둘을 같은 모양으로 두지 않는다.
function noteBudgetExceeded(where) {
  if (budgetExceeded) return;
  budgetExceeded = true;
  process.stderr.write(`[ops-agent 훅] 실행 예산 ${HOOK_BUDGET_MS}ms 초과 — ${where} 검사를 마치지 못했습니다. 이 호출은 검사되지 않았습니다.\n`);
}

// ─── stdin 수집 ───
// EOF 를 기다리는 자리라 호출 측이 닫지 않으면 여기서 멈춘다. 예산 안에서만 기다린다.
let input = '';
process.stdin.setEncoding('utf8');
{
  let timer;
  const stdinDeadline = new Promise(res => { timer = setTimeout(() => res('deadline'), Math.max(150, remainingMs())); });
  const collect = (async () => {
    for await (const chunk of process.stdin) { input += chunk; }
    return 'eof';
  })();
  const which = await Promise.race([collect, stdinDeadline]);
  clearTimeout(timer);
  if (which === 'deadline') {
    noteBudgetExceeded('입력 수집');
    process.exit(0); // 판정 없음. 하네스 기본 동작(통과)에 맡기고 사실만 남긴다
  }
}

// ─── 대외비 가드 ───
const DISABLE = process.env.OPS_AGENT_CONFIDENTIAL_DISABLE === '1';
const DRYRUN = process.env.OPS_AGENT_CONFIDENTIAL_DRYRUN === '1';

const WHAT_GUARD_DISABLE = process.env.OPS_AGENT_WHAT_GUARD_DISABLE === '1';
const WHAT_GUARD_DRYRUN = process.env.OPS_AGENT_WHAT_GUARD_DRYRUN === '1';

// 한자 섞임 가드 (#1107): 커밋 메시지 · PR 제목 · 본문에 한글과 붙은 한자가 있으면 막는다.
// 판정은 이슈 어댑터와 같은 모듈(han-intrusion.mjs)이 하고, 비활성 변수도 그 모듈의 것을 쓴다.
const HAN_GUARD_DISABLE = process.env.OPS_AGENT_HAN_GUARD_DISABLE === '1';
const HAN_PR_WRITE_RE = /\bgh\s+pr\s+(?:create|edit|comment|review)\b/;
// `-F -` · `--file -` · `--body-file -` 은 표준 입력이 본문이다. 이때는 heredoc 본문을 함께 본다
const STDIN_BODY_RE = /(?:^|\s)(?:-F|--file|--body-file)(?:=|\s+)-(?=\s|$)/;
const HEREDOC_RE = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n([\s\S]*?)\n[ \t]*\2(?=\s|\)|$)/g;

// 글 판정 가드 (#1112): 트래커 · PR 본문을 보내기 직전에 문서 규칙 카운터로 판정한다.
// 판정은 카운터(readability_count.py)가 하고 이 훅은 부르기만 한다. 이슈 생성 어댑터와 다른 트래커 어댑터도 같은 카운터를 부른다.
// 차단은 기계로 확정되는 규칙(BODY_LINT_RULES)만 한다. 대상 · 영향 근거 같은 판단 재료는 차단 안내에 점검 질문으로 싣는다.
const BODY_LINT_DISABLE = process.env.OPS_AGENT_BODY_LINT_DISABLE === '1';
const BODY_WRITE_RE = /\bgh\s+(?:issue\s+(?:create|edit|comment)|pr\s+(?:create|edit|comment|review))\b/;
const BODY_LINT_RULES = 'L9,PN8';
const BODY_LINT_COUNTER = join(dirname(fileURLToPath(import.meta.url)), '..', 'config', 'style-rules', 'metrics', 'readability_count.py');

// 이슈 생성 가드 (#696): 어시스턴트의 `gh issue create` · `gh api …/issues` 직접 호출을 거부하고
// 어댑터(scripts/gh-issue.sh)로 보낸다. 생성 경로가 하나여야 본문 규칙 · 시작 결정이 실행된다.
const ISSUE_CREATE_GUARD_DISABLE = process.env.OPS_AGENT_ISSUE_CREATE_GUARD_DISABLE === '1';
const ISSUE_CREATE_GUARD_DRYRUN = process.env.OPS_AGENT_ISSUE_CREATE_GUARD_DRYRUN === '1';
// 어댑터 호출. 대외비 · What 가드가 이 호출의 제목 · 본문 파일을 직접 호출과 같이 본다.
const ISSUE_ADAPTER_RE = /\bgh-issue\.sh\s+(create|start)\b/;
// gh api 토큰 판정용. 값을 받는 플래그는 다음 토큰을 건너뛰고, 파라미터 플래그가 있으면 메서드 기본값이 POST 다.
const GH_API_VALUE_FLAGS = new Set([
  '-X', '--method', '-f', '--raw-field', '-F', '--field', '--input', '-H', '--header', '-p', '--preview',
  '-q', '--jq', '-t', '--template', '--hostname', '--cache',
]);
const GH_API_PARAM_FLAGS = /^(?:-f|--raw-field|-F|--field|--input)(?:=|$)/;

// 초안 PR 가드 (#876): `gh pr create` 에 초안 플래그가 없으면 거부한다. PR 가이드는 초안 생성을 정해 두었고,
// 플로우 진입 가드(#773)는 가이드를 읽었는지로 추정해 진입 문서만 읽은 세션을 통과시켰다. 규칙을 명령에서 직접 본다.
const PR_DRAFT_GUARD_DISABLE = process.env.OPS_AGENT_PR_DRAFT_GUARD_DISABLE === '1';
const PR_DRAFT_GUARD_DRYRUN = process.env.OPS_AGENT_PR_DRAFT_GUARD_DRYRUN === '1';
// 최상위 생성 명령. `env` 접두와 `create` 앞의 -R/--repo 도 같은 생성이다. 판정은 detectNonDraftPrCreate.
const PR_CREATE_RE = /^(?:env\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*)?(?:\S*\/)?gh\s+pr\s+(?:(?:-R|--repo)(?:=\S+|\s+\S+)\s+)*create\b/;
// 준비 완료 전환(#977). 전환은 리뷰어에게 알림이 가는 행동이라 작성자가 웹에서 한다. 리뷰 준비와 머지 준비는 초안 상태로 진행한다.
// `--undo`(초안으로 되돌림)는 대상이 아니다. GraphQL 전환 mutation 도 같은 전환이다. 판정은 detectPrReady.
const PR_READY_RE = /^(?:env\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*)?(?:\S*\/)?gh\s+pr\s+(?:(?:-R|--repo)(?:=\S+|\s+\S+)\s+)*ready\b/;
const PR_READY_GRAPHQL_RE = /^(?:env\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*)?(?:\S*\/)?gh\s+api\s+graphql\b.*\bmarkPullRequestReadyForReview\b/;

const BUILD_GUARD_DISABLE = process.env.OPS_AGENT_BUILD_GUARD_DISABLE === '1';

// 한시 권한 플래그 (레거시 OPS_AGENT_CLUSTER_GUARD_* 도 계속 인식)
const GATE_DISABLE = process.env.OPS_AGENT_ACTION_GATE_DISABLE === '1' || process.env.OPS_AGENT_CLUSTER_GUARD_DISABLE === '1';
const GATE_DRYRUN = process.env.OPS_AGENT_ACTION_GATE_DRYRUN === '1' || process.env.OPS_AGENT_CLUSTER_GUARD_DRYRUN === '1';

// 레포 유형 상수 (ADR-0028). 판정 함수는 아래 findRepoRoot 옆에 있다. 훅 본문이 모듈 위쪽에서 돌아 상수가 먼저 있어야 한다.
const REPO_TYPES = new Set(['work', 'principle', 'storage']);
const REPO_TYPE_FILE = /(?:^|[\\/])\.ops-agent[\\/]repo-type\.json$/;

const REPO_TYPE_DENY_EDIT = '[ops-agent 레포 유형 · 차단] 유형 선언은 사람이 한다 (ADR-0028). `!` 로 직접 쓴다.\n\n'
  + '예시 (저장소 유형):\n'
  + '  ! mkdir -p .ops-agent && echo \'{"type": "storage"}\' > .ops-agent/repo-type.json\n'
  + '값: work | principle | storage. 선언이 없으면 work 로 본다.';

// 최종 점검 통과 기록 (#612). 게이트 플래그와 독립이다. 게이트가 열려 있어도 통과 기록은 따로 본다.
const FINAL_CHECK_DISABLE = process.env.OPS_AGENT_FINAL_CHECK_DISABLE === '1';

// 플로우 진입 지표 (#769). 커밋 · push 는 세기만 하고, 가이드를 읽지 않은 세션의 PR 생성은 막는다 (#773).
// 비활성 OPS_AGENT_FLOW_ENTRY_DISABLE=1 (기록과 차단 모두).
const FLOW_ENTRY_DISABLE = process.env.OPS_AGENT_FLOW_ENTRY_DISABLE === '1';
// 스킬 사용 지표 (#1135). Skill 도구 호출과 설치본 SKILL.md Read 를 세션 · 스킬당 첫 1회 센다. 비활성 OPS_AGENT_SKILL_USE_DISABLE=1.
const SKILL_USE_DISABLE = process.env.OPS_AGENT_SKILL_USE_DISABLE === '1';
// 판정 상수는 훅 본문보다 위에 둔다 (아래로 내리면 초기화 전 접근).
// 설치본 경로: plugins/cache/<마켓>/<플러그인>/<버전>/skills/<이름>/SKILL.md 또는 ops-agent/current/skills/<이름>/SKILL.md
const SKILL_INSTALL_PATH_RE = /\/\.claude\/(?:plugins\/cache\/[^/]+\/([^/]+)\/[^/]+|ops-agent\/current)\/skills\/([A-Za-z0-9][A-Za-z0-9_.-]*)\/SKILL\.md$/;
const SKILL_NAME_RE = /^(?:[A-Za-z0-9][A-Za-z0-9_.-]*:)?[A-Za-z0-9][A-Za-z0-9_.-]*$/;
// ops-agent 스킬은 이름만, 다른 플러그인 스킬은 「플러그인:이름」으로 센다. 플러그인마다 같은 이름의 스킬이 있다
const skillUseName = (plugin, name) => (!plugin || plugin === 'ops-agent' ? name : `${plugin}:${name}`);
const SKILL_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
// 훅 본문이 모듈 위쪽에서 돌아 판정 상수도 여기 있어야 한다. 아래로 내리면 초기화 전 접근으로 가드 전체가 내부 오류가 된다.
// 흔적은 가이드 파일을 대상으로 한 Read 호출과 flow 스킬 호출뿐이다 (#1116). 둘 다 하네스가 내용을 컨텍스트에 넣는다.
// 셸 명령 인자 · 위임 문구 · 트리거 표 · 테스트 픽스처에 든 경로 문자열은 읽음이 아니다. 문자열로 찾으면 그 모두가
// 읽음이 되므로, 후보 줄만 문자열로 고르고 그 줄을 JSON 으로 풀어 assistant 의 tool_use 블록인지 확인한다.
const FLOW_GUIDE_PATH_RE = /skills\/flow\/(?:SKILL\.md|guides\/)/;
const FLOW_ENTRY_CANDIDATE_RE_G = /skills\/flow\/(?:SKILL\.md|guides\/)|"skill":"(?:ops-agent:)?flow"/g;
const FLOW_SKILL_RE = /^(?:ops-agent:)?flow$/;
// 서브에이전트 기록 경로 조각 (#1114). agent_id · session_id 가 이 형식일 때만 경로에 넣는다.
const SUBAGENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
// 압축 경계 (#891). 이 줄 뒤의 읽음만 인정한다.
const COMPACT_BOUNDARY_RE = /"subtype":"compact_boundary"/g;
const FLOW_ACTION_RES = [
  ['commit', /^(?:\S*\/)?git(?:\s+-C\s+\S+)*\s+commit\b/],
  ['push', /^(?:\S*\/)?git(?:\s+-C\s+\S+)*\s+push\b/],
  ['pr', /^(?:\S*\/)?gh\s+pr\s+create\b/],
];
const FLOW_SCAN_CHUNK = 4 << 20;
// 전문가 경유 지표 (#1154). 판정 상수도 훅 본문보다 위에 둔다 (초기화 전 접근 방지).
// 기록은 통과하는 호출의 respondContinue 안에서만 한다. 뒤 가드에 막힌 쓰기를 세면 재시도가 두 번 남는다.
const EXPERT_ROUTE_DISABLE = process.env.OPS_AGENT_EXPERT_ROUTE_DISABLE === '1';
const ROUTE_OVERLAY_FILE = () => join(homedir(), '.claude', 'ops-agent', 'route-surfaces.local.json');
const ROUTE_GH = String.raw`^(?:env\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*)?(?:\S*\/)?gh\s+`;
const ROUTE_REPO_OPT = String.raw`(?:(?:-R|--repo)(?:=\S+|\s+\S+)\s+)*`;
// [표면 이름, 세그먼트 정규식, 본문 인자가 있어야 하는가]. 대상은 전문가 파일 「범위」 표의 글이다(ADR-0043 결정 1).
// 본문 인자가 없는 편집 · 댓글 · 리뷰(제목만 편집, 승인만, 댓글 삭제)는 글을 쓰지 않으므로 뺀다.
const ROUTE_BUILTIN = [
  ['issue-create', /(?:^|[\s/])gh-issue\.sh\s+create\b/, false],
  ['issue-edit', new RegExp(`${ROUTE_GH}${ROUTE_REPO_OPT}issue\\s+${ROUTE_REPO_OPT}edit\\b`), true],
  ['issue-comment', new RegExp(`${ROUTE_GH}${ROUTE_REPO_OPT}issue\\s+${ROUTE_REPO_OPT}comment\\b`), true],
  ['pr-create', new RegExp(`${ROUTE_GH}${ROUTE_REPO_OPT}pr\\s+${ROUTE_REPO_OPT}create\\b`), false],
  ['pr-edit', new RegExp(`${ROUTE_GH}${ROUTE_REPO_OPT}pr\\s+${ROUTE_REPO_OPT}edit\\b`), true],
  ['pr-comment', new RegExp(`${ROUTE_GH}${ROUTE_REPO_OPT}pr\\s+${ROUTE_REPO_OPT}comment\\b`), true],
  ['pr-review', new RegExp(`${ROUTE_GH}${ROUTE_REPO_OPT}pr\\s+${ROUTE_REPO_OPT}review\\b`), true],
];
const ROUTE_BODY_FLAG_RE = /(?:^|\s)(?:--body(?:-file)?|-b|-F)(?:=|\s|$)/;
// gh api 로 쓰는 댓글 · 리뷰. 경로(쿼리스트링 제외)와 쓰기 메서드로 본다. 메서드 판정은 이슈 생성 가드와 같은 parseGhApi 다.
// 이슈 댓글 경로는 PR 대화 댓글도 받는다(GitHub 은 PR 을 이슈로도 다룬다). 그래서 명령 이름이 아니라 api-* 로 남긴다.
const ROUTE_GH_API_RE = new RegExp(`${ROUTE_GH}api\\b`);
const ROUTE_API_WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT']);
const ROUTE_API_PATHS = [
  ['api-comment', /(?:^|\/)issues\/(?:\d+\/comments|comments\/\d+)$/],
  ['api-review', /(?:^|\/)pulls\/(?:\d+\/(?:reviews(?:\/\d+(?:\/events)?)?|comments(?:\/\d+\/replies)?)|comments\/\d+)$/],
];
const ROUTE_API_MUTATIONS = [
  ['api-comment', /\b(?:addComment|updateIssueComment)\b/],
  ['api-review', /\b(?:addPullRequestReview(?:Comment|Thread(?:Reply)?)?|submitPullRequestReview|updatePullRequestReview(?:Comment)?)\b/],
];
const ROUTE_API_BODY_FIELD_RE = /(?:^|\s)(-f|--raw-field|-F|--field)(?:=|\s+)body=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/g;
const ROUTE_API_INPUT_RE = /(?:^|\s)--input(?:=|\s+)(\S+)/g;
// 레포 문서는 초고 쓰기(Write · Edit)가 판정보다 먼저 와서, 「판정 뒤 보낸다」를 커밋 시점에 본다(commit-md).
// 커밋 판별은 플로우 진입과 같은 정규식이다. 변경 기록은 커밋 메시지와 같은 장르라 범위 표 「다루지 않는다」를 따라 뺀다.
const ROUTE_DOC_RE = /\.md$/i;
// 변경 기록의 이름은 둘로 나눈다. CHANGELOG 는 대소문자를 가리지 않고(changelog.md), CHANGES · HISTORY · NEWS ·
// RELEASES · RELEASE_NOTES 는 대문자일 때만 본다(docs/history.md 같은 소문자 이름은 레포 문서다).
// 접미는 언어 코드(.ko · .zh-Hant-TW) · 판 번호(-v2 · .1.2) · 보관(.old · -archive)만 받는다(changelog-guide.md 는 레포 문서다).
// 변경 기록 디렉토리(changelog/ · changelogs/ · .changeset/) 아래 md 도 뺀다.
const CHANGELOG_SUFFIX = String.raw`(?:\.[a-z]{2}(?:-[A-Za-z]{2,4}){0,2}|[-.]v?\d[\w.]*|[-.](?:old|archive))?\.md$`;
const ROUTE_DOC_EXCLUDED = [
  new RegExp(String.raw`(?:^|/)changelog` + CHANGELOG_SUFFIX, 'i'),
  new RegExp(String.raw`(?:^|/)(?:CHANGES|HISTORY|NEWS|RELEASES|RELEASE[-_]NOTES)` + CHANGELOG_SUFFIX),
  /(?:^|\/)(?:changelogs?|\.changeset)\//i,
];
const isChangelogDoc = path => ROUTE_DOC_EXCLUDED.some(re => re.test(path));
// 흔적 후보 줄만 문자열로 고르고 JSON 으로 풀어 확인한다. 플로우 진입과 같은 방식이다 (#1116).
const EXPERT_CANDIDATE_RE_G = /experts\/tech-comm\.md|tech-comm-verdict|agentId|"skill":"(?:ops-agent:)?expert"|"subtype":"compact_boundary"/g;
const EXPERT_FILE_SUFFIX = '/experts/tech-comm.md';
const EXPERT_SKILL_RE = /^(?:ops-agent:)?expert$/;
const EXPERT_VERDICT_RE = /^\[tech-comm-verdict: (pass|revise|hold)\]/;
const AGENT_ID_TEXT_RE = /agentId: ([A-Za-z0-9_-]{1,128})/;
// 완료 알림은 문자열이 알림으로 시작할 때만 본다(사용자가 붙여 넣은 글 중간의 알림 형식은 세지 않는다). 한 문자열에 알림이 여럿일 수 있다.
const TASK_NOTE_START_RE = /^<task-notification>/;
// 알림 하나는 여는 태그부터 닫는 태그(또는 다음 알림 · 끝)까지다. 그 안에서만 호출 번호와 결과를 찾는다(결과 없는 알림이 뒤 알림의 결과를 가져가지 않게).
const TASK_NOTE_RE_G = /<task-notification>([\s\S]*?)(?:<\/task-notification>|(?=<task-notification>)|$)/g;
const NOTE_ID_RE = /<tool-use-id>([^<]+)<\/tool-use-id>/;
const NOTE_RESULT_RE = /<result>([\s\S]*?)<\/result>/;
// 결과를 넘김(SubagentHandback)으로 받으면 결과 자리에는 안내만 있고, 보고는 이 틀로 따로 온다. 하네스가 보고의 줄마다 들여쓴다.
// 한 내용에 넘김 틀이 여럿일 수 있다. 보고는 닫는 태그 · 다음 틀 · 끝 중 먼저 오는 자리까지다.
// 넘김 틀 하나는 여는 태그부터 닫는 태그(또는 다음 틀 · 끝)까지다. 보고는 그 안의 「The report follows:」 뒤다(보고 없는 틀이 뒤 틀의 보고를 가져가지 않게).
const HANDBACK_RE_G = /<agent-message from="([A-Za-z0-9_-]{1,128})">([\s\S]*?)(?:<\/agent-message>|(?=<agent-message from=)|$)/g;
const HANDBACK_REPORT_RE = /The report follows:\n([\s\S]*)/;
// 공유 표면 쓰기를 기록할 호출 입력. 가드를 모두 통과한 뒤 respondContinue 가 판정한다.
let routeInput = null;
const FLOW_PR_DENY = '[ops-agent 플로우 진입 · 차단] 이 세션은 플로우 가이드를 읽지 않고(또는 압축 뒤 다시 읽지 않고) PR 을 만듭니다 (#773 · #891).\n'
  + 'PR 생성의 초안 · 본문 · 리뷰 요청 순서는 가이드에 있습니다. 먼저 읽고 가이드 절차(초안 생성)대로 다시 만듭니다:\n'
  + '  ~/.claude/ops-agent/current/skills/flow/guides/pr.md\n'
  + '읽으면 다음 컨텍스트 압축 전까지 통과합니다. 비활성: 사람이 세션 환경에서 OPS_AGENT_FLOW_ENTRY_DISABLE=1 (명령 앞 대입은 차단)';
const finalCheckDir = () => join(homedir(), '.claude', 'ops-agent', '.cache', 'final-check');
// `gh pr merge` 가 값을 취하는 플래그. 값이 PR 번호 자리로 읽히지 않게 먼저 걷어낸다.
const MERGE_VALUE_FLAG = /(?:^|\s)(?:-[btFAR]|--(?:body|body-file|subject|match-head-commit|author-email|repo))(?:\s+|=)(?:"[^"]*"|'[^']*'|\S+)/g;

// 운영 클러스터 쓰기 가드 — mutating verb / 값 취하는 플래그 세트.
// (가드 호출이 최상위 await 컨텍스트라 const 초기화가 먼저 끝나도록 상단에 선언 — TDZ 회피)
// 동거 검사(#386)용 패턴. 게이트 호출보다 먼저 초기화되어야 하므로 여기 둔다.
// 갈래 앞에 와도 판정 출력이 없는 명령: 주석·디렉토리 이동·환경 설정.
const COHABIT_BENIGN = /^(?:#|cd\b|export\b|set\b|umask\b|source\b|\.\s|true$|:$)/;
// 예외: 판정을 **종료 코드로** 돌려주는 검사 스크립트. `&&` 로 물리면 검출 시 다음 명령이
// 실행되지 않으므로, 사람이 출력을 읽지 않아도 결과가 집행된다. 문자열로만 알리는 스니펫과
// 다른 것은 이 한 가지다.
const COHABIT_GATE_CHECK = /(?:^|[\/\s])pre-merge-check\.sh(?:\s|$)/;

const KUBECTL_WRITE = new Set([
  'apply', 'patch', 'replace', 'delete', 'edit', 'scale', 'annotate', 'label',
  'set', 'cordon', 'drain', 'uncordon', 'taint', 'rollout', 'create', 'expose',
  'autoscale', 'run', 'exec', 'cp', 'attach', 'certificate',
]);
// 파드 안으로 들어가거나 파일을 옮기는 동사. 쓰기 갈래와 따로 열 수 있게 갈래를 나눈다 (#445).
// 원격 명령의 내용은 보지 않는다. 호환을 위해 cluster-write 가 열려 있으면 이 갈래도 통과한다.
const KUBECTL_EXEC = new Set(['exec', 'cp']);
const ARGOCD_WRITE = new Set([
  'create', 'delete', 'set', 'unset', 'sync', 'rollback', 'patch', 'add', 'rm',
  'terminate-op', 'actions', 'update-password',
]);
const HELM_WRITE = new Set(['install', 'upgrade', 'uninstall', 'delete', 'rollback']);
// 커밋 diff 검사 상한 (같은 TDZ 사유로 상단 선언)
const DIFF_SCAN_LIMIT = 256 * 1024;
// `git commit` 판정. git 과 서브커맨드 사이에는 전역 옵션이 올 수 있다.
// `\bgit\s+commit\b` 만 쓰면 `git -C <path> commit` 이 커밋으로 인식되지 않아
// 파일 내용 검사가 통째로 건너뛰어진다. 알려진 전역 옵션 형태만 허용해
// `git log --grep commit` 같은 조회 명령을 오인하지 않는다.
const GIT_GLOBAL_OPT = String.raw`(?:-[cC]\s+\S+|--(?:git-dir|work-tree|namespace|exec-path)(?:=\S+|\s+\S+)|--no-pager|--no-replace-objects|--bare|--literal-pathspecs|-p|--paginate)`;
const GIT_COMMIT_RE = new RegExp(String.raw`\bgit\s+(?:${GIT_GLOBAL_OPT}\s+)*commit\b`);
// 커밋 세그먼트(전문가 경유 commit-md). 세그먼트 머리에서만 보고, git 과 commit 사이 전역 옵션(-c · -C 등)을 받는다.
const ROUTE_COMMIT_RE = new RegExp(String.raw`^(?:\S*\/)?git\s+(?:${GIT_GLOBAL_OPT}\s+)*commit\b`);
const VALUE_FLAGS = new Set([
  '-n', '--namespace', '--context', '--cluster', '--user', '--kubeconfig',
  '-o', '--output', '-l', '--selector', '--field-selector', '-f', '--filename',
  '--server', '--token', '--as', '--as-group', '--cache-dir', '--request-timeout',
  '--grpc-web-root-path',
]);

let truncationNotice = '';
// 통과하는 호출에 붙이는 조치 한 줄 (도구 경계 로드, docs/lessons.md 「도구 경계에서 로드한다」).
let passNotice = '';
const ROADMAP_NOTICE = '[ops-agent 이슈 생성 · 알림] 진행 중인 로드맵 이슈에 담을 일이면 새 이슈가 아니라 그 이슈의 항목(체크박스)으로 더한다. 원칙: docs/working-principles.md 「이슈는 그 이슈만으로 착수된다」';
const ISSUE_ADAPTER_CREATE_RE = /\bgh-issue\.sh\s+create\b/;

// ─── 가드 해제 대입 차단 (#1142) ───
// 이 훅은 하네스가 띄운 별도 프로세스라 명령 앞 대입이 닿지 않지만, 명령이 부르는 스크립트(이슈 생성 어댑터 등)가
// 스스로 읽는 해제 변수는 `X_DISABLE=1 bash …` 로 꺼진다. 해제는 사람이 세션 환경에서 한다.
// 다른 가드의 비활성 플래그 · 시간 예산과 무관하게 맨 앞에서 돈다. 판정 범위는 docs/action-gate.md 「가드 해제 대입 차단」.
const DISABLE_ASSIGN_GUARD_DISABLE = process.env.OPS_AGENT_DISABLE_ASSIGN_GUARD_DISABLE === '1';
const ASSIGN_WORD_RE = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const DISABLE_ASSIGN_WORD_RE = /^([A-Za-z_][A-Za-z0-9_]*_DISABLE)\+?=/;
// 뒤에 오는 낱말이 다시 명령 머리가 되는 예약어
const COMMAND_HEAD_KEYWORDS = new Set(['!', '{', 'if', 'then', 'elif', 'else', 'do', 'while', 'until', 'time']);
// env 의 값을 받는 옵션. 값 자리의 낱말을 대입으로 읽지 않게 건너뛴다
const ENV_VALUE_OPTS = new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']);
{
  let name = null;
  if (!DISABLE_ASSIGN_GUARD_DISABLE) {
    try {
      const hookInput = JSON.parse(input);
      if ((hookInput.tool_name || '') === 'Bash') name = findDisableAssignment(String((hookInput.tool_input || {}).command || ''));
    } catch { /* 입력을 읽지 못하면 판정할 명령이 없다. 아래 가드도 같은 입력을 다룬다 */ }
  }
  if (name) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
        permissionDecisionReason: `[ops-agent 가드 해제 대입 · 차단] 가드 해제는 사람만 한다. 필요하면 사람이 세션 환경에서 켠다 (대입: ${name}). 해제를 한시 권한으로 넘기는 일은 #1144.` },
    }));
    process.exit(0);
  }
}

// ─── 레포 허용 목록 (#969) ───
// 다른 가드의 비활성 플래그와 무관하게 돈다. 판정하지 못하면(목록 파일 깨짐 등) 통과시키되 사실을 알린다.
{
  let deny = null;
  try {
    const hookInput = JSON.parse(input);
    const toolName = hookInput.tool_name || '';
    const allow = loadAllowlist();
    if (toolName === 'Bash' && runsRegisterScript(hookInput.tool_input && hookInput.tool_input.command)) {
      deny = `${ALLOWLIST_DENY_HEADER} 허용 목록 등록 명령은 사용자가 실행합니다.\n${registerHint()}`;
    } else if (allow && writesGuardedFile(toolName, hookInput.tool_input, ALLOWLIST_FILE_RE, 'repo-allowlist')) {
      deny = `${ALLOWLIST_DENY_HEADER} 허용 목록 파일은 어시스턴트가 쓰지 않습니다.\n${registerHint()}`;
    } else if (allow) {
      deny = checkRepoAllowlist(allow, toolName, hookInput.tool_input, hookInput.cwd || process.cwd());
    }
  } catch (e) {
    truncationNotice += `[ops-agent 레포 허용 목록] 판정하지 못했습니다: ${(e && e.message) || e}. 이 호출은 목록 대조 없이 진행됩니다.\n`;
  }
  if (deny) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: deny },
    }));
    process.exit(0);
  }
}

// 전문가 경유 지표: 입력만 잡아 두고 판정 · 기록은 통과할 때 한다. 가드 예산을 대화 기록 읽기에 먼저 쓰지 않는다.
// 지표는 가드가 아니라 대외비 가드를 끈 세션에서도 기록한다. 끄는 것은 경유 지표 비활성 변수 하나다.
try {
  const hookInput = JSON.parse(input);
  if (!EXPERT_ROUTE_DISABLE && /^(?:Bash|mcp__.+)$/.test(hookInput.tool_name || '')) routeInput = hookInput;
} catch { /* 입력을 읽지 못하면 기록할 호출이 없다 */ }

if (!DISABLE) {
  try {
    const hookInput = JSON.parse(input);
    // 스킬 사용 기록은 Skill · Read 가 아니면 아무 IO 도 하지 않는다. 판정은 기록만 하고 바꾸지 않는다.
    if (!SKILL_USE_DISABLE) recordSkillUse(hookInput);
    // 레포 유형 선언 편집 차단 (ADR-0028). 유형은 사람이 선언한다.
    if (writesRepoTypeFile(hookInput.tool_name || '', hookInput.tool_input)) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: REPO_TYPE_DENY_EDIT },
      }));
      process.exit(0);
    }
    // 대화창 위임 기록 편집 차단 (#1046). 위임은 사람의 입력을 받은 훅만 쓴다.
    if (writesGuardedFile(hookInput.tool_name || '', hookInput.tool_input, DELEGATION_FILE_RE, 'push-delegation')) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
          permissionDecisionReason: `[ops-agent 푸시 권한 위임 · 차단] 위임 기록은 사람이 대화창에 「${DELEGATION_PHRASE}」을 입력했을 때 훅만 쓴다. 어시스턴트는 쓰지 않는다.` },
      }));
      process.exit(0);
    }
    // 어시스턴트의 게이트 개방 차단 (#1060). 개방 스크립트 on · 대화창 개방 훅 실행을 막아 개방이 사람의 행위로 남게 한다.
    if ((hookInput.tool_name || '') === 'Bash' && opensGateByAssistant((hookInput.tool_input || {}).command || '')) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
          permissionDecisionReason: '[ops-agent 게이트 개방 · 차단] 게이트는 사람이 연다. 개방 스크립트의 on 과 대화창 개방 훅은 어시스턴트가 실행하지 않는다. 개방 명령을 사람에게 제시하고 기다린다 (터미널은 ! 명령, 셸 실행이 없는 대화창은 같은 한 줄을 메시지로).' },
      }));
      process.exit(0);
    }
    // 빌드 스크립트 가드: 번들을 쓰는 레포의 모듈 빌드 스크립트에 라이브러리 좌표가 더해지면 알린다.
    // 편집은 되돌릴 수 있어 막지 않는다 (README 「되돌릴 수 없는 것만 막는다」). 컴파일이 되니 알리지 않으면 리뷰 전까지 드러나지 않는다 (#574).
    if (!BUILD_GUARD_DISABLE && /^(?:Write|Edit|MultiEdit)$/.test(hookInput.tool_name || '')) {
      const notices = [];
      for (const change of changesOf(hookInput.tool_name, hookInput.tool_input)) {
        const buildResult = scanBuildScriptChange(change);
        if (!buildResult.blocked) continue;
        const hitLines = buildResult.hits.map(h => `  - ${h}`).join('\n');
        notices.push(`[ops-agent 빌드 스크립트 가드 · 알림] 모듈 빌드 스크립트에 라이브러리 좌표가 더해집니다:\n${hitLines}\n` +
          `파일: ${change.filePath}\n` +
          `모듈 스크립트에는 계층 적용과 모듈 간 의존만 둡니다. 번들이 이미 올리는 라이브러리인지 확인하고, 아니면 번들(gradle/lib/*.gradle)로 옮깁니다.\n` +
          `가이드: ~/.claude/ops-agent/current/skills/flow/guides/implement.md`);
      }
      if (notices.length) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: notices.join('\n\n') },
        }));
        process.exit(0);
      }
    }
    if ((hookInput.tool_name || '') === 'Bash') {
      const command = (hookInput.tool_input && hookInput.tool_input.command) || '';
      const cwd = hookInput.cwd || process.cwd();
      const flowEntry = recordFlowEntry(command, hookInput, cwd);
      // PR 생성은 공유 표면에 알림이 나가 되돌릴 수 없다. 가이드(초안 생성 · 본문 규칙)를 읽지 않은 세션이면 막는다.
      // 판정하지 못한 경우(unknown)는 막지 않는다. 커밋 · push 는 되돌릴 수 있어 세기만 한다 (#773).
      if (flowEntry && flowEntry.flow === 'missed' && flowEntry.actions.includes('pr')) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: FLOW_PR_DENY },
        }));
        process.exit(0);
      }
      const result = runConfidentialGuard(command, cwd);
      if (result.blocked) {
        const header = DRYRUN ? '[ops-agent 대외비 가드 · 드라이런]' : '[ops-agent 대외비 가드 · 차단]';
        const hitLines = result.hits.map(h =>
          `  - "${h.keyword}" (${h.source}): ${h.context}`).join('\n');
        const scope = result.target ? result.target.scope : 'public';
        const what = result.undeterminable
          ? '커밋 대상 레포를 판별할 수 없어 파일 내용을 검사하지 못함'
          : scope === 'internal'
            ? '사내 공유 표면 쓰기에서 개인 환경 흔적 히트'
            : '공개 표면 쓰기에서 대외비 히트';
        const targetInfo = result.target
          ? `\n표면: ${scope} (${result.target.reason})`
          : '';
        const msg = result.undeterminable
          ? `${header} ${what}:\n  ${result.undeterminable}\n\n`
            + `해결: 아래 중 하나로 다시 실행한다.\n`
            + `  - 그 레포를 작업 디렉토리로 두고 셸 변수 없이 실행\n`
            + `  - \`cd\` · \`git -C\` 인자에 실제 경로를 쓴다 (훅은 셸 변수를 확장할 수 없다)\n`
            + `검사하지 못한 상태를 통과로 두지 않는다. 대외비 가드에서 미검사와 무해는 다르다.`
          : `${header} ${what}:${targetInfo}\n${hitLines}\n\n`
            + `해결: 본문·제목·메시지 또는 커밋 대상 파일에서 해당 키워드 제거 후 재시도.\n`
            + `커밋 대상 diff 는 추가된 줄만 검사한다. 키워드를 정당하게 다루는 경로는 설정의 allowPaths 로 제외.\n`
            + `가드는 호출 전체를 한 표면으로 본다(heredoc 본문 포함). 사내 명령과 공개 명령은 호출을 나누고, 본문 파일은 Write 로 쓴다.\n`
            + (scope === 'internal'
              ? `개인 인프라·부트스트랩 세부는 본인 공간에만 남긴다. 규칙 목록: 설정의 personalDevOnly\n`
              : `비공개 저장소면 표면이 private 로 잡혀야 한다. 잘못 잡혔으면 캐시를 확인한다:\n`
                + `  ~/.claude/ops-agent/cache/repo-visibility.json\n`)
            + `허용 리스트 조정: ~/.claude/ops-agent/confidential-keywords.local.json`;
        if (DRYRUN) {
          process.stderr.write(msg + '\n');
          respondContinue();
          process.exit(0);
        } else {
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: msg,
            },
          }));
          process.exit(0);
        }
      }

      // 검사 한도를 넘겨 일부만 본 경우, 차단하지 않아도 그 사실을 알린다.
      // 조용히 넘기면 "전부 검사됨" 으로 읽힌다.
      if (result.diffTruncated && !result.blocked) {
        truncationNotice = `[ops-agent 대외비 가드] 커밋 대상 diff 가 검사 한도(`
          + `${Math.floor(DIFF_SCAN_LIMIT / 1024)}KB)를 넘어 일부만 검사했습니다.\n`
          + `한도 이후 내용은 확인되지 않았습니다. 공개 표면 대상이면 직접 확인하세요.`;
      }

      // 도메인 What 추상화 가드: 커밋·PR·이슈 본문에서 구현 세부 노출 차단
      if (!WHAT_GUARD_DISABLE && remainingMs() <= 0) noteBudgetExceeded('What 추상화 가드');
      if (!WHAT_GUARD_DISABLE && remainingMs() > 0) {
        const whatResult = runWhatAbstractionGuard(command);
        if (whatResult.blocked) {
          const header = WHAT_GUARD_DRYRUN
            ? '[ops-agent What 추상화 가드 · 드라이런]'
            : '[ops-agent What 추상화 가드 · 차단]';
          const hitLines = whatResult.hits
            .map(h => `  - [${h.rule}] "${h.match}": ${h.context}`).join('\n');
          const msg = `${header} 본문에 구현 세부가 노출되어 있습니다.\n${hitLines}\n\n` +
            `해결: 도메인 행위·사용자 가치만 기술하세요. 클래스명·메서드명·어노테이션·헥사고날 어휘·yaml 키·산출물 카운트 모두 제거.\n` +
            `흐름은 mermaid flowchart/sequenceDiagram 사용.\n` +
            `가이드: ~/.claude/ops-agent/current/skills/flow/guides/commit.md 의 "도메인 What 추상화" 섹션\n` +
            `비활성: 사람이 세션 환경에서 OPS_AGENT_WHAT_GUARD_DISABLE=1 (예외 상황만. 명령 앞 대입은 차단)`;
          if (WHAT_GUARD_DRYRUN) {
            process.stderr.write(msg + '\n');
          } else {
            process.stdout.write(JSON.stringify({
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: msg,
              },
            }));
            process.exit(0);
          }
        }
      }

      // 한자 섞임 가드: 공개 표면 글(커밋 메시지 · PR 제목 · 본문)에 생성 중 바뀐 글자가 섞이면 막는다 (#1107)
      if (!HAN_GUARD_DISABLE && remainingMs() <= 0) noteBudgetExceeded('한자 섞임 가드');
      if (!HAN_GUARD_DISABLE && remainingMs() > 0) {
        const hanHits = runHanIntrusionGuard(command);
        if (hanHits.length) {
          const msg = `[ops-agent 한자 섞임 가드 · 차단] 보낼 글에 한글과 붙은 한자가 있습니다. 생성 중 바뀐 글자일 수 있습니다:\n`
            + hanHits.map(h => `  - (${h.source}) ${h.context}`).join('\n') + '\n\n'
            + `해결: 그 자리를 한글로 고치고 다시 실행합니다. 띄어 쓴 한자 낱말은 막지 않습니다.\n`
            + `범위: 커밋 메시지와 PR 제목 · 본문 · 코멘트만 봅니다. 커밋 대상 파일 내용은 보지 않습니다.\n`
            + `비활성: 사람이 세션 환경에서 OPS_AGENT_HAN_GUARD_DISABLE=1 (한자가 붙어야 하는 글만. 명령 앞 대입은 차단)`;
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: msg },
          }));
          process.exit(0);
        }
      }

      // 글 판정 가드: 보낼 본문이 문서 규칙의 확정 항목(L9 불릿 안 머리말 · PN8 물결표 취소선)에 걸리면 막는다 (#1112)
      if (!BODY_LINT_DISABLE && remainingMs() <= 0) noteBudgetExceeded('글 판정 가드');
      if (!BODY_LINT_DISABLE && remainingMs() > 0) {
        const lintHits = runBodyLintGuard(command);
        if (lintHits.length) {
          const msg = `[ops-agent 글 판정 가드 · 차단] 보낼 본문이 문서 규칙에 걸립니다:\n`
            + lintHits.map(h => `  - (${h.source}) ${h.line}행 [${h.rule}] ${h.message}`).join('\n') + '\n\n'
            + `해결: 머리말이 필요하면 소제목 줄로 올리고 그 아래 불릿은 내용만 씁니다 (readability L9). 물결표는 역슬래시로 이스케이프합니다 (punctuation PN8).\n`
            + `고치는 김에 받는 사람의 판단 재료를 봅니다 (tech-comm TC5 · TC6): 무엇이 대상인지 이 글만으로 알 수 있는가, 「영향 없음」 · 「문제없음」에 근거를 함께 적었는가.\n`
            + `범위: gh issue create · edit · comment 와 gh pr create · edit · comment · review 의 본문만 봅니다. 이슈 생성 어댑터는 스스로 같은 판정을 합니다.\n`
            + `비활성: 사람이 세션 환경에서 OPS_AGENT_BODY_LINT_DISABLE=1 (형식이 키를 정한 정의 목록이 걸릴 때만. 명령 앞 대입은 차단)`;
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: msg },
          }));
          process.exit(0);
        }
      }

      // 이슈 생성 가드: 생성은 어댑터(gh-issue.sh)로만 한다 (#696). 직접 호출은 본문 규칙 · 시작 결정을 거치지 않는다.
      if (!ISSUE_CREATE_GUARD_DISABLE && remainingMs() <= 0) noteBudgetExceeded('이슈 생성 가드');
      if (!ISSUE_CREATE_GUARD_DISABLE && remainingMs() > 0) {
        const issueHits = detectDirectIssueCreate(command);
        if (issueHits.length) {
          const header = ISSUE_CREATE_GUARD_DRYRUN
            ? '[ops-agent 이슈 생성 가드 · 드라이런]'
            : '[ops-agent 이슈 생성 가드 · 차단]';
          const msg = `${header} 이슈 생성은 어댑터로만 합니다. 직접 호출:\n${issueHits.map(h => `  - ${h}`).join('\n')}\n\n` +
            `어댑터 (본문 구조 검사 → 라벨 → 생성 → 시작 결정을 한 호출로):\n` +
            `  bash ~/.claude/ops-agent/current/scripts/gh-issue.sh create --title "<제목>" --body-file <본문.md> --type <feat|fix|docs|refactor|chore> \\\n` +
            `       (--start [--worktree|--checkout] | --no-start "<사유>") [-R <레포>] [--structure <iss1|iss5|iss6|iss7|iss10>]\n` +
            `필수 판단 둘:\n` +
            `  - 시작 결정: 지금 손대는 이슈면 --start, 백로그 · 후속이면 --no-start "<사유>"\n` +
            `  - 기존 기록: ISS5 본문 ## Why 에 「- 기존 기록: {이전 · 지금 · 바뀐 점 | 없음 · 찾은 자리}」 한 줄 (ADR-0027)\n` +
            `본문 규칙: config/style-rules/extensions/issue.md · 가이드: skills/flow/guides/issue.md\n` +
            `${ROADMAP_NOTICE}\n` +
            `드라이런: OPS_AGENT_ISSUE_CREATE_GUARD_DRYRUN=1 · 비활성: 사람이 세션 환경에서 OPS_AGENT_ISSUE_CREATE_GUARD_DISABLE=1 (명령 앞 대입은 차단)`;
          if (ISSUE_CREATE_GUARD_DRYRUN) {
            process.stderr.write(msg + '\n');
          } else {
            process.stdout.write(JSON.stringify({
              hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: msg },
            }));
            process.exit(0);
          }
        }
        // 어댑터 생성은 통과시키되 로드맵 이슈에 담을 일인지 조치 한 줄을 붙인다 (#1035).
        if (ISSUE_ADAPTER_CREATE_RE.test(command)) passNotice = ROADMAP_NOTICE;
      }

      // 초안 PR 가드: PR 은 초안으로 만든다 (#876). 준비 완료 전환(gh pr ready)은 작성자가 정하고 어시스턴트 호출은 막는다 (#977).
      if (!PR_DRAFT_GUARD_DISABLE && remainingMs() <= 0) noteBudgetExceeded('초안 PR 가드');
      if (!PR_DRAFT_GUARD_DISABLE && remainingMs() > 0) {
        // 드래프트 생략을 선언한 레포는 드래프트 없는 생성과 준비 완료 전환을 통과시킨다 (#1166).
        // 기본값은 드래프트 필수다. 선언을 빠뜨렸을 때 피해가 작은 쪽이다 (방화벽식 디폴트 디나이).
        const skipDraft = draftSkipDeclared(command, hookInput.cwd);
        const prHits = skipDraft ? [] : detectNonDraftPrCreate(command);
        const readyHits = skipDraft ? [] : detectPrReady(command);
        if (readyHits.length) {
          const header = PR_DRAFT_GUARD_DRYRUN
            ? '[ops-agent 초안 PR 가드 · 드라이런]'
            : '[ops-agent 초안 PR 가드 · 차단]';
          const msg = `${header} 준비 완료 전환은 작성자가 웹에서 합니다:\n${readyHits.map(h => `  - ${h}`).join('\n')}\n\n` +
            `리뷰 준비와 머지 준비(머지 전 최종 점검)는 초안 상태 그대로 진행합니다. 초안이라서 못 하는 단계는 없습니다.\n` +
            `가이드: ~/.claude/ops-agent/current/skills/flow/guides/pr.md 「초안으로 생성하고 작성자가 먼저 본다」\n` +
            `드라이런: OPS_AGENT_PR_DRAFT_GUARD_DRYRUN=1 · 비활성: 사람이 세션 환경에서 OPS_AGENT_PR_DRAFT_GUARD_DISABLE=1 (명령 앞 대입은 차단)`;
          if (PR_DRAFT_GUARD_DRYRUN) {
            process.stderr.write(msg + '\n');
          } else {
            process.stdout.write(JSON.stringify({
              hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: msg },
            }));
            process.exit(0);
          }
        }
        if (prHits.length) {
          const header = PR_DRAFT_GUARD_DRYRUN
            ? '[ops-agent 초안 PR 가드 · 드라이런]'
            : '[ops-agent 초안 PR 가드 · 차단]';
          const msg = `${header} PR 은 초안으로 만듭니다. 초안 플래그 없는 생성:\n${prHits.map(h => `  - ${h}`).join('\n')}\n\n` +
            `  gh pr create --draft --base <타겟> --title "<제목>" --body-file <본문파일>\n` +
            `준비 완료 전환(gh pr ready)과 리뷰 요청은 작성자가 웹에서 변경분을 본 뒤 합니다.\n` +
            `가이드: ~/.claude/ops-agent/current/skills/flow/guides/pr.md 「초안으로 생성하고 작성자가 먼저 본다」\n` +
            `드라이런: OPS_AGENT_PR_DRAFT_GUARD_DRYRUN=1 · 비활성: 사람이 세션 환경에서 OPS_AGENT_PR_DRAFT_GUARD_DISABLE=1 (명령 앞 대입은 차단)`;
          if (PR_DRAFT_GUARD_DRYRUN) {
            process.stderr.write(msg + '\n');
          } else {
            process.stdout.write(JSON.stringify({
              hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: msg },
            }));
            process.exit(0);
          }
        }
      }

      // 한시 권한: 되돌리기 어려운/외부 영향 행위(클러스터 mutation·PR 머지·릴리즈·force push
      // ·리소스 삭제)는 세션 명시 허용 없으면 차단한다. 권한을 추측해 실행하는 사고를 기계적으로 막는다.
      if (!GATE_DISABLE && remainingMs() <= 0) noteBudgetExceeded('한시 권한');
      if (!GATE_DISABLE && remainingMs() > 0) {
        // 업무 · 사상 유형 레포의 병합은 사람이 웹에서 한다 (ADR-0028). 갈래가 열려 있어도 거부한다.
        const mergeType = mergeTargetRepoType(command, hookInput.cwd);
        if (mergeType && mergeType !== 'storage') {
          const msg = `[ops-agent 레포 유형 · 차단] 업무 · 사상 유형 레포는 사람이 웹에서 병합한다 (ADR-0028). 상황 보고 뒤 웹 UI 에서 머지한다.\n\n`
            + `대상 레포 유형: ${mergeType} (선언이 없거나 -R/--repo 로 대상이 로컬이 아니면 work 로 본다)\n`
            + `유형 선언은 사람이 한다: .ops-agent/repo-type.json`;
          if (GATE_DRYRUN) {
            process.stderr.write(msg + '\n');
          } else {
            process.stdout.write(JSON.stringify({
              hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: msg },
            }));
            process.exit(0);
          }
        }
        const gateResult = runActionGate(command, hookInput.session_id, hookInput.cwd);
        if (gateResult.blocked) {
          const header = GATE_DRYRUN
            ? '[ops-agent 한시 권한 · 드라이런]'
            : '[ops-agent 한시 권한 · 차단]';
          // 대체 경로가 있는 룰은 함께 싣는다. 금지만 통보하면 다음 행동이 정해지지 않는다.
          const opLines = gateResult.ops.map(o => {
            const head = `  - [${o.category}] ${o.tool} ${o.verb}`;
            if (!o.why && !o.alt) return head;
            return `${head}\n      이유: ${o.why}\n      대신: ${o.alt}`;
          }).join('\n');
          // 안내 경로에 버전을 넣지 않는다. CLAUDE_PLUGIN_ROOT 는 캐시의 버전 디렉토리라
          // 갱신 뒤 이 문구를 복사해 둔 사용자가 옛 스크립트를 켜게 된다 (#202).
          // 고정 경로는 SessionStart 의 linkCurrentRoot 가 활성 버전으로 유지한다.
          // 큰따옴표 안의 ~ 는 확장되지 않으므로 경로를 따옴표로 감싸지 않는다. 이 경로에는 공백이 없다.
          const gateRoot = '~/.claude/ops-agent/current';
          // 이 메시지는 자립해야 한다. 정본 절차(GATE 3)는 flow 스킬 안에 있어 /flow 를
          // 거치지 않은 세션에는 로딩되지 않는다. 게이트가 발동하는 순간 컨텍스트에 있다고
          // 확실히 전달되는 것은 이 문자열뿐이므로, 실행 주체·형식·차단 사실을 여기서 다 말한다.
          // 개방 명령에는 감지된 갈래와 **이미 열려 있던 갈래**를 함께 싣는다.
          // `on` 은 마커를 새로 쓰므로 감지된 갈래만 싣으면 앞서 연 갈래가 지워진다. 그러면
          // 한 작업에서 두 갈래가 순차로 필요할 때 개방 → 차단 → 개방이 반복되고, 같은 종류의
          // 요청이 사람에게 네 번 간다 (#353). 합집합을 스크립트에서 자동으로 만들지 않는 이유는
          // TTL 이 함께 연장되어 먼저 연 갈래의 개방 시간이 사람이 의도한 길이를 넘기기 때문이다.
          // 마커는 사람이 마지막으로 승인한 것을 그대로 담고, 합치는 일은 이 메시지가 한다.
          const blockedScopes = [...new Set(gateResult.ops.map(o => o.scope).filter(Boolean))];
          const openScopes = (gateResult.allowed || []).filter(s => s && s !== 'all' && s !== 'unscoped');
          const carried = openScopes.filter(s => !blockedScopes.includes(s));
          const scopeArg = [...blockedScopes, ...carried].join(',') || 'all';
          const msg = `${header} 되돌리기 어려운/외부 영향 행위를 감지했습니다:\n${opLines}\n\n` +
            `권한 개방은 사용자만 실행할 수 있습니다. 아래를 그대로 제시하고 기다리세요:\n` +
            `  !bash ${gateRoot}/scripts/action-gate-allow.sh on ${scopeArg}\n` +
            `대화창이 \`!\` 를 실행하지 않는 화면(Agent SDK 기반 데스크톱 대화창 등)이면 같은 한 줄을 메시지로 입력하게 안내합니다. 사용자 입력 훅이 사람이 친 그 한 줄만 받아 엽니다 (#1060).\n\n` +
            `이 명령은 위 갈래(${scopeArg})만 엽니다. 다른 갈래는 계속 차단되고 다시 사람에게 옵니다.\n` +
            (carried.length
              ? `\`on\` 은 열려 있던 갈래를 대체합니다. 이미 열린 갈래(${carried.join(',')})를 위 명령에 함께 담았으니 이 한 줄로 필요한 갈래가 모두 열립니다.\n`
              : '') +
            (blockedScopes.length === 1 && blockedScopes[0] === 'git-default-push'
              && declaredScopes(findRepoRoot(extractCwdFromCommand(command, hookInput.cwd))).includes('git-default-push')
              ? `이 레포는 위임을 선언했습니다. 대신 사람이 대화창에 「${DELEGATION_PHRASE}」만 입력하면 이 세션 동안 기본 브랜치 push 가 열립니다. 이 문장을 그대로 안내합니다.\n`
              : '') +
            `어시스턴트가 이 스크립트를 실행하면 자기 수정으로 차단됩니다. 정상 동작이며 우회하지 않습니다.\n` +
            `자연어 승인("승인합니다"·"머지 승인" 등)은 권한을 열지 않습니다. 마커 파일 생성만이 개방 신호입니다.\n` +
            `read-only·가역 명령(git commit, 브랜치 push, gh pr create 등)은 통과합니다.\n` +
            `전체 절차: docs/action-gate.md · 해제: action-gate-allow.sh off · 파이프라인 비활성: 사람이 세션 환경에서 OPS_AGENT_ACTION_GATE_DISABLE=1 (명령 앞 대입은 차단)`;
          if (GATE_DRYRUN) {
            process.stderr.write(msg + '\n');
          } else {
            process.stdout.write(JSON.stringify({
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: msg,
              },
            }));
            process.exit(0);
          }
        }

        // 하네스 허용 규칙 형태 대조 (#1082): 갈래가 열려 있어도 명령이 하네스 허용 규칙과 글자 형태가
        // 다르면 자동 모드 분류기가 다시 판정한다. 통과 여부가 분류기 판단에 맡겨지지 않게 여기서 먼저 막는다.
        if (!gateResult.blocked && (gateResult.detected || []).length) {
          const shapeDir = extractCwdFromCommand(command, hookInput.cwd);
          const shapeGit = args => {
            try {
              return execSync(`git ${args}`, { cwd: shapeDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: budgeted(800) });
            } catch {
              return null;
            }
          };
          const targets = gateSegments(command).filter(segment => [
            ...detectClusterMutations(segment),
            ...detectRepoActions(segment),
            ...detectGitRiskActions([segment], { runGit: shapeGit }),
          ].length);
          const mismatch = harnessShapeMismatch({ targets, rules: harnessBashAllowRules(shapeDir) });
          if (mismatch) {
            const header = GATE_DRYRUN
              ? '[ops-agent 한시 권한 · 드라이런]'
              : '[ops-agent 한시 권한 · 형태 불일치]';
            const why = '하네스 허용 규칙과 글자 형태가 다릅니다. 첫 `*` 앞까지 글자 그대로 비교하고, ` *` 의 공백은 단어 경계라 옵션 선행 · `=` 결합 · `git -C` 는 맞지 않습니다.';
            const msg = `${header} 갈래는 열려 있지만 이 형태로는 하네스 자동 모드가 다시 판정합니다.\n` +
              `대상: ${mismatch.target.length > 160 ? mismatch.target.slice(0, 160) + '…' : mismatch.target}\n` +
              `이유: ${why}\n` +
              `맞는 허용 규칙:\n${mismatch.related.map(r => `  - Bash(${r})`).join('\n')}\n\n` +
              `해결: 위 규칙의 \`*\` 앞 글자 그대로 시작하게 다시 실행합니다. 옵션은 규칙 글자 뒤에 둡니다.\n` +
              `      출력 가공(| tail 등)을 붙이면 그 명령도 규칙이 있어야 하므로 붙이지 않는 쪽이 안전합니다.\n` +
              `사람에게 명령을 넘기지 않습니다. 대화창은 게이트 개방 · 해제 줄 말고는 실행하지 않습니다.\n` +
              `근거: docs/action-gate.md 「하네스 허용 규칙」 · Claude Code permissions 문서 「Wildcard patterns」`;
            if (GATE_DRYRUN) {
              process.stderr.write(msg + '\n');
            } else {
              process.stdout.write(JSON.stringify({
                hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: msg },
              }));
              process.exit(0);
            }
          }
        }

        // 동거 검사: 갈래가 열려 있어도, 앞선 명령의 출력을 읽어야 하는 블록이면 막는다 (#386).
        // 게이트가 열린 동안에만 의미가 있다. 닫혀 있으면 위 갈래 차단이 먼저 걸린다.
        if (!gateResult.blocked && (gateResult.detected || []).length) {
          const co = detectGateCohabitation(command, hookInput.cwd);
          if (co) {
            const header = GATE_DRYRUN
              ? '[ops-agent 한시 권한 · 드라이런]'
              : '[ops-agent 한시 권한 · 차단]';
            const msg = `${header} 되돌리기 어려운 행위(${co.op.tool} ${co.op.verb})가 다른 명령과 한 블록에 있습니다.\n` +
              `앞선 명령:\n${co.preceding.map(s => `  - ${s.length > 120 ? s.slice(0, 120) + '…' : s}`).join('\n')}\n\n` +
              `앞선 명령의 출력을 읽기 전에 이 행위가 실행됩니다. 게이트가 판정을 내려도 같은 블록의\n` +
              `다음 줄이 그대로 실행되면 판정이 아무것도 막지 못합니다 (실측: 버전 대조가 「멈춤」을\n` +
              `출력한 블록에서 머지가 실행되어 기본 브랜치의 버전이 뒤로 밀렸습니다).\n\n` +
              `해결: 앞선 명령을 먼저 단독 실행해 출력을 읽고, 그 다음 호출에서 이 행위만 실행하세요.\n` +
              `예외: 판정을 종료 코드로 돌려주는 검사(scripts/pre-merge-check.sh)는 \`&&\` 로 물려도 됩니다.\n` +
              `      검출 시 종료 코드 1 이라 다음 명령이 실행되지 않습니다.\n` +
              `디렉토리 이동(cd)·환경 설정(export·set)·주석은 앞에 와도 통과합니다.`;
            if (GATE_DRYRUN) {
              process.stderr.write(msg + '\n');
            } else {
              process.stdout.write(JSON.stringify({
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: 'deny',
                  permissionDecisionReason: msg,
                },
              }));
              process.exit(0);
            }
          }
        }
      }

      // 최종 점검 통과 기록: 게이트 개방 여부와 별개로 머지 직전 점검 기록을 요구한다 (#612).
      // 점검이 기억에 달려 있으면 게이트가 열린 순간 점검 없이 머지된다.
      if (!FINAL_CHECK_DISABLE && remainingMs() > 0) {
        const miss = checkFinalReceipt(command, hookInput.cwd);
        if (miss) {
          appendFinalCheckMetric({ repo: miss.repo, pr: miss.pr, result: 'blocked', reason: miss.reason });
          const prArg = miss.pr || '<PR번호>';
          const msg = `[ops-agent 최종 점검 · 차단] 머지할 커밋의 최종 점검 통과 기록이 없습니다: ${miss.reason}\n\n` +
            `아래를 실행해 점검을 통과한 뒤 머지하세요:\n` +
            `  bash "$CLAUDE_PLUGIN_ROOT/scripts/final-check.sh" ${prArg} --notes <파일>\n\n` +
            `노트 파일에는 다음 세 절이 있고 각 본문이 비어 있지 않아야 합니다 (「해당 없음」 한 줄은 허용):\n` +
            `  ## 설계 반영\n  ## 서브 에이전트 산출물\n  ## 교정\n` +
            `그리고 ## 주장 검증 절에 주장 검증의 회차를 한 줄씩 적고, 회차는 리뷰 준비와 머지 준비를 합쳐 3회 이하, 마지막 회차의 차단 지적이 0건이어야 합니다:\n` +
            `  - 1회: 차단 2건 · 권장 3건 · 사소 1건 (HEAD 1a2b3c4)\n  - 2회: 차단 0건 · 권장 1건 · 사소 1건 (HEAD 5d6e7f8)\n` +
            `푸시로 HEAD 가 바뀌면 통과 기록은 무효가 되므로 다시 실행합니다.\n` +
            `전체 절차: docs/action-gate.md 「최종 점검 통과 기록」 · 해제: 사람이 세션 환경에서 OPS_AGENT_FINAL_CHECK_DISABLE=1 (명령 앞 대입은 차단)`;
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: msg,
            },
          }));
          process.exit(0);
        }
      }

    }
  } catch (e) {
    // 훅 내부 오류는 통신을 망치지 않도록 통과시키되, 조용히 삼키지 않는다.
    // 과거 `snippet` 미정의로 키워드 가드가 통째로 무력화됐는데도 드러나지 않은 사례가 있다.
    // 가드가 판정하지 못한 사실 자체를 사용자에게 보인다.
    const detail = (e && e.message) || String(e);
    if (process.env.OPS_AGENT_HOOK_DEBUG === '1') process.stderr.write('HOOKERR: ' + (e && e.stack || e) + '\n');
    process.stdout.write(JSON.stringify({
      continue: true,
      systemMessage: `[ops-agent 가드 내부 오류] 가드가 판정하지 못했습니다: ${detail}\n`
        + `이 명령은 검사 없이 통과합니다. 공개 표면 대상이면 직접 확인하세요.\n`
        + `상세: OPS_AGENT_HOOK_DEBUG=1`,
    }));
    process.exit(0);
  }
}

respondContinue();

// ─────────────────────────────────────────────
// 세션 컨텍스트는 SessionStart 훅이 1회 주입한다 (scripts/session-start.mjs).
// 이 훅은 가드 판정만 담당한다. 통과 시 추가 컨텍스트는 도구 경계 조치 한 줄(passNotice)뿐이다.
function respondContinue() {
  recordExpertRoute();
  if (passNotice) {
    const out = { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: passNotice } };
    if (truncationNotice) out.systemMessage = truncationNotice;
    process.stdout.write(JSON.stringify(out));
    return;
  }
  if (truncationNotice) {
    process.stdout.write(JSON.stringify({ continue: true, systemMessage: truncationNotice }));
    return;
  }
  process.stdout.write('{"continue":true}');
}

function runConfidentialGuard(command, cwd) {
  // 공개 쓰기 명령 감지 (체인된 명령도 커버)
  const writePatterns = [
    /\bgh\s+issue\s+(create|edit|comment)\b/,
    /\bgh\s+pr\s+(create|edit|comment|review)\b/,
    /\bgh\s+release\s+(create|edit)\b/,
    ISSUE_ADAPTER_RE,
    GIT_COMMIT_RE,
  ];
  if (!writePatterns.some(re => re.test(command))) {
    return { blocked: false, hits: [] };
  }

  // 본문·제목·메시지 텍스트 추출
  const texts = [];
  extractOption(command, 'body', texts);
  extractOption(command, 'title', texts);
  extractOption(command, 'subject', texts);
  extractOption(command, 'notes', texts);       // gh release 본문
  extractShortOption(command, 'm', texts);
  extractShortOption(command, 'b', texts);      // gh --body
  extractShortOption(command, 't', texts);      // gh --title
  extractShortOption(command, 'n', texts);      // gh release --notes
  extractFileOption(command, 'body-file', texts);
  extractFileOption(command, 'notes-file', texts);
  extractFileOption(command, 'file', texts);
  extractShortFileOption(command, 'F', texts);  // git commit -F · gh --body-file 단축

  // 대상 디렉토리를 한 번 구해 표면 판정과 diff 검사가 같은 경로를 쓰게 한다.
  // 규칙 로딩보다 먼저 해소해야 한다. 레포가 선언하는 제외 경로를 읽으려면
  // 어느 레포인지부터 정해져야 한다.
  const resolved = resolveCommandCwd(command, cwd);

  const cfg = loadConfig(findRepoRoot(resolved.cwd));
  if (isEmptyConfig(cfg)) {
    return { blocked: false, hits: [] };
  }

  // 경로를 해소하지 못했으면 커밋 대상 파일을 읽을 수 없다. 통과시키면
  // "검사하지 못함" 이 "검사해서 깨끗함" 과 같아진다. 커밋이면 막는다.
  if (!resolved.ok && GIT_COMMIT_RE.test(command)) {
    return {
      blocked: true,
      undeterminable: resolved.reason,
      hits: [{
        keyword: '(커밋 대상 레포 판별 불가)',
        source: resolved.source,
        context: resolved.reason,
      }],
      target: { scope: 'public', reason: resolved.reason },
    };
  }

  // 커밋 대상 파일 내용도 커밋·푸시로 공개된다. 메시지만 보면 파일로 들어간
  // 대외비를 놓친다 (예시 문자열이 주요 유입 경로). 커밋 시점에 diff 를 검사한다.
  const diffTruncated = collectCommitDiffTexts(command, resolved.cwd, cfg.allowPaths, texts);

  if (texts.length === 0) {
    return { blocked: false, hits: [], diffTruncated };
  }

  // 표면 판정 — public · private · internal
  const target = resolveTarget(command, resolved.cwd, cfg.internalHosts);

  // 항상 차단되는 규칙 (존재 자체가 대외비인 키워드)
  const alwaysRules = { keywords: cfg.keywords, patterns: cfg.patterns };
  // 표면별 추가 규칙. private 는 본인 비공개 공간이라 추가 규칙이 없다.
  let surfaceRules = { keywords: [], patterns: [] };
  if (target.scope === 'public') {
    surfaceRules = cfg.externalOnly;                 // 사내 → 공개 (대외비 위반)
  } else if (target.scope === 'internal') {
    surfaceRules = cfg.personalDevOnly;              // 개인 → 사내 (개인 환경 노출)
  }

  const hits = [];
  for (const t of texts) {
    collectHits(t, alwaysRules.keywords, alwaysRules.patterns, hits);
    collectHits(t, surfaceRules.keywords, surfaceRules.patterns, hits);
  }

  return { blocked: hits.length > 0, hits, target, diffTruncated };
}

// 커밋 대상 diff 의 **추가된 줄만** 검사 대상으로 모은다.
//
// 추가된 줄만 보는 이유: 삭제된 줄까지 검사하면 대외비를 **제거하는** 커밋이 차단된다.
// 정리 작업이 자기 가드에 막히는 모순을 피한다.
//
// 검사 시점을 파일 편집이 아니라 커밋으로 잡은 이유:
//   - 편집 시점에는 그 파일이 어디로 갈지 알 수 없다. gitignore 대상일 수도, 사내 레포일 수도 있다.
//     커밋 시점에는 레포 리모트로 타겟(internal·external)을 판정할 수 있고, 기존 판정 로직을 그대로 쓴다.
//   - 추적 대상만 diff 에 오르므로 로컬 전용 파일이 자연히 제외된다.
//   - 편집마다가 아니라 커밋당 1회만 돌아 비용이 낮다.
//   - 커밋 전에 막으면 아직 공개되지 않은 상태다. 편집 시점 검사 대비 늦지만 발행 전이다.
function collectCommitDiffTexts(command, cwd, allowPaths, texts) {
  if (!GIT_COMMIT_RE.test(command)) return false;

  // -a / --all / -am 은 추적 파일의 미스테이징 변경까지 커밋한다.
  const includeUnstaged = new RegExp(GIT_COMMIT_RE.source + String.raw`[^&|;]*?(?:\s-{1,2}(?:a|all)\b|\s-[a-zA-Z]*a[a-zA-Z]*\b)`).test(command);
  const range = includeUnstaged ? 'HEAD' : '--cached';

  let out = '';
  try {
    out = execSync(`git diff ${range} --unified=0 --no-color`, {
      cwd, encoding: 'utf8', timeout: budgeted(1200), maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    // 최초 커밋(HEAD 없음)·git 아님 등. --cached 로 한 번 더 시도한다.
    if (range === 'HEAD') {
      try {
        out = execSync('git diff --cached --unified=0 --no-color', {
          cwd, encoding: 'utf8', timeout: budgeted(1200), maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch { return false; }
    } else {
      return false;
    }
  }
  if (!out) return false;

  const perFile = new Map();
  let file = null;
  let scanned = 0;
  let truncated = false;

  for (const line of out.split('\n')) {
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).replace(/^b\//, '').trim();
      file = path === '/dev/null' ? null : path;
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('@@') || line.startsWith('diff --git')) continue;
    if (!file || line.charCodeAt(0) !== 43 /* '+' */) continue;

    const body = line.slice(1);
    if (!body) continue;
    if (allowPaths.some(re => re.test(file))) continue;

    scanned += body.length;
    if (scanned > DIFF_SCAN_LIMIT) { truncated = true; break; }
    perFile.set(file, (perFile.get(file) || '') + body + '\n');
  }

  for (const [path, value] of perFile) {
    texts.push({ source: `커밋 대상 ${path}`, value });
  }
  return truncated;
}

function collectHits(t, keywords, patterns, hits) {
  for (const kw of keywords) {
    if (!kw || !kw.value) continue;
    // 매칭은 findKeywordHits 가 담당한다. 단어 경계·대소문자 옵션이 스캐너와 같은
    // 판정을 쓰도록 매처 자체를 공유한다.
    for (const h of findKeywordHits(t.value, kw)) {
      hits.push({
        // 등록된 값이 아니라 실제 등장 표기형을 담는다. ignoreCase 로 걸린 경우
        // 어떤 표기가 들어갔는지가 정정에 필요하다.
        keyword: t.value.slice(h.index, h.index + h.length),
        source: t.source,
        context: snippet(t.value, h.index, h.length),
      });
    }
  }
  for (const pat of patterns) {
    const re = new RegExp(pat.source, pat.flags.includes('g') ? pat.flags : pat.flags + 'g');
    let m;
    while ((m = re.exec(t.value)) !== null) {
      hits.push({
        keyword: m[0],
        source: t.source + ' (pattern)',
        context: snippet(t.value, m.index, m[0].length),
      });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
}

/**
 * 명령 텍스트에서 작업 디렉토리 후보를 추출한다.
 *
 * hookInput.cwd 가 호출자(예: 사용자 셸 또는 도구) 의 진입 디렉토리로 들어오는 경우, 명령 내부에서 워크트리·하위 레포로 cd 한 뒤 git 명령을
 * 실행하는 패턴이면 origin remote 조회 cwd 가 어긋난다. 첫 번째 `cd <path>` 또는 `git -C <path>` 패턴을 우선 사용하고, 없으면
 * 원본 cwd 로 fallback 한다.
 *
 * 셸 expansion 전 텍스트라 `~` 가 리터럴로 들어온다. execSync 의 cwd 로 그대로 넘기면 ENOENT 가 발생하므로
 * `~`/`~/` 를 `$HOME` 으로 치환한다.
 */
function expandHome(path) {
  const home = process.env.HOME;
  if (!home || !path) return path;
  if (path === '~') return home;
  if (path.startsWith('~/')) return home + path.slice(1);
  return path;
}

function extractCwdFromCommand(command, fallbackCwd) {
  return resolveCommandCwd(command, fallbackCwd).cwd;
}

/**
 * 명령이 가리키는 작업 디렉토리를 구하고, 해소 가능했는지도 함께 돌려준다.
 *
 * 표면 판정과 커밋 diff 검사는 **같은 경로**를 봐야 한다. 예전에는 표면 판정만 `cd`·`git -C` 를
 * 해석하고 diff 검사는 원본 cwd 를 써서, `cd <repo> && git commit` 이 다른 레포의 diff 를 읽었다.
 * 원본 cwd 에 스테이징된 게 없으면 검사할 텍스트가 없어 그대로 통과했다.
 *
 * 셸 변수(`cd "$DIR"`)는 훅이 확장할 수 없다. 그런 경우 `ok: false` 로 알린다.
 * 판별 불가를 통과로 취급하면 "검사하지 못함" 과 "검사해서 깨끗함" 이 같아진다.
 */
/**
 * `.git` 이 있는 상위 디렉토리를 찾는다. 레포 선언 파일(`.ops-agent/confidential.json`)과
 * allowPaths 정규식이 맞춰 보는 경로가 둘 다 레포 루트 기준이라 루트가 필요하다.
 * 서브프로세스를 띄우지 않는다. 이 훅은 매 Bash 호출마다 실행된다.
 */
function findRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; dir && i < 40; i++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ─── 레포 유형 (ADR-0028) ───
// 레포 루트의 `.ops-agent/repo-type.json` = {"type": "work" | "principle" | "storage"}.
// 파일 없음 · 파싱 실패 · 모르는 값은 work 다. 잘못 분류해도 피해가 작은 쪽이다.
// 유형은 사람이 선언한다. AI 가 선언하면 자기 자율의 범위를 스스로 정하게 되므로 편집을 막는다.
function readRepoType(repoRoot) {
  if (!repoRoot) return 'work';
  try {
    const t = JSON.parse(readFileSync(join(repoRoot, '.ops-agent', 'repo-type.json'), 'utf8')).type;
    return REPO_TYPES.has(t) ? t : 'work';
  } catch {
    return 'work';
  }
}

// 어시스턴트가 레포 유형 파일을 쓰는 호출인지. 도구 호출은 경로 끝으로, Bash 는 쓰기 형태로 본다.
// 읽기(cat · grep · jq)는 통과한다.
function writesRepoTypeFile(toolName, toolInput) {
  return writesGuardedFile(toolName, toolInput, REPO_TYPE_FILE, 'repo-type');
}

// 사람이 선언하는 파일(레포 유형 · 레포 허용 목록)을 쓰는 호출인지. `stem` 은 파일 이름에서 확장자 앞부분이다.
// 어시스턴트가 게이트를 여는 명령인가 (#1060). 개방은 사람의 행위로만 남아야 한다.
// 자기 수정 차단은 하네스 자동 모드에 있어 Agent SDK 기반 대화창에서 도는지 보장이 없으므로 여기서도 막는다.
// 실행 형태(`!` · env · xargs · bash -c · 서브셸 · if · $( ))를 가려내지 않고, 명령 글자에 개방 스크립트의 on
// 이나 대화창 개방 훅 파일이 있으면 막는다. 형태를 열거하면 우회가 끝없이 나온다 (주장 검증 2회차).
// 비용: 그 명령을 글로 담는 작업(문서 편집 · 커밋 메시지 · PR 본문)은 Bash 가 아니라 파일 도구나 본문 파일로 한다.
// status · off 와 이름에 그 파일명을 담은 다른 파일(selftest-action-gate-prompt.mjs)은 막지 않는다.
function opensGateByAssistant(command) {
  // on 뒤는 낱말 경계만 본다. 공백만 보면 `on;` · `on)` · `on|` 처럼 셸 글자가 붙은 형태가 빠지고, 갈래 없는 on 은 all 로 연다 (주장 검증 3회차).
  // 스크립트 뒤 같은 명령 안(; & | 줄바꿈 전)에 독립 인자 on 이 있으면 막는다. 사이에 리다이렉션(2>&1 · >/dev/null)이
  // 끼어도 같다 (4회차). on 이 스크립트보다 앞에 오는 간접 전달(변수 · set -- · xargs 입력)은 위장으로 보고 막지 않는다.
  const allowOn = /action-gate-allow\.sh["']?(?:[^;&|\n]*?[\s"'`(])?["']?on\b/;
  const hook = /(?<![\w-])action-gate-prompt\.mjs/;
  // 2>&1 · >&2 · &> 의 & 는 명령 구분자가 아니라 리다이렉션이다. 판정 전에 지운다.
  const plain = command.replace(/\d*[<>]&\d*-?|&>>?/g, ' ');
  return allowOn.test(plain) || hook.test(plain);
}

// 명령 글자에서 이름이 `_DISABLE` 로 끝나는 변수를 대입하는 자리를 찾아 그 이름을 돌려준다 (#1142).
// 따옴표 안 · heredoc 본문 · 주석은 지운 뒤 본다. 명령 머리 대입, env 대입, export · declare -x · typeset -x 대입을 본다.
function findDisableAssignment(command) {
  const plain = maskShellLiterals(command).replace(/\d*[<>]&\d*-?|&>>?/g, ' ');
  for (const seg of plain.split(/[;&|()\n`]/)) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length && COMMAND_HEAD_KEYWORDS.has(words[i])) i++;
    for (; i < words.length && ASSIGN_WORD_RE.test(words[i]); i++) {
      const m = words[i].match(DISABLE_ASSIGN_WORD_RE);
      if (m) return m[1];
    }
    const cmd = (words[i] || '').replace(/^.*\//, '');
    const rest = words.slice(i + 1);
    if (cmd === 'env') {
      for (let j = 0; j < rest.length; j++) {
        const w = rest[j];
        if (ENV_VALUE_OPTS.has(w)) { j++; continue; }
        if (w.startsWith('-')) continue;
        const m = w.match(DISABLE_ASSIGN_WORD_RE);
        if (m) return m[1];
        if (!ASSIGN_WORD_RE.test(w)) break;
      }
    }
    const exportsVars = cmd === 'export'
      || ((cmd === 'declare' || cmd === 'typeset') && rest.some(w => /^-[A-Za-z]*x/.test(w)));
    if (exportsVars) {
      const hit = rest.map(w => w.match(DISABLE_ASSIGN_WORD_RE)).find(Boolean);
      if (hit) return hit[1];
    }
  }
  return null;
}

// heredoc 본문 · 따옴표 안 글자 · 주석을 지운다. 따옴표 자체는 남겨 `NAME="1"` 이 대입 모양을 유지하게 한다.
// 닫히지 않은 따옴표는 끝까지 따옴표 안으로 본다. 셸도 그 명령을 실행하지 못한다.
function maskShellLiterals(command) {
  const s = command.replace(HEREDOC_RE, m => m.slice(0, m.indexOf('\n') + 1));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { out += s.slice(i, i + 2); i++; continue; }
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      out += "''";
      i = end < 0 ? s.length : end;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      out += '""';
      i = j;
      continue;
    }
    if (c === '#' && (i === 0 || /[\s;&|()]/.test(s[i - 1]))) {
      const nl = s.indexOf('\n', i);
      i = nl < 0 ? s.length : nl - 1;
      continue;
    }
    out += c;
  }
  return out;
}

function writesGuardedFile(toolName, toolInput, fileRe, stem) {
  const ti = toolInput || {};
  if (/^(?:Edit|Write|MultiEdit|NotebookEdit)$/.test(toolName)) {
    return [ti.file_path, ti.notebook_path].some(f => typeof f === 'string' && fileRe.test(f));
  }
  if (toolName !== 'Bash') return false;
  const nameRe = new RegExp(`${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.[\\w.]+)?\\.json`);
  const redirectRe = new RegExp(`>>?\\|?\\s*["']?[^\\s;|&"']*${nameRe.source}`);
  for (const seg of gateSegments(ti.command || '')) {
    if (!nameRe.test(seg)) continue;
    const toks = seg.split(/\s+/).filter(Boolean).map(t => t.replace(/^["']|["']$/g, ''));
    const cmd = (toks[0] || '').replace(/^.*\//, '');
    if (redirectRe.test(seg)) return true;
    if (cmd === 'tee' || cmd === 'rm' || cmd === 'mv') return true;
    if ((cmd === 'sed' || cmd === 'perl') && toks.some(t => /^-[A-Za-z]*i[A-Za-z]*$/.test(t) || t.startsWith('--in-place'))) return true;
    if ((cmd === 'cp' || cmd === 'ln') && nameRe.test(toks[toks.length - 1])) return true;
  }
  return false;
}

// `gh pr merge` 의 대상 레포 유형. -R/--repo 가 있으면 로컬 선언을 알 수 없어 work 로 본다.
function mergeTargetRepoType(command, hookCwd) {
  const mergeSegs = gateSegments(command).filter(s => /^(?:\S*\/)?gh\s+pr\s+merge\b/.test(s));
  if (!mergeSegs.length) return null;
  if (mergeSegs.some(s => /(?:^|\s)(?:-R|--repo)(?:\s|=)/.test(s))) return 'work';
  return readRepoType(findRepoRoot(extractCwdFromCommand(command, hookCwd)));
}

function resolveCommandCwd(command, fallbackCwd, relativeToCwd = false) {
  const cdMatch = command.match(/\bcd\s+["']?([^\s"'&;|]+)["']?/);
  const gitCMatch = command.match(/\bgit\s+-C\s+["']?([^\s"'&;|]+)["']?/);
  const raw = (cdMatch && cdMatch[1]) || (gitCMatch && gitCMatch[1]);
  if (!raw) return { cwd: fallbackCwd, ok: true, source: 'hook cwd' };

  const source = cdMatch ? 'cd' : 'git -C';
  // 미확장 셸 표현이 남아 있으면 경로가 아니다.
  if (/[$`*?]/.test(raw)) {
    return { cwd: fallbackCwd, ok: false, source, reason: `${source} 인자에 미확장 셸 표현: ${raw}` };
  }
  // relativeToCwd: 상대 경로를 명령의 작업 디렉토리 기준으로 푼다. 전문가 경유 지표만 쓴다
  const path = relativeToCwd ? resolvePath(fallbackCwd || process.cwd(), expandHome(raw)) : expandHome(raw);
  if (!existsSync(path)) {
    return { cwd: fallbackCwd, ok: false, source, reason: `${source} 경로 없음: ${path}` };
  }
  return { cwd: path, ok: true, source };
}

// 표면은 셋이다. 호스트만 보면 둘로만 나뉘어 비공개 저장소가 공개 표면으로 오판된다.
//
//   internal — 사내 호스트. 개인 환경 흔적(personalDevOnly)을 막는다.
//   public   — 사내 호스트 아님 + 공개 확인. 사내 용어(externalOnly)를 막는다.
//   private  — 사내 호스트 아님 + 비공개 확인. 본인 비공개 공간이므로 양쪽 다 통과.
//
// 두 방향을 같은 강도로 막는다. 사내 → public 은 대외비 위반이고,
// 개인 → internal 은 개인 환경이 사내 공유 표면에 드러나는 문제다.
// cwd 는 호출자가 resolveCommandCwd 로 이미 해소한 경로다. 여기서 다시 추출하지 않는다.
// 두 곳이 각자 추출하면 표면과 검사 대상이 어긋날 수 있다.
function resolveTarget(command, cwd, internalHosts) {
  const hosts = internalHosts || [];
  const effectiveCwd = cwd;
  const isInternalHost = host => hosts.some(h => host === h || host.endsWith('.' + h));

  // 1. gh 명령: GH_HOST 환경 변수 접두어 우선
  const ghHostMatch = command.match(/\bGH_HOST=([^\s'"]+)/);
  // 어댑터 호출(gh-issue.sh)의 -R 도 같이 읽는다. 안 읽으면 4번 기본값(public)으로 떨어져
  // 사내 호스트 레포의 이슈 본문이 공개 표면으로 오판된다.
  const ghRepoMatch = command.match(/\b(?:gh|gh-issue\.sh)\s+\S+[^&|;]*?\s(?:-R|--repo)[\s=]+["']?([^\s"']+)/);
  const repoArg = ghRepoMatch ? ghRepoMatch[1].split('/') : null;

  if (ghHostMatch) {
    const host = ghHostMatch[1];
    if (isInternalHost(host)) return { scope: 'internal', reason: `GH_HOST=${host}` };
    // -R owner/repo 가 함께 오면 슬러그를 만들 수 있다.
    const slug = repoArg && repoArg.length === 2 ? `${host}/${repoArg.join('/')}` : null;
    return classifyExternal(slug, `GH_HOST=${host}`, host);
  }

  // 2. gh -R 에 호스트가 포함된 형태 (host/owner/repo)
  if (repoArg && repoArg.length >= 3) {
    const host = repoArg[0];
    if (isInternalHost(host)) return { scope: 'internal', reason: `-R host=${host}` };
    return classifyExternal(repoArg.slice(0, 3).join('/'), `-R host=${host}`, host);
  }

  // 3. gh (호스트 미지정) · git commit: 레포 리모트로 판정한다.
  //
  // gh 는 GH_HOST 도 host 가 포함된 -R 도 없으면 현재 디렉토리의 git 리모트에서 레포를 해소한다.
  // 따라서 판정 근거도 리모트여야 한다. 이전 구현은 `gh auth status` 출력 전문에 사내 호스트
  // 문자열이 있는지만 봤는데, 그 출력에는 로그인된 **모든** 호스트가 나열된다.
  // 사내·개인 계정을 함께 쓰는 머신에서는 항상 사내로 판정되어 externalOnly 규칙이
  // 통째로 건너뛰어졌다. 퍼블릭 레포 대상 명령이 사내 용어를 통과시키는 fail-open 이었다.
  if (/\bgh\s+(issue|pr|release)\b/.test(command) || ISSUE_ADAPTER_RE.test(command) || GIT_COMMIT_RE.test(command)) {
    let url = '';
    try {
      url = execSync('git remote get-url origin 2>/dev/null', {
        cwd: effectiveCwd, encoding: 'utf8', timeout: budgeted(900),
      }).trim();
    } catch {
      // 판별 불가는 public 으로 닫는다. 대외비 가드에서 fail-open 은 방향이 거꾸로다.
      return { scope: 'public', reason: `origin remote 조회 실패 (cwd=${effectiveCwd})` };
    }
    if (!url) return { scope: 'public', reason: `origin remote 없음 (cwd=${effectiveCwd})` };

    const parsed = parseRemote(url);
    if (parsed && isInternalHost(parsed.host)) {
      return { scope: 'internal', reason: `origin remote=${parsed.host}` };
    }
    // 리모트 URL 이 파싱되지 않아도 사내 호스트 문자열이 들어 있으면 사내로 본다.
    for (const host of hosts) {
      if (url.includes(host)) return { scope: 'internal', reason: `origin remote=${host}` };
    }
    return classifyExternal(parsed && parsed.slug, `origin remote=${url.substring(0, 60)}`, parsed && parsed.host);
  }

  // 4. 기본값: 안전하게 public
  return { scope: 'public', reason: '타겟 미확인' };
}

// 사내 호스트가 아닌 대상의 공개 여부를 판정한다.
// 슬러그를 못 만들거나 조회가 실패하면 public 으로 닫는다.
function classifyExternal(slug, reason, host) {
  if (!slug) return { scope: 'public', reason: `${reason} · 레포 식별 불가` };
  const vis = lookupVisibility(slug, host);
  if (vis === 'PRIVATE' || vis === 'INTERNAL') {
    return { scope: 'private', reason: `${reason} · 비공개(${vis})` };
  }
  if (vis === 'PUBLIC') return { scope: 'public', reason: `${reason} · 공개` };
  return { scope: 'public', reason: `${reason} · 공개 여부 미확인` };
}

// loadConfig · isEmptyConfig · parseRemote · lookupVisibility · shellQuote 와
// 공개 여부 캐시는 confidential-rules.mjs 로 옮겼다. confidential-scan.mjs 가 같은
// 규칙·같은 표면 판정을 써야 하고, 복제하면 두 판정이 달라진다.

function extractOption(command, name, out) {
  const re = new RegExp(`--${name}(?:=("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\\S+)|\\s+("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\\S+))`, 'g');
  let m;
  while ((m = re.exec(command)) !== null) {
    const raw = m[1] || m[2] || '';
    out.push({ source: `--${name}`, value: stripQuotes(raw) });
  }
}

function extractShortOption(command, name, out) {
  const re = new RegExp(`(?:^|\\s)-${name}(?:=("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\\S+)|\\s+("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\\S+))`, 'g');
  let m;
  while ((m = re.exec(command)) !== null) {
    const raw = m[1] || m[2] || '';
    out.push({ source: `-${name}`, value: stripQuotes(raw) });
  }
}

function extractFileOption(command, name, out) {
  const re = new RegExp(`--${name}(?:=(\\S+)|\\s+(\\S+))`, 'g');
  let m;
  while ((m = re.exec(command)) !== null) {
    const path = stripQuotes(m[1] || m[2] || '');
    if (path && existsSync(path)) {
      try {
        out.push({ source: `--${name}:${path}`, value: readFileSync(path, 'utf8') });
      } catch { /* 읽기 실패는 무시 */ }
    }
  }
}

// 단축 파일 옵션 (`git commit -F <path>`, `gh ... -F <path>`).
// 이 경로가 빠져 있어 -F 로 넘긴 커밋 메시지·본문이 검사되지 않았다.
function extractShortFileOption(command, name, out) {
  const re = new RegExp(`(?:^|\\s)-${name}(?:=(\\S+)|\\s+(\\S+))`, 'g');
  let m;
  while ((m = re.exec(command)) !== null) {
    const path = stripQuotes(m[1] || m[2] || '');
    if (path && existsSync(path)) {
      try {
        out.push({ source: `-${name}:${path}`, value: readFileSync(path, 'utf8') });
      } catch { /* 읽기 실패는 무시 */ }
    }
  }
}

// 커밋에 담길 변경의 범위. 해석은 commit-scope.mjs(셸 인용 · 명령 대체 · 히어닥 · 리다이렉션을 따라 커밋 인자를 읽는다)다.
// 경유 지표(commit-md)만 쓴다. 커밋마다 { start, scopes }. 셸로 읽지 못하면 넉넉한 범위 하나다.
function commitsIn(command) {
  const commits = analyzeCommits(command);
  if (commits === null) return [{ start: Infinity, scopes: broadScopes(/\bgit\s+(?:add|stage)\b/.test(command)) }];
  return commits;
}

// 범위 하나의 diff. HEAD 가 없으면(첫 커밋) 스테이징분으로 한 번 더 본다. 읽지 못하면 null.
// untracked 는 추적하지 않는 파일의 줄 수를 --numstat 모양으로 만든다.
function gitDiffScope(scope, opts, cwd) {
  if (scope.rev === 'untracked') return untrackedNumstat(cwd);
  const run = rev => execFileSync('git', ['-c', 'core.quotePath=false', 'diff', rev, ...opts, '--no-color', '--', ...scope.paths], {
    cwd, encoding: 'utf8', timeout: budgeted(1200), maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  });
  try { return run(scope.rev); } catch {
    if (scope.rev !== 'HEAD') return null;
    try { return run('--cached'); } catch { return null; }
  }
}

function untrackedNumstat(cwd) {
  let list;
  try {
    list = execFileSync('git', ['ls-files', '-z', '--others', '--exclude-standard'], {
      cwd, encoding: 'utf8', timeout: budgeted(800), maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\0').filter(Boolean);
  } catch { return null; }
  let out = '';
  for (const rel of list) {
    let text;
    try { text = readFileSync(join(cwd, rel), 'utf8'); } catch { continue; }
    if (text.includes('\0')) continue;
    out += `${text ? countLines(text) : 0}\t0\t${rel}\n`;
  }
  return out;
}

function stripQuotes(s) {
  if (s.length >= 2) {
    const f = s[0], l = s[s.length - 1];
    if ((f === '"' && l === '"') || (f === "'" && l === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}


// ─── 이슈 생성 가드 ───
// 세그먼트마다 판정한다. 어댑터 호출 세그먼트에는 `gh issue create` 가 없으므로 면제 규칙이 필요 없고,
// `bash gh-issue.sh …; gh issue create …` 처럼 뒤에 붙인 직접 호출은 그 세그먼트가 걸린다.
// 최상위 명령만 본다 (docs/action-gate.md 「한계」). 헬퍼 스크립트 · bash -c 내부는 보지 않는다.
//
// gh api: 경로 끝이 `/issues` (쿼리스트링 제외) 인 것만 생성이다. `…/issues/1/comments` · `…/issues/1/labels` 는
// 코멘트 · 라벨이라 막지 않는다. 메서드는 명시한 -X/--method 가 이기고, 없으면 파라미터(-f/--raw-field ·
// -F/--field)가 있으면 POST 다 (`gh api --help`: 파라미터가 더해지면 POST). --input 은 규격에 메서드 언급이
// 없어 보수적으로 POST 로 본다. GraphQL 은 경로가 `graphql` 이라 `createIssue` 토큰으로 본다.
function ghApiCreatesIssue(segment) {
  const api = parseGhApi(segment);
  if (!api) return false;
  if (/^graphql$/.test(api.path)) return /\bcreateIssue\b/.test(segment);
  if (!/(?:^|\/)issues$/.test(api.path)) return false;
  return api.method === 'POST';
}

// gh api 세그먼트의 경로(쿼리스트링 · 끝 슬래시 제외)와 실제 메서드. gh api 가 아니면 null.
// 이슈 생성 가드와 전문가 경유 지표(댓글 · 리뷰 쓰기)가 같은 판정을 쓴다.
function parseGhApi(segment) {
  const tokens = segment.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+/g) || [];
  const apiIdx = tokens.findIndex(t => /^(?:\S*\/)?gh$/.test(t));
  if (apiIdx < 0 || tokens[apiIdx + 1] !== 'api') return null;
  let path = null;
  let method = null;
  let hasParam = false;
  for (let i = apiIdx + 2; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('-')) {
      if (GH_API_PARAM_FLAGS.test(t)) hasParam = true;
      const eq = t.indexOf('=');
      const flag = eq >= 0 ? t.slice(0, eq) : t;
      if ((flag === '-X' || flag === '--method')) {
        method = (eq >= 0 ? t.slice(eq + 1) : tokens[i + 1] || '').replace(/^["']|["']$/g, '').toUpperCase();
      }
      if (eq < 0 && GH_API_VALUE_FLAGS.has(flag)) i++;
      continue;
    }
    if (path === null) path = t.replace(/^["']|["']$/g, '');
  }
  if (!path) return null;
  return { path: path.replace(/\?.*$/, '').replace(/\/+$/, ''), method: method || (hasParam ? 'POST' : 'GET') };
}

function detectDirectIssueCreate(command) {
  const hits = [];
  for (const seg of gateSegments(command)) {
    if (/^(?:\S*\/)?gh\s+issue\s+create\b/.test(seg)) hits.push(seg.length > 120 ? seg.slice(0, 120) + '…' : seg);
    else if (/^(?:\S*\/)?gh\s+api\b/.test(seg) && ghApiCreatesIssue(seg)) hits.push(seg.length > 120 ? seg.slice(0, 120) + '…' : seg);
  }
  return hits;
}

// ─── 초안 PR 가드 ───
// 세그먼트마다 최상위 `gh pr create` 를 보고, 토큰에 초안 플래그(`--draft` · `-d` · `--draft=true` · `-fd` 처럼
// 불리언 단축 플래그와 붙인 형태)가 없으면 잡는다. `env` 접두와 `create` 앞의 `-R`/`--repo` 도 같은 생성으로 본다.
// 따옴표 안의 문자열(제목 · 본문)은 한 토큰이라 플래그로 오인하지 않는다. 최상위 명령만 본다 (docs/action-gate.md 「한계」).
function detectNonDraftPrCreate(command) {
  const hits = [];
  for (const seg of gateSegments(command)) {
    if (!PR_CREATE_RE.test(seg)) continue;
    const tokens = seg.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+/g) || [];
    const draft = tokens.some(t => t === '--draft' || /^-[few]*d(?:=(?:true|1|t))?$/i.test(t) || /^--draft=(?:true|1|t)$/i.test(t));
    if (!draft) hits.push(seg.length > 120 ? seg.slice(0, 120) + '…' : seg);
  }
  return hits;
}

// 명령 대상 레포가 레포 유형 선언의 허용 목록에 `skip-draft` 를 두었는가 (#1166, ADR-0044).
// 선언은 사람만 쓴다(레포 유형 편집 차단). 대상은 훅 cwd 의 레포 하나다.
// 통과는 허용 목록으로만 정한다: 명령 하나가 단독으로 `gh pr create`(알려진 옵션만) 또는 `gh pr ready <번호>` 이고,
// 이스케이프 · `$` · 백틱이 없을 때뿐이다. 앞뒤 명령 · 환경 변수 접두 · 다른 레포 지정 · 작업 위치 이동은 모두 이 밖이라
// 기본값(드래프트 필수)이다. 위험한 형태를 하나씩 막는 방식은 셸 표기(따옴표 · 묶음 플래그 · GIT_DIR)로 계속 우회됐다.
function draftSkipDeclared(command, hookCwd) {
  const SKIP_DRAFT_VALUE_FLAGS = new Set(['--title', '-t', '--body', '-b', '--body-file', '-F', '--base', '-B', '--head', '-H',
    '--label', '-l', '--assignee', '-a', '--reviewer', '-r', '--milestone', '-m', '--project', '-p']);
  const SKIP_DRAFT_BOOL_FLAGS = new Set(['--fill', '-f', '--fill-first', '--fill-verbose', '--draft', '-d', '--no-maintainer-edit']);
  const segs = gateSegments(command);
  if (segs.length !== 1) return false;
  const seg = command.trim();
  if (/[\\`$]/.test(seg)) return false;
  const toks = seg.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  if (toks.join(' ') !== seg.replace(/\s+/g, ' ')) return false;
  if (toks[0] !== 'gh' || toks[1] !== 'pr') return false;
  const rest = toks.slice(3);
  if (toks[2] === 'ready') {
    if (!(rest.length === 1 && /^\d+$/.test(rest[0]))) return false;
  } else if (toks[2] === 'create') {
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i];
      if (SKIP_DRAFT_BOOL_FLAGS.has(t)) continue;
      const eq = t.indexOf('=');
      if (eq > 0 && t.startsWith('--') && SKIP_DRAFT_VALUE_FLAGS.has(t.slice(0, eq))) continue;
      if (SKIP_DRAFT_VALUE_FLAGS.has(t) && i + 1 < rest.length && !/^-/.test(rest[i + 1])) { i++; continue; }
      return false;
    }
  } else {
    return false;
  }
  const root = findRepoRoot(hookCwd);
  if (!root) return false;
  try {
    const d = JSON.parse(readFileSync(join(root, '.ops-agent', 'repo-' + 'type.json'), 'utf8'));
    return Array.isArray(d.allow) && d.allow.includes('skip-draft');
  } catch {
    return false;
  }
}

// 세그먼트마다 최상위 `gh pr ready`(`--undo` 없음)와 GraphQL 전환 mutation 을 잡는다.
function detectPrReady(command) {
  const hits = [];
  for (const seg of gateSegments(command)) {
    const tokens = seg.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+/g) || [];
    const ready = PR_READY_RE.test(seg) && !tokens.includes('--undo');
    if (ready || PR_READY_GRAPHQL_RE.test(seg)) hits.push(seg.length > 120 ? seg.slice(0, 120) + '…' : seg);
  }
  return hits;
}

// ─── 도메인 What 추상화 가드 ───
// 커밋/PR/이슈 본문에서 구현 세부(클래스명·메서드명·어노테이션·헥사고날 어휘·yaml 키·산출물 카운트) 차단
function runWhatAbstractionGuard(command) {
  const writePatterns = [
    /\bgh\s+issue\s+(create|edit|comment)\b/,
    /\bgh\s+pr\s+(create|edit|comment|review)\b/,
    /\bgh\s+release\s+(create|edit)\b/,
    ISSUE_ADAPTER_RE,
    GIT_COMMIT_RE,
  ];
  if (!writePatterns.some(re => re.test(command))) {
    return { blocked: false, hits: [] };
  }

  const texts = [];
  // 제목은 이슈/PR 번호 prefix 또는 짧은 도메인 표현이라 검사 대상 아님 — body/m/subject·body-file만
  extractOption(command, 'body', texts);
  extractOption(command, 'notes', texts);
  extractShortOption(command, 'm', texts);
  extractShortOption(command, 'b', texts);
  extractFileOption(command, 'body-file', texts);
  extractFileOption(command, 'notes-file', texts);
  extractFileOption(command, 'file', texts);
  extractShortFileOption(command, 'F', texts);

  if (texts.length === 0) return { blocked: false, hits: [] };

  return scanWhatViolations(texts);
}

// ─── 한자 섞임 가드 ───
// 커밋 메시지와 PR 제목 · 본문 · 코멘트만 본다. 이슈는 어댑터가 같은 모듈로 본다.
// 커밋 대상 파일은 보지 않는다. 한자를 정당하게 담는 파일(검사 사례 · 다국어 자원)까지 막게 된다.
function runHanIntrusionGuard(command) {
  if (!GIT_COMMIT_RE.test(command) && !HAN_PR_WRITE_RE.test(command)) return [];
  const texts = [];
  extractOption(command, 'body', texts);
  extractOption(command, 'title', texts);
  extractOption(command, 'message', texts);
  extractShortOption(command, 'm', texts);
  extractShortOption(command, 'b', texts);
  extractShortOption(command, 't', texts);
  extractFileOption(command, 'body-file', texts);
  extractFileOption(command, 'file', texts);
  extractShortFileOption(command, 'F', texts);
  if (STDIN_BODY_RE.test(command)) {
    for (const m of command.matchAll(HEREDOC_RE)) texts.push({ source: 'heredoc', value: m[3] });
  }
  const hits = [];
  for (const t of texts) for (const context of findIntrusions(t.value)) hits.push({ source: t.source, context });
  return hits;
}

// ─── 글 판정 가드 ───
// 본문만 본다. 제목은 한 줄이라 불릿 규칙이 걸리지 않는다. 판정은 카운터의 --only 출력(`경로:줄 [규칙] 안내`)을 그대로 쓴다.
// 카운터를 부르지 못하면(파이썬 없음 · 시간 초과) 판정하지 못한 사실을 알리고 통과시킨다. 미검사를 통과로 숨기지 않는다.
function runBodyLintGuard(command) {
  if (!BODY_WRITE_RE.test(command)) return [];
  const texts = [];
  extractOption(command, 'body', texts);
  extractShortOption(command, 'b', texts);
  extractFileOption(command, 'body-file', texts);
  extractShortFileOption(command, 'F', texts);
  if (STDIN_BODY_RE.test(command)) {
    for (const m of command.matchAll(HEREDOC_RE)) texts.push({ source: 'heredoc', value: m[3] });
  }
  if (!texts.length || !existsSync(BODY_LINT_COUNTER)) return [];
  const dir = mkdtempSync(join(tmpdir(), 'ops-body-lint-'));
  const hits = [];
  try {
    texts.forEach((t, i) => {
      const file = join(dir, `body-${i}.md`);
      writeFileSync(file, t.value);
      let out = '';
      try {
        out = execFileSync('python3', [BODY_LINT_COUNTER, '--only', BODY_LINT_RULES, file],
          { encoding: 'utf8', timeout: budgeted(800), stdio: ['ignore', 'pipe', 'ignore'] });
      } catch (e) {
        // 종료 코드 1 = 검출 있음. 그 밖(실행 실패 · 시간 초과)은 판정하지 못한 것이다
        if (e.status === 1) out = String(e.stdout || '');
        else { process.stderr.write(`[ops-agent 글 판정 가드] 카운터를 실행하지 못해 이 본문은 판정되지 않았습니다 (${t.source}).\n`); return; }
      }
      for (const ln of out.split('\n')) {
        const m = ln.match(/:(\d+) \[([A-Z]+\d+)\] (.*)$/);
        if (m) hits.push({ source: t.source, line: Number(m[1]), rule: m[2], message: m[3] });
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return hits;
}

// ─── 한시 권한 ───
// 되돌리기 어려운/외부 영향 행위를 감지해 세션 명시 허용 전까지 차단한다.
// 목적: 어시스턴트가 권한을 추측해 되돌리기 어려운 행위(클러스터 mutation·PR 머지·릴리즈·
//   force push·리소스 삭제)를 실행하는 사고를 기계적으로 막는다. 명확한 승인 = 세션 허용 플래그.
// 세션 허용: OPS_AGENT_ACTION_GATE_ALLOW=1 (또는 레거시 OPS_AGENT_CLUSTER_WRITE_ALLOW=1),
//   ~/.claude/ops-agent/.cache/action-gate-allow.json 마커(TTL·선택적 session 바인딩).
// 한계: `bash deploy.sh` 처럼 스크립트 내부에서 실행되는 명령은 최상위 명령만 보므로 탐지 못 함
//   (의도된 배포 스크립트 경로는 sanctioned 로 간주). 직접 타이핑하는 ad-hoc 명령을 막는 안전망.
// verb 세트/플래그 세트는 파일 상단(게이트 호출보다 먼저 초기화되어야 함)에 선언.
// 게이트는 시간만이 아니라 **승인된 행위 갈래**로도 열린다. 시간만으로 열면 열린 동안
// 승인 대상이 아니었던 갈래까지 함께 통과한다. 실제로 PR 머지를 위해 게이트를 연 동안 기본 브랜치
// 직접 push 가 통과했다. 둘 다 category 는 `repo` 라 category 단위로는 나뉘지 않는다.
// 그래서 갈래 키를 category 보다 좁게 둔다 (scope).
function runActionGate(command, sessionId, hookCwd) {
  const allowed = allowedScopes(sessionId);
  // 대화창 위임 (#1046): 이 세션 · 이 레포에 사람이 연 갈래를 더한다. 선언 · 문장 둘 다 있어야 열린다.
  for (const s of delegatedScopes(sessionId, findRepoRoot(extractCwdFromCommand(command, hookCwd)))) allowed.add(s);
  // `all` 이 열려 있어도 탐지는 한다. 동거 검사(#386)는 게이트가 열린 동안에만 발동하기 때문이다.
  const ops = detectGatedActions(command, hookCwd);
  // cluster-exec 는 cluster-write 에서 나뉘어 나온 갈래다. 기존에 cluster-write 로 열던 개방이 exec 를
  // 계속 통과하도록 cluster-write 가 열려 있으면 함께 통과시킨다 (#445).
  const isOpen = scope => allowed.has(scope) || (scope === 'cluster-exec' && allowed.has('cluster-write'));
  const outside = allowed.has('all') ? [] : ops.filter(o => !isOpen(o.scope || 'unscoped'));
  return { blocked: outside.length > 0, ops: outside, detected: ops, allowed: [...allowed] };
}

// 게이트 대상 행위 앞에 **출력을 읽어야 하는 명령**이 같은 블록에 있으면 차단한다.
//
// 게이트가 판정을 정확히 내려도 같은 명령 블록의 다음 줄이 그대로 실행되면 판정이 아무것도
// 막지 못한다. 실제로 GATE 6 이 「멈춤」 두 줄을 출력한 블록에서 `gh pr merge` 가 실행되어
// main 의 버전이 뒤로 밀렸다 (#386). 「분리해서 실행하라」를 지시로 두는 것과 기계가 거르는
// 것은 강도가 다르다. 잊어도 걸리는 쪽을 택한다.
//
// 앞 세그먼트만 본다. 뒤에 오는 정리 명령(브랜치 삭제 등)은 이미 실행된 행위의 결과에
// 속한 것이라 판정 대상이 아니다.
function detectGateCohabitation(command, hookCwd) {
  const segs = gateSegments(command);
  if (segs.length < 2) return null;
  const dir = extractCwdFromCommand(command, hookCwd);
  const runGit = args => {
    try {
      return execSync(`git ${args}`, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: budgeted(800) });
    } catch {
      return null;
    }
  };
  for (let i = 0; i < segs.length; i++) {
    const ops = [
      ...detectClusterMutations(segs[i]),
      ...detectRepoActions(segs[i]),
      ...detectGitRiskActions([segs[i]], { runGit }),
    ];
    if (!ops.length) continue;
    const preceding = segs.slice(0, i)
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .filter(s => !COHABIT_BENIGN.test(s) && !COHABIT_GATE_CHECK.test(s));
    if (preceding.length) {
      return { op: ops[0], preceding };
    }
  }
  return null;
}

// 하네스 Bash 허용 규칙 (#1082). 사용자 설정과, 명령이 향한 레포의 프로젝트 설정을 모은다.
function harnessBashAllowRules(dir) {
  const files = [join(homedir(), '.claude', 'settings.json'), join(homedir(), '.claude', 'settings.local.json')];
  const root = dir ? findRepoRoot(dir) : null;
  if (root) files.push(join(root, '.claude', 'settings.json'), join(root, '.claude', 'settings.local.json'));
  const objs = [];
  for (const f of files) {
    if (!existsSync(f)) continue;
    try { objs.push(JSON.parse(readFileSync(f, 'utf8'))); } catch { /* 읽지 못한 설정은 건너뛴다 */ }
  }
  return bashAllowRulesFrom(objs);
}

// 마커가 담은 허용 갈래 집합. 비어 있으면 아무것도 열려 있지 않다.
function allowedScopes(sessionId) {
  if (process.env.OPS_AGENT_ACTION_GATE_ALLOW === '1'
    || process.env.OPS_AGENT_CLUSTER_WRITE_ALLOW === '1') return new Set(['all']);
  const cacheDir = join(homedir(), '.claude', 'ops-agent', '.cache');
  // 신규 마커 우선, 레거시 마커도 인식
  for (const name of ['action-gate-allow.json', 'cluster-write-allow.json']) {
    const markerPath = join(cacheDir, name);
    if (!existsSync(markerPath)) continue;
    try {
      const m = JSON.parse(readFileSync(markerPath, 'utf8'));
      if (m.sessionId && sessionId && m.sessionId !== sessionId) continue;
      if (m.expiresAt && Date.now() > m.expiresAt) continue;
      // 갈래가 없는 마커는 이 변경 이전 형식이다. 전체 허용으로 읽어 진행 중인 개방을 끊지 않는다.
      const scopes = Array.isArray(m.scopes) && m.scopes.length ? m.scopes : ['all'];
      return new Set(scopes);
    } catch { /* 다음 후보 */ }
  }
  return new Set();
}

// 게이트 대상 행위 = 클러스터 mutation + 레포 되돌리기 어려운 행위 + git 위험 조작
//
// git 판정은 대상 디렉토리를 알아야 한다. 기본 브랜치도 현재 브랜치도 레포마다 다르므로
// 명령 문자열만으로는 정해지지 않는다. 표면 판정·diff 검사와 같은 해석기를 써서
// `cd <path> && git push` 형태가 다른 레포를 보는 사고를 막는다.
function detectGatedActions(command, hookCwd) {
  const dir = extractCwdFromCommand(command, hookCwd);
  const runGit = args => {
    try {
      return execSync(`git ${args}`, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: budgeted(800) });
    } catch {
      return null;
    }
  };
  return [
    ...detectClusterMutations(command),
    ...detectRepoActions(command),
    ...detectGitRiskActions(gateSegments(command), { runGit }),
  ];
}

// 명령을 체인 세그먼트로 분리하고 선행 env 할당·sudo 를 제거해 각 세그먼트 앞부분을 돌려준다.
// 따옴표 안의 구분자는 명령 경계가 아니다 (#473). 검색 패턴·인용문에 담긴 행위 문구가
// 세그먼트로 떨어져 나와 앵커 정규식에 걸렸다. 따옴표가 닫히지 않은 입력은 종전대로 나눈다.
// 형식이 깨진 명령에서는 덜 나누는 쪽이 아니라 더 나누는 쪽이 차단에 안전하다.
function gateSegments(command) {
  const raws = splitOutsideQuotes(command) ?? command.split(/&&|\|\||;|\n|\|/);
  return raws.map(raw => raw
    .trim()
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*/, '')
    .replace(/^sudo\s+/, ''));
}

// 셸 인용 규칙만 본다: 작은따옴표 안은 그대로, 큰따옴표 안은 백슬래시 이스케이프,
// 따옴표 밖 백슬래시는 다음 한 글자를 구분자에서 제외한다. 닫히지 않으면 null.
function splitOutsideQuotes(s) {
  const out = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      cur += c;
      if (q === '"' && c === '\\' && i + 1 < s.length) { cur += s[++i]; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '\\' && i + 1 < s.length) { cur += c + s[++i]; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === '\n' || c === ';') { out.push(cur); cur = ''; continue; }
    if (c === '&' && s[i + 1] === '&') { out.push(cur); cur = ''; i++; continue; }
    if (c === '|') { out.push(cur); cur = ''; if (s[i + 1] === '|') i++; continue; }
    cur += c;
  }
  if (q) return null;
  out.push(cur);
  return out;
}

function detectClusterMutations(command) {
  const ops = [];
  for (const seg of gateSegments(command)) {
    let m;
    if ((m = seg.match(/^(?:\S*\/)?kubectl\s+(.*)$/s))) {
      const verb = firstPositional(m[1]);
      if (verb && KUBECTL_WRITE.has(verb)) ops.push({ category: 'cluster', scope: KUBECTL_EXEC.has(verb) ? 'cluster-exec' : 'cluster-write', tool: 'kubectl', verb });
    } else if ((m = seg.match(/^(?:\S*\/)?argocd\s+(app|proj|repo|cluster|account|admin)\s+(.*)$/s))) {
      const verb = firstPositional(m[2]);
      if (verb && ARGOCD_WRITE.has(verb)) ops.push({ category: 'cluster', scope: 'cluster-write', tool: `argocd ${m[1]}`, verb });
    } else if ((m = seg.match(/^(?:\S*\/)?helm\s+(.*)$/s))) {
      const verb = firstPositional(m[1]);
      if (verb && HELM_WRITE.has(verb)) ops.push({ category: 'cluster', scope: 'cluster-write', tool: 'helm', verb });
    }
  }
  return ops;
}

// 레포 되돌리기 어려운 행위: PR 머지·릴리즈·레포 삭제/보관·force/삭제 push
function detectRepoActions(command) {
  const ops = [];
  for (const raw of gateSegments(command)) {
    // git 전역 옵션(-C · -c · --git-dir)이 앞에 와도 같은 행위다 (#1083)
    const seg = stripGitGlobalOptions(raw);
    let m;
    if (/^(?:\S*\/)?gh\s+pr\s+merge\b/.test(seg)) {
      ops.push({ category: 'repo', scope: 'repo-merge', tool: 'gh pr', verb: 'merge' });
    } else if ((m = seg.match(/^(?:\S*\/)?gh\s+release\s+(create|edit|delete)\b/))) {
      ops.push({ category: 'repo', scope: 'repo-release', tool: 'gh release', verb: m[1] });
    } else if ((m = seg.match(/^(?:\S*\/)?gh\s+repo\s+(delete|archive)\b/))) {
      ops.push({ category: 'repo', scope: 'repo-delete', tool: 'gh repo', verb: m[1] });
    } else if (/^(?:\S*\/)?git\s+push\b/.test(seg)) {
      // `+<refspec>` 도 강제 push 다. 옵션이 아닌 낱말이 `+` 로 시작하는지 본다 (#1133).
      const plusRefspec = seg.split(/\s+/).slice(2).some(t => /^["']?\+[^\s"']/.test(t));
      if (/(?:^|\s)(?:--force|--force-with-lease|-f)\b/.test(seg) || plusRefspec) ops.push({ category: 'repo', scope: 'git-force', tool: 'git push', verb: 'force' });
      else if (/(?:^|\s)(?:--delete|-d)\b/.test(seg)) ops.push({ category: 'repo', scope: 'git-force', tool: 'git push', verb: 'delete' });
      else if (/\s:[^\s]+/.test(seg)) ops.push({ category: 'repo', scope: 'git-force', tool: 'git push', verb: 'delete-refspec' });
    }
  }
  return ops;
}

// ─── 최종 점검 통과 기록 (#612) ───
// final-check.sh 가 통과 시 남기는 통과 기록을 로컬에서만 확인한다. 네트워크 호출은 없다.
// 통과 기록의 head 와 로컬 추적 브랜치(refs/remotes/origin/<branch>)를 비교하므로, 푸시로 HEAD 가
// 바뀌면 값이 어긋나 통과 기록이 무효가 된다. 통과 기록이 없거나 어긋나면 사유를 돌려주고, 통과면 null.
// ─── 플로우 진입 지표 (#769) ───
// 요청이 조회에서 커밋 · 머지로 넘어갈 때 플로우에 다시 들어가지 않으면 단계 절차가 빠진다.
// 커밋 · push · PR 생성 직전에, 그 세션 대화 기록에서 플로우 가이드를 읽은 흔적이 있는지 한 줄 남긴다.
// 판정 { actions, flow } 를 돌려준다. 차단 여부는 호출부가 정한다. 판정 상수는 위쪽 FLOW_ENTRY_DISABLE 옆에 있다.
function recordFlowEntry(command, hookInput, cwd) {
  // 대화 기록이 없는 호출(자체 점검 · 수동 실행)은 세지 않는다. 실제 하네스 입력에는 늘 있다.
  if (FLOW_ENTRY_DISABLE || !hookInput.transcript_path) return null;
  const actions = [];
  for (const seg of gateSegments(command)) {
    for (const [name, re] of FLOW_ACTION_RES) {
      if (re.test(seg) && !actions.includes(name)) actions.push(name);
    }
  }
  if (!actions.length) return null;
  let flow = 'unknown';
  try {
    // 서브에이전트의 호출이면 그 에이전트 자신의 대화 기록으로 판정한다 (#1114). 하네스는 서브에이전트에도
    // 상위 세션의 기록 경로를 넘겨, 위임받은 에이전트가 읽은 가이드가 보이지 않았다. 상위가 읽은 가이드는
    // 서브에이전트의 컨텍스트에 없으므로 인정하지 않는다. 기록을 찾지 못하면 지금처럼 상위 기록으로 본다.
    const agentTranscript = subagentTranscript(hookInput);
    flow = agentTranscript
      ? flowGuideLoaded(`${hookInput.session_id}--${hookInput.agent_id}`, agentTranscript)
      : flowGuideLoaded(hookInput.session_id, hookInput.transcript_path);
    const file = join(homedir(), '.claude', 'ops-agent', 'metrics', 'flow-entry.jsonl');
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify({
      ts: new Date().toISOString(),
      session: hookInput.session_id || '',
      ...(hookInput.agent_id ? { agent: hookInput.agent_id } : {}),
      actions,
      flow,
      repo: basename(extractCwdFromCommand(command, cwd)),
    }) + '\n');
  } catch { /* 기록 실패가 가드 판정을 바꾸지 않는다 */ }
  return { actions, flow };
}

// 스킬 사용 지표 (#1135). 스킬 이름은 Skill 도구의 input.skill, 또는 플러그인 설치본 skills/<이름>/SKILL.md 의 Read 에서 얻는다.
// 레포 워킹 카피를 읽는 것은 스킬을 쓴 것이 아니라 고치는 것이라 세지 않는다. args · 전체 경로는 남기지 않는다.
// 같은 세션 · 같은 스킬은 첫 1회만 센다. 세션별 캐시 파일(.cache/skill-use/<세션>.txt)에 센 이름을 줄로 둔다.
function recordSkillUse(hookInput) {
  const tool = hookInput.tool_name;
  if (tool !== 'Skill' && tool !== 'Read') return;
  try {
    const sessionId = hookInput.session_id;
    if (!sessionId || !SUBAGENT_ID_RE.test(sessionId)) return;
    const toolInput = hookInput.tool_input || {};
    let skill = null;
    if (tool === 'Skill') {
      // `ops-agent:flow` 와 `flow` 는 같은 스킬이다. 다른 플러그인의 네임스페이스는 남긴다.
      const parts = String(toolInput.skill || '').split(':');
      skill = parts.length === 2 ? skillUseName(parts[0], parts[1]) : parts.length === 1 ? parts[0] : null;
    } else {
      const m = String(toolInput.file_path || '').match(SKILL_INSTALL_PATH_RE);
      if (m) skill = skillUseName(m[1], m[2]);
    }
    if (!skill || !SKILL_NAME_RE.test(skill)) return;
    const home = join(homedir(), '.claude', 'ops-agent');
    const cacheDir = join(home, '.cache', 'skill-use');
    const cacheFile = join(cacheDir, `${sessionId}.txt`);
    if (existsSync(cacheFile)) {
      if (readFileSync(cacheFile, 'utf8').split('\n').includes(skill)) return;
    } else {
      mkdirSync(cacheDir, { recursive: true });
      for (const f of readdirSync(cacheDir)) {
        try { if (Date.now() - statSync(join(cacheDir, f)).mtimeMs > SKILL_CACHE_TTL_MS) rmSync(join(cacheDir, f), { force: true }); } catch { /* 다음 파일 */ }
      }
    }
    appendFileSync(cacheFile, skill + '\n');
    const now = new Date();
    const dir = join(home, 'metrics');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `skill-use-${now.toISOString().slice(0, 7)}.jsonl`), JSON.stringify({
      ts: now.toISOString(),
      session: sessionId,
      skill,
      repo: basename(hookInput.cwd || process.cwd()),
    }) + '\n');
  } catch { /* 기록 실패가 판정을 바꾸지 않는다 */ }
}

// 서브에이전트 기록은 <상위 기록 디렉토리>/<세션>/subagents/ 아래 agent-<id>.jsonl 이다. 워크플로가 띄운 에이전트는
// subagents/workflows/<실행>/ 처럼 한두 단 아래에 있다. 식별자는 경로 조각이 되므로 형식(위쪽 SUBAGENT_ID_RE)이 맞을 때만 쓴다.
function subagentTranscript(hookInput) {
  const { agent_id: agentId, session_id: sessionId, transcript_path: parent } = hookInput;
  if (!agentId || !sessionId || !parent) return null;
  if (!SUBAGENT_ID_RE.test(agentId) || !SUBAGENT_ID_RE.test(sessionId)) return null;
  const name = `agent-${agentId}.jsonl`;
  const find = (dir, depth) => {
    const direct = join(dir, name);
    if (existsSync(direct)) return direct;
    if (depth <= 0) return null;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const hit = find(join(dir, e.name), depth - 1);
      if (hit) return hit;
    }
    return null;
  };
  return find(join(dirname(parent), sessionId, 'subagents'), 3);
}

// 대화 기록은 수십 MB 까지 자란다. 세션마다 읽은 위치를 캐시에 두고 그 뒤만 읽는다.
// 읽음은 마지막 압축 경계 뒤의 흔적만 인정한다 (#891). 압축은 읽은 가이드를 요약으로 대체해, 경계 앞의 읽음으로
// 통과시키면 가이드 없이 PR 을 만든다. 예산이 모자라면 판정하지 않고 unknown 을 남긴다.
// 판정 상수(FLOW_ENTRY_CANDIDATE_RE_G · COMPACT_BOUNDARY_RE)는 위쪽 FLOW_GUIDE_PATH_RE 옆에 있다.
function lastMatchIndex(re, text) {
  let last = -1;
  for (const m of text.matchAll(re)) last = m.index;
  return last;
}

// 가이드 읽음 줄의 시작 위치 중 마지막. 후보 줄을 JSON 으로 풀어 Read(가이드 경로) · Skill(flow) tool_use 만 센다.
function lastGuideReadIndex(text) {
  let last = -1;
  let checkedLine = -1;
  for (const m of text.matchAll(FLOW_ENTRY_CANDIDATE_RE_G)) {
    const start = text.lastIndexOf('\n', m.index) + 1;
    if (start === checkedLine) continue;
    checkedLine = start;
    let end = text.indexOf('\n', m.index);
    if (end < 0) end = text.length;
    if (isGuideReadLine(text.slice(start, end))) last = start;
  }
  return last;
}

function isGuideReadLine(line) {
  let rec;
  try { rec = JSON.parse(line); } catch { return false; }
  const msg = rec && rec.message;
  if (!msg || (rec.type !== 'assistant' && msg.role !== 'assistant') || !Array.isArray(msg.content)) return false;
  return msg.content.some(b => b && b.type === 'tool_use' && b.input && (
    (b.name === 'Read' && typeof b.input.file_path === 'string' && FLOW_GUIDE_PATH_RE.test(b.input.file_path))
    || (b.name === 'Skill' && typeof b.input.skill === 'string' && FLOW_SKILL_RE.test(b.input.skill))));
}

// 대화 기록 이어 읽기. 세션마다 읽은 위치를 캐시에 두고 그 뒤만 줄 경계까지 읽는다. 플로우 진입 · 전문가 경유가 함께 쓴다.
// fresh 는 첫 상태를 만드는 함수다(중첩 객체를 호출마다 새로 만든다). visit(text, 청크 시작 바이트, state) 가 상태를 고친다.
// 예산이 모자라면 멈추고 complete false 를 돌려준다. 읽은 데까지는 캐시에 남아 다음 호출이 이어 읽는다.
function scanTranscriptIncremental(cacheFile, transcriptPath, fresh, visit) {
  let state = fresh();
  try { state = { ...state, ...JSON.parse(readFileSync(cacheFile, 'utf8')) }; } catch { /* 첫 호출 */ }
  let complete = true;
  const fd = openSync(transcriptPath, 'r');
  try {
    const size = statSync(transcriptPath).size;
    if (size < state.offset) state = fresh(); // 기록이 새로 쓰였다
    let pos = state.offset;
    while (pos < size) {
      if (remainingMs() < 300) { complete = false; break; }
      const len = Math.min(FLOW_SCAN_CHUNK, size - pos);
      const buf = Buffer.alloc(len);
      const n = readSync(fd, buf, 0, len, pos);
      if (n <= 0) break;
      // 줄 경계까지만 읽은 것으로 친다. 쓰는 중인 마지막 줄은 다음 호출이 다시 읽는다.
      let end = buf.lastIndexOf(0x0a, n - 1);
      if (end < 0) {
        if (pos + n >= size) break;
        end = n - 1; // 청크보다 긴 줄
      }
      visit(buf.toString('utf8', 0, end + 1), pos, state);
      pos += end + 1;
    }
    state.offset = pos;
  } finally {
    closeSync(fd);
  }
  try {
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(state));
  } catch { /* 캐시가 없으면 다음 호출이 처음부터 읽는다 */ }
  return { state, complete };
}

function flowGuideLoaded(sessionId, transcriptPath) {
  if (!sessionId || !existsSync(transcriptPath)) return 'unknown';
  const cacheFile = join(homedir(), '.claude', 'ops-agent', '.cache', 'flow-entry', `${sessionId}.json`);
  const { state, complete } = scanTranscriptIncremental(cacheFile, transcriptPath, () => ({ offset: 0, loaded: false }), (text, _pos, st) => {
    const hit = lastGuideReadIndex(text);
    const boundary = lastMatchIndex(COMPACT_BOUNDARY_RE, text);
    if (hit > boundary) st.loaded = true;
    else if (boundary > hit) st.loaded = false;
  });
  if (state.loaded && complete) return 'loaded';
  return complete ? 'missed' : 'unknown';
}

// ─── 전문가 경유 지표 (#1154, ADR-0043 결정 2) ───
// 공유 표면 쓰기가 통과할 때 그 세션의 기술 커뮤니케이션 전문가 판정 흔적을 찾아 한 줄 남긴다. 막지 않는다 (2주 기록 뒤 차단 판정).
// 경유는 전문가 파일을 가리키는 에이전트 호출의 결과 첫 줄이 판정 표식일 때뿐이다. 결과는 세 길로 온다:
// 도구 결과(동기 호출) · 완료 알림의 result(백그라운드 호출) · 넘김 틀(SubagentHandback, 결과 자리에는 안내만 남는다).
// 메인 텍스트의 표식은 메인이 스스로 쓴 것이라 세지 않는다. 전문가 파일을 메인이 직접 읽은 것은 판정 불가(inline)다.
function recordExpertRoute() {
  if (!routeInput) return;
  const hookInput = routeInput;
  routeInput = null;
  // 대화 기록 경로가 없는 호출(자체 점검 · 수동 실행)은 세지 않는다. 실제 하네스 입력에는 늘 있다 (플로우 진입과 같다)
  if (!hookInput.transcript_path) return;
  try {
    // 한 호출에 표면이 여럿이면 표면마다 한 줄이다. 판정 · 소비는 명령 순서대로 해서, 앞 표면이 소비한 흔적은 뒤 표면에서 stale 이다.
    for (const found of detectRouteSurfaces(hookInput)) recordOneRoute(hookInput, found);
  } catch { /* 기록 실패가 판정을 바꾸지 않는다 */ }
}

// 경유 지표의 기록 · 캐시 자리. 판별 도구(expert-route-probe.mjs)는 실제 HOME 그대로 훅을 실행하고 이 자리만 임시 디렉토리로 돌린다.
// HOME 을 바꾸면 명령 · git 설정의 `~` 와 includeIf 조건이 다른 곳으로 풀려 실제 세션과 답이 달라진다.
// 상단 실행 중에 불리므로 const 가 아니라 함수 선언이다(TDZ).
function expertRouteBase() { return process.env.OPS_AGENT_EXPERT_ROUTE_DIR || join(homedir(), '.claude', 'ops-agent'); }

function recordOneRoute(hookInput, found) {
  try {
    const judged = judgeExpertRoute(hookInput);
    const now = new Date();
    const dir = join(expertRouteBase(), 'metrics');
    mkdirSync(dir, { recursive: true });
    const cwd = hookInput.cwd || process.cwd();
    appendFileSync(join(dir, `expert-route-${now.toISOString().slice(0, 7)}.jsonl`), JSON.stringify({
      ts: now.toISOString(),
      session: hookInput.session_id || '',
      ...(hookInput.agent_id ? { agent: hookInput.agent_id } : {}),
      surface: found.surface,
      tool: hookInput.tool_name,
      repo: basename(hookInput.tool_name === 'Bash' ? resolveCommandCwd(String((hookInput.tool_input || {}).command || ''), cwd, true).cwd : cwd),
      bodyLines: found.bodyLines,
      verdict: judged.verdict,
      trace: judged.trace,
      scope: judged.scope,
      stale: judged.stale,
      afterCompact: judged.afterCompact,
      ...(judged.reason ? { reason: judged.reason } : {}),
      ...(judged.verdictValue ? { verdictValue: judged.verdictValue } : {}),
    }) + '\n');
    // 기록한 쓰기가 흔적을 소비한다. 다음 쓰기는 이 뒤에 생긴 흔적만 본다.
    for (const c of judged.consume || []) {
      try {
        const st = JSON.parse(readFileSync(c.cacheFile, 'utf8'));
        st.lastWrite = c.offset;
        writeFileSync(c.cacheFile, JSON.stringify(st));
      } catch { /* 캐시가 없으면 다음 쓰기가 이 흔적을 다시 본다 */ }
    }
  } catch { /* 기록 실패가 판정을 바꾸지 않는다 */ }
}

// 표면 오버레이: { "surfaces": [ { "name", "tool"(도구 이름 정규식), "pattern"(Bash 는 명령, 그 밖은 입력 JSON 대상 정규식), "body"?(본문 입력 필드) } ] }
// 파일이 없으면 내장 표면만 본다. 깨졌으면 알림 한 줄을 남기고 내장 표면만 본다.
function loadRouteSurfaces() {
  const file = ROUTE_OVERLAY_FILE();
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || !Array.isArray(parsed.surfaces)) throw new Error('surfaces 배열이 없다');
    return parsed.surfaces.map((e, i) => {
      if (!e || typeof e.name !== 'string' || !e.name || typeof e.tool !== 'string' || typeof e.pattern !== 'string') {
        throw new Error(`surfaces[${i}] 에 name · tool · pattern 문자열이 필요하다`);
      }
      return { name: e.name, tool: new RegExp(e.tool), pattern: new RegExp(e.pattern), body: typeof e.body === 'string' ? e.body : null };
    });
  } catch (e) {
    truncationNotice += `[ops-agent 전문가 경유 지표] 표면 오버레이를 읽지 못해 내장 표면만 판별합니다 (${file}): ${(e && e.message) || e}\n`;
    return [];
  }
}

// 함수 선언으로 둔다. 기록은 모듈 끝의 respondContinue 에서 돌아 const 로 두면 초기화 전 접근이 된다.
function countLines(text) {
  return String(text).replace(/\n+$/, '').split('\n').length;
}

// 호출이 쓰는 공유 표면 목록(명령 순서). 본문 줄 수는 그 세그먼트의 본문 인자에서 센다.
function detectRouteSurfaces(hookInput) {
  const tool = hookInput.tool_name || '';
  const toolInput = hookInput.tool_input || {};
  if (tool === 'Bash') {
    const command = String(toolInput.command || '');
    const found = [];
    let cursor = 0;
    for (const seg of gateSegments(command)) {
      // 표면의 순서는 명령 글자 위치다. 커밋은 아래에서 셸 해석으로 따로 찾아 같은 순서에 끼운다
      const at = seg ? command.indexOf(seg, cursor) : -1;
      const pos = at >= 0 ? at : cursor;
      if (at >= 0) cursor = at + seg.length;
      if (ROUTE_COMMIT_RE.test(seg)) continue;
      const apiSurface = ROUTE_GH_API_RE.test(seg) ? ghApiRouteSurface(seg, resolveCommandCwd(command, hookInput.cwd || process.cwd(), true).cwd) : null;
      if (apiSurface) {
        const texts = ghApiBodyTexts(seg);
        found.push({ pos, surface: apiSurface, bodyLines: texts.length ? Math.max(...texts.map(t => countLines(t))) : null });
        continue;
      }
      for (const [name, re, needsBody] of ROUTE_BUILTIN) {
        if (!re.test(seg) || (needsBody && !ROUTE_BODY_FLAG_RE.test(seg))) continue;
        const texts = [];
        extractOption(seg, 'body', texts);
        extractShortOption(seg, 'b', texts);
        extractFileOption(seg, 'body-file', texts);
        extractShortFileOption(seg, 'F', texts);
        // 히어닥 본문은 세그먼트 밖(다음 줄들)에 있다
        if (STDIN_BODY_RE.test(seg)) for (const m of command.matchAll(HEREDOC_RE)) texts.push({ value: m[3] });
        found.push({ pos, surface: name, bodyLines: texts.length ? Math.max(...texts.map(t => countLines(t.value))) : null });
        break;
      }
    }
    if (GIT_COMMIT_RE.test(command)) {
      const cwd = resolveCommandCwd(command, hookInput.cwd || process.cwd(), true);
      for (const c of cwd.ok ? commitsIn(command) : []) {
        const docLines = commitDocLines(c.scopes, cwd.cwd);
        if (docLines !== null) found.push({ pos: c.start, surface: 'commit-md', bodyLines: docLines });
      }
      found.sort((a, b) => a.pos - b.pos);
    }
    for (const f of found) delete f.pos;
    // 내장 표면이어도 오버레이가 깨졌으면 알린다. 깨진 채로 두면 오버레이 표면이 신호 없이 빠진다
    const overlay = loadRouteSurfaces();
    if (found.length) return found;
    const hit = overlay.find(s => s.tool.test(tool) && s.pattern.test(command));
    return hit ? [{ surface: hit.name, bodyLines: null }] : [];
  }
  const target = JSON.stringify(toolInput);
  const hit = loadRouteSurfaces().find(s => s.tool.test(tool) && s.pattern.test(target));
  if (!hit) return [];
  const body = hit.body && typeof toolInput[hit.body] === 'string' ? toolInput[hit.body] : null;
  return [{ surface: hit.name, bodyLines: body === null ? null : countLines(body) }];
}

// 커밋에 담길 범위 안 md 의 추가 · 변경 줄 합. 범위 안 md 가 없거나 diff 를 읽지 못하면 null. 파일 경로는 돌려주지 않는다.
// 담길 범위는 그 커밋의 인자로 정한다(commitsIn). 해석이 불확실하면 스테이징분과 추적 변경을 함께 본다.
function commitDocLines(scopes, cwd) {
  const perFile = new Map();
  for (const scope of scopes) {
    const out = gitDiffScope(scope, ['--numstat', '--no-renames'], cwd);
    if (out === null) continue;
    for (const l of out.split('\n')) {
      const m = l.match(/^(\d+|-)\t(?:\d+|-)\t(.+)$/);
      if (!m || !ROUTE_DOC_RE.test(m[2]) || isChangelogDoc(m[2])) continue;
      perFile.set(m[2], Math.max(perFile.get(m[2]) || 0, m[1] === '-' ? 0 : Number(m[1])));
    }
  }
  if (!perFile.size) return null;
  return [...perFile.values()].reduce((a, b) => a + b, 0);
}

// gh api 세그먼트가 댓글 · 리뷰를 쓰면 표면 이름, 아니면 null. GraphQL 은 경로가 graphql 이라 mutation 이름으로 본다.
function ghApiRouteSurface(seg, cwd) {
  const api = parseGhApi(seg);
  if (!api) return null;
  if (api.path === 'graphql') {
    // mutation 을 파일로 넘기면(-F query=@파일) 그 파일을 읽는다
    let text = seg;
    for (const m of seg.matchAll(/(?:^|\s)(?:-F|--field)(?:=|\s+)query=@(\S+)/g)) {
      try { text += '\n' + readFileSync(resolvePath(cwd || process.cwd(), stripQuotes(m[1])), 'utf8'); } catch { /* 읽지 못하면 명령 글자만 본다 */ }
    }
    if (!/\bmutation\b/.test(text)) return null;
    const hit = ROUTE_API_MUTATIONS.find(([, re]) => re.test(text));
    return hit ? hit[0] : null;
  }
  if (!ROUTE_API_WRITE_METHODS.has(api.method)) return null;
  const hit = ROUTE_API_PATHS.find(([, re]) => re.test(api.path));
  return hit ? hit[0] : null;
}

// gh api 의 본문 필드: `-f body=…` · `-F body=@파일`(-F 만 @ 를 파일로 읽는다) · `--input 파일`(JSON 의 body). 줄 수만 쓴다.
function ghApiBodyTexts(command) {
  const texts = [];
  for (const m of command.matchAll(ROUTE_API_BODY_FIELD_RE)) {
    const value = stripQuotes(m[2]);
    const typed = m[1] === '-F' || m[1] === '--field';
    if (typed && value.startsWith('@')) {
      try { texts.push(readFileSync(value.slice(1), 'utf8')); } catch { /* 읽지 못하면 줄 수 없음 */ }
    } else {
      texts.push(value);
    }
  }
  for (const m of command.matchAll(ROUTE_API_INPUT_RE)) {
    try {
      const body = JSON.parse(readFileSync(stripQuotes(m[1]), 'utf8')).body;
      if (typeof body === 'string') texts.push(body);
    } catch { /* 표준 입력 · 깨진 JSON 은 줄 수 없음 */ }
  }
  return texts;
}

// 판정. 서브에이전트는 자기 기록을 먼저 보고, 그 뒤에 생긴 흔적이 없으면 상위 기록을 본다 (scope parent).
function judgeExpertRoute(hookInput) {
  const none = reason => ({ verdict: 'unknown', trace: 'none', scope: 'self', stale: false, afterCompact: false, reason });
  const sessionId = hookInput.session_id;
  const parent = hookInput.transcript_path;
  if (!sessionId || !SUBAGENT_ID_RE.test(sessionId) || !parent) return none('no-transcript');
  const agentId = hookInput.agent_id;
  const own = agentId && SUBAGENT_ID_RE.test(agentId) ? subagentTranscript(hookInput) : null;
  if (own) {
    const self = expertTraceIn(`${sessionId}--${agentId}`, own);
    if (!self.complete) return none('budget');
    if (self.fresh || !existsSync(parent)) return { ...classifyExpertRoute(self), scope: 'self', consume: [self.consume] };
    const up = expertTraceIn(sessionId, parent);
    if (!up.complete) return none('budget');
    if (up.fresh) return { ...classifyExpertRoute(up), scope: 'parent', consume: [self.consume, up.consume] };
    // 둘 다 직전 쓰기 뒤 흔적이 없다. 자기 기록에 앞선 흔적이 있으면 자기 기준, 없고 상위에만 있으면 상위 기준으로 stale 을 남긴다
    if (!hasTrace(self.state) && hasTrace(up.state)) return { ...classifyExpertRoute(up), scope: 'parent', consume: [self.consume, up.consume] };
    return { ...classifyExpertRoute(self), scope: 'self', consume: [self.consume] };
  }
  if (!existsSync(parent)) return none('no-transcript');
  const found = expertTraceIn(sessionId, parent);
  if (!found.complete) return none('budget');
  return { ...classifyExpertRoute(found), scope: agentId ? 'parent' : 'self', consume: [found.consume] };
}

function hasTrace(st) {
  return ['via', 'agent', 'read', 'skill'].some(k => st[k] >= 0);
}

// 위치는 흔적이 든 청크의 시작 바이트다. 직전 쓰기(lastWrite, 그때 읽은 끝 위치)보다 뒤인지 가르는 데만 쓴다.
function expertTraceIn(key, transcriptPath) {
  const cacheFile = join(expertRouteBase(), '.cache', 'expert-route', `${key}.json`);
  const fresh = () => ({ offset: 0, lastWrite: 0, calls: {}, agents: {}, via: -1, agent: -1, read: -1, skill: -1, compact: -1 });
  const { state, complete } = scanTranscriptIncremental(cacheFile, transcriptPath, fresh, visitExpertTraces);
  const isFresh = p => p >= 0 && p >= state.lastWrite;
  return {
    state, complete,
    fresh: ['via', 'agent', 'read', 'skill'].some(k => isFresh(state[k])),
    consume: { cacheFile, offset: state.offset },
  };
}

function visitExpertTraces(text, pos, st) {
  let checkedLine = -1;
  for (const m of text.matchAll(EXPERT_CANDIDATE_RE_G)) {
    const start = text.lastIndexOf('\n', m.index) + 1;
    if (start === checkedLine) continue;
    checkedLine = start;
    let end = text.indexOf('\n', m.index);
    if (end < 0) end = text.length;
    let rec;
    try { rec = JSON.parse(text.slice(start, end)); } catch { continue; }
    if (!rec || typeof rec !== 'object') continue;
    if (rec.type === 'system' && rec.subtype === 'compact_boundary') { st.compact = pos; continue; }
    const msg = rec.message || {};
    const content = msg.content;
    if (rec.type === 'assistant' || msg.role === 'assistant') {
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (!b || b.type !== 'tool_use' || !b.input) continue;
        if ((b.name === 'Agent' || b.name === 'Task') && typeof b.input.prompt === 'string' && b.input.prompt.includes('experts/tech-comm.md') && b.id) {
          st.calls[b.id] = 1;
          st.agent = pos;
        } else if (b.name === 'Read' && typeof b.input.file_path === 'string' && b.input.file_path.endsWith(EXPERT_FILE_SUFFIX)) {
          st.read = pos;
        } else if (b.name === 'Skill' && typeof b.input.skill === 'string' && EXPERT_SKILL_RE.test(b.input.skill)) {
          st.skill = pos;
        }
      }
      continue;
    }
    // 아래는 어시스턴트가 쓴 줄이 아니다: 도구 결과 · 완료 알림 · 넘김 틀
    if (Array.isArray(content)) {
      for (const b of content) {
        if (!b || b.type !== 'tool_result' || !st.calls[b.tool_use_id]) continue;
        const resultText = typeof b.content === 'string' ? b.content
          : Array.isArray(b.content) ? b.content.filter(c => c && c.type === 'text').map(c => c.text || '').join('\n') : '';
        const idMatch = resultText.match(AGENT_ID_TEXT_RE);
        if (idMatch) st.agents[idMatch[1]] = 1;
        if (rec.toolUseResult && typeof rec.toolUseResult.agentId === 'string' && SUBAGENT_ID_RE.test(rec.toolUseResult.agentId)) st.agents[rec.toolUseResult.agentId] = 1;
        markVerdict(st, resultText, pos);
      }
    }
    for (const s of [typeof content === 'string' ? content : null, typeof rec.content === 'string' ? rec.content : null,
      rec.attachment && typeof rec.attachment.prompt === 'string' ? rec.attachment.prompt : null]) {
      if (!s) continue;
      if (TASK_NOTE_START_RE.test(s)) {
        for (const note of s.matchAll(TASK_NOTE_RE_G)) {
          const id = note[1].match(NOTE_ID_RE);
          const result = note[1].match(NOTE_RESULT_RE);
          if (id && result && st.calls[id[1].trim()]) markVerdict(st, result[1], pos);
        }
      }
      for (const frame of s.matchAll(HANDBACK_RE_G)) {
        const report = frame[2].match(HANDBACK_REPORT_RE);
        if (report && st.agents[frame[1]]) markVerdict(st, report[1], pos);
      }
    }
  }
}

// 결과 첫 줄이 판정 표식이면 경유 위치와 판정 값을 남긴다. 값은 기록만 하고 판정 규칙(경유)은 바꾸지 않는다.
function markVerdict(st, text, pos) {
  const m = firstNonEmptyLine(text).match(EXPERT_VERDICT_RE);
  if (!m) return;
  st.via = pos;
  st.viaValue = m[1];
}

function firstNonEmptyLine(text) {
  for (const l of String(text).split('\n')) {
    const t = l.trim();
    if (t) return t;
  }
  return '';
}

// 우선순위: 경유 > 직접 읽기(inline) > 표식 없는 전문가 호출(누락) > 전문가 스킬만(판정 불가) > 없음(누락).
// 직전 쓰기 뒤의 흔적이 없고 앞선 흔적만 있으면 누락 · stale 이다.
function classifyExpertRoute(found) {
  const st = found.state;
  const isFresh = p => p >= 0 && p >= st.lastWrite;
  const afterCompact = isFresh(st.compact);
  const base = { stale: false, afterCompact };
  if (isFresh(st.via)) return { ...base, verdict: 'via', trace: 'agent', verdictValue: st.viaValue || '' };
  if (isFresh(st.read)) return { ...base, verdict: 'unknown', trace: 'read', reason: 'inline' };
  if (isFresh(st.agent)) return { ...base, verdict: 'missed', trace: 'agent' };
  if (isFresh(st.skill)) return { ...base, verdict: 'unknown', trace: 'skill', reason: 'expert-unspecified' };
  const prior = [['agent', st.via], ['read', st.read], ['agent', st.agent], ['skill', st.skill]]
    .filter(([, p]) => p >= 0).sort((a, b) => b[1] - a[1])[0];
  return prior ? { ...base, verdict: 'missed', trace: prior[0], stale: true } : { ...base, verdict: 'missed', trace: 'none' };
}

function appendFinalCheckMetric(rec) {
  try {
    const file = join(homedir(), '.claude', 'ops-agent', 'metrics', 'final-check.jsonl');
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n');
  } catch { /* 기록 실패가 판정을 바꾸지 않는다 */ }
}

function checkFinalReceipt(command, hookCwd) {
  const mergeSegs = gateSegments(command).filter(s => /^(?:\S*\/)?gh\s+pr\s+merge\b/.test(s));
  if (!mergeSegs.length) return null;

  const dir = extractCwdFromCommand(command, hookCwd);
  const runGit = args => {
    try {
      return execSync(`git ${args}`, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: budgeted(800) }).trim();
    } catch {
      return null;
    }
  };

  // repo 는 명령 cwd 의 origin 에서 얻는다. 통과 기록 파일명은 <owner>__<repo>__<PR> 이다.
  const parsed = parseRemote(runGit('remote get-url origin') || '');
  const parts = parsed ? parsed.slug.split('/') : [];
  if (parts.length < 3) return { repo: '', pr: '', reason: 'origin 에서 레포를 알 수 없음' };
  const repo = parts.slice(-2).join('/');
  const key = parts.slice(-2).join('__');

  const rest = mergeSegs[0].replace(/^.*?\bpr\s+merge\b/, '').replace(MERGE_VALUE_FLAG, ' ');
  const arg = firstPositional(rest);
  let pr = '';
  let branch = '';
  if (arg && /^\d+$/.test(arg)) pr = arg;
  else if (arg && /\/pull\/(\d+)/.test(arg)) pr = arg.match(/\/pull\/(\d+)/)[1];
  else branch = arg || runGit('rev-parse --abbrev-ref HEAD') || '';

  let receipt = null;
  try {
    if (pr) {
      receipt = JSON.parse(readFileSync(join(finalCheckDir(), `${key}__${pr}.json`), 'utf8'));
    } else {
      // 번호가 없으면 브랜치명으로 찾는다. 같은 브랜치의 통과 기록이 여럿이면 가장 늦은 것을 쓴다.
      const found = readdirSync(finalCheckDir())
        .filter(f => f.startsWith(`${key}__`) && f.endsWith('.json'))
        .map(f => { try { return JSON.parse(readFileSync(join(finalCheckDir(), f), 'utf8')); } catch { return null; } })
        .filter(r => r && r.branch === branch)
        .sort((a, b) => String(b.at).localeCompare(String(a.at)));
      receipt = found[0] || null;
      if (receipt) pr = String(receipt.pr);
    }
  } catch { receipt = null; }
  if (!receipt) return { repo, pr, reason: `통과 기록 없음 (${repo}${pr ? ` #${pr}` : ` 브랜치 ${branch || '?'}`})` };

  const originHead = runGit(`rev-parse refs/remotes/origin/${receipt.branch}`);
  if (!originHead || originHead !== receipt.head) {
    return { repo, pr, reason: `통과 기록 head(${String(receipt.head).slice(0, 7)})가 origin/${receipt.branch}(${originHead ? originHead.slice(0, 7) : '없음'})와 다름` };
  }
  return null;
}

// 명령 뒤 토큰들에서 첫 positional(=서브커맨드/verb) 을 찾는다.
// 플래그(-x)와 값 취하는 플래그의 값 토큰은 건너뛴다. --flag=val 형태는 자체 완결.
function firstPositional(rest) {
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if (tk.startsWith('-')) {
      if (VALUE_FLAGS.has(tk)) i++;
      continue;
    }
    return tk;
  }
  return null;
}
