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
 * 5. 플로우 진입 (#769 · #773): 커밋 · push · PR 생성 직전에 그 세션의 플로우 가이드 읽음 여부를 기록하고,
 *    읽지 않은(missed) 세션의 PR 생성은 차단한다. 비활성 OPS_AGENT_FLOW_ENTRY_DISABLE=1.
 *
 * 키워드 소스: ~/.claude/ops-agent/confidential-keywords.local.json
 * 드라이런: OPS_AGENT_CONFIDENTIAL_DRYRUN=1 설정 시 차단 대신 경고만 출력
 * 비활성: OPS_AGENT_CONFIDENTIAL_DISABLE=1 설정 시 가드 전체 스킵
 */
import { execSync } from 'child_process';
import {
  readFileSync, existsSync, readdirSync, mkdirSync, appendFileSync, writeFileSync, openSync, readSync, closeSync, statSync,
} from 'fs';
import { join, dirname, basename } from 'path';
import { homedir } from 'os';
import { scanWhatViolations, snippet } from './what-guard-rules.mjs';
import { detectGitRiskActions } from './git-guard-rules.mjs';
import { changesOf, scanBuildScriptChange } from './build-guard-rules.mjs';
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
// 훅 본문이 모듈 위쪽에서 돌아 판정 상수도 여기 있어야 한다. 아래로 내리면 초기화 전 접근으로 가드 전체가 내부 오류가 된다.
// 흔적은 도구 입력 필드에 든 가이드 경로(파일 읽기 · 셸 명령)와 flow 스킬 호출이다.
// 세션 시작에 주입되는 트리거 표에도 가이드 경로가 문자열로 있어서, 경로만 찾으면 전부 읽음이 된다.
// 값은 JSON 문자열이라 명령 안의 따옴표가 \" 로 들어 있다. 이스케이프를 건너뛰며 같은 값 안에서만 찾는다.
const FLOW_ENTRY_RE = /"(?:file_path|command)":"(?:[^"\\]|\\.)*skills\/flow\/(?:SKILL\.md|guides\/)|"skill":"(?:ops-agent:)?flow"/;
const FLOW_ACTION_RES = [
  ['commit', /^(?:\S*\/)?git(?:\s+-C\s+\S+)*\s+commit\b/],
  ['push', /^(?:\S*\/)?git(?:\s+-C\s+\S+)*\s+push\b/],
  ['pr', /^(?:\S*\/)?gh\s+pr\s+create\b/],
];
const FLOW_SCAN_CHUNK = 4 << 20;
const FLOW_PR_DENY = '[ops-agent 플로우 진입 · 차단] 이 세션은 플로우 가이드를 읽지 않고 PR 을 만듭니다 (#773).\n'
  + 'PR 생성의 초안 · 본문 · 리뷰 요청 순서는 가이드에 있습니다. 먼저 읽고 가이드 절차(초안 생성)대로 다시 만듭니다:\n'
  + '  ~/.claude/ops-agent/current/skills/flow/guides/pr.md\n'
  + '읽으면 이 세션은 끝까지 통과합니다. 비활성: OPS_AGENT_FLOW_ENTRY_DISABLE=1';
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
const VALUE_FLAGS = new Set([
  '-n', '--namespace', '--context', '--cluster', '--user', '--kubeconfig',
  '-o', '--output', '-l', '--selector', '--field-selector', '-f', '--filename',
  '--server', '--token', '--as', '--as-group', '--cache-dir', '--request-timeout',
  '--grpc-web-root-path',
]);

let truncationNotice = '';

if (!DISABLE) {
  try {
    const hookInput = JSON.parse(input);
    // 레포 유형 선언 편집 차단 (ADR-0028). 유형은 사람이 선언한다.
    if (writesRepoTypeFile(hookInput.tool_name || '', hookInput.tool_input)) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: REPO_TYPE_DENY_EDIT },
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
            `비활성: OPS_AGENT_WHAT_GUARD_DISABLE=1 (예외 상황만)`;
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
            `       (--start [--worktree|--checkout] | --no-start "<사유>") [-R <레포>] [--structure <iss1|iss5|iss6|iss7>]\n` +
            `필수 판단 둘:\n` +
            `  - 시작 결정: 지금 손대는 이슈면 --start, 백로그 · 후속이면 --no-start "<사유>"\n` +
            `  - 기존 기록: ISS5 본문 ## Why 에 「- 기존 기록: {이전 · 지금 · 바뀐 점 | 없음 · 찾은 자리}」 한 줄 (ADR-0027)\n` +
            `본문 규칙: config/style-rules/extensions/issue.md · 가이드: skills/flow/guides/issue.md\n` +
            `드라이런: OPS_AGENT_ISSUE_CREATE_GUARD_DRYRUN=1 · 비활성: OPS_AGENT_ISSUE_CREATE_GUARD_DISABLE=1`;
          if (ISSUE_CREATE_GUARD_DRYRUN) {
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
            `  !bash ${gateRoot}/scripts/action-gate-allow.sh on ${scopeArg}\n\n` +
            `이 명령은 위 갈래(${scopeArg})만 엽니다. 다른 갈래는 계속 차단되고 다시 사람에게 옵니다.\n` +
            (carried.length
              ? `\`on\` 은 열려 있던 갈래를 대체합니다. 이미 열린 갈래(${carried.join(',')})를 위 명령에 함께 담았으니 이 한 줄로 필요한 갈래가 모두 열립니다.\n`
              : '') +
            `어시스턴트가 이 스크립트를 실행하면 자기 수정으로 차단됩니다. 정상 동작이며 우회하지 않습니다.\n` +
            `자연어 승인("승인합니다"·"머지 승인" 등)은 권한을 열지 않습니다. 마커 파일 생성만이 개방 신호입니다.\n` +
            `read-only·가역 명령(git commit, 브랜치 push, gh pr create 등)은 통과합니다.\n` +
            `전체 절차: docs/action-gate.md · 해제: action-gate-allow.sh off · 파이프라인 비활성: OPS_AGENT_ACTION_GATE_DISABLE=1`;
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
            `그리고 ## 판단 검토 절에 제로베이스 검토 회차를 한 줄씩 적고, 마지막 회차의 차단 지적이 0건이어야 합니다:\n` +
            `  - 1회: 차단 2건 · 권장 3건 · 사소 1건\n  - 2회: 차단 0건 · 권장 1건 · 사소 1건\n` +
            `푸시로 HEAD 가 바뀌면 통과 기록은 무효가 되므로 다시 실행합니다.\n` +
            `전체 절차: docs/action-gate.md 「최종 점검 통과 기록」 · 해제: OPS_AGENT_FINAL_CHECK_DISABLE=1`;
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
// 이 훅은 가드 판정만 담당하고, 통과 시 추가 컨텍스트를 싣지 않는다.
function respondContinue() {
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
  const ti = toolInput || {};
  if (/^(?:Edit|Write|MultiEdit|NotebookEdit)$/.test(toolName)) {
    return [ti.file_path, ti.notebook_path].some(f => typeof f === 'string' && REPO_TYPE_FILE.test(f));
  }
  if (toolName !== 'Bash') return false;
  const NAME = 'repo-type.json';
  for (const seg of gateSegments(ti.command || '')) {
    if (!seg.includes(NAME)) continue;
    const toks = seg.split(/\s+/).filter(Boolean).map(t => t.replace(/^["']|["']$/g, ''));
    const cmd = (toks[0] || '').replace(/^.*\//, '');
    if (/>>?\|?\s*["']?[^\s;|&"']*repo-type\.json/.test(seg)) return true;
    if (cmd === 'tee' || cmd === 'rm' || cmd === 'mv') return true;
    if (cmd === 'sed' && toks.some(t => /^-[A-Za-z]*i[A-Za-z]*$/.test(t) || t.startsWith('--in-place'))) return true;
    if ((cmd === 'cp' || cmd === 'ln') && toks[toks.length - 1].endsWith(NAME)) return true;
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

function resolveCommandCwd(command, fallbackCwd) {
  const cdMatch = command.match(/\bcd\s+["']?([^\s"'&;|]+)["']?/);
  const gitCMatch = command.match(/\bgit\s+-C\s+["']?([^\s"'&;|]+)["']?/);
  const raw = (cdMatch && cdMatch[1]) || (gitCMatch && gitCMatch[1]);
  if (!raw) return { cwd: fallbackCwd, ok: true, source: 'hook cwd' };

  const source = cdMatch ? 'cd' : 'git -C';
  // 미확장 셸 표현이 남아 있으면 경로가 아니다.
  if (/[$`*?]/.test(raw)) {
    return { cwd: fallbackCwd, ok: false, source, reason: `${source} 인자에 미확장 셸 표현: ${raw}` };
  }
  const path = expandHome(raw);
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
  const tokens = segment.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+/g) || [];
  const apiIdx = tokens.findIndex(t => /^(?:\S*\/)?gh$/.test(t));
  if (apiIdx < 0 || tokens[apiIdx + 1] !== 'api') return false;
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
  if (!path) return false;
  const bare = path.replace(/\?.*$/, '').replace(/\/+$/, '');
  if (/^graphql$/.test(bare)) return /\bcreateIssue\b/.test(segment);
  if (!/(?:^|\/)issues$/.test(bare)) return false;
  const effective = method || (hasParam ? 'POST' : 'GET');
  return effective === 'POST';
}

function detectDirectIssueCreate(command) {
  const hits = [];
  for (const seg of gateSegments(command)) {
    if (/^(?:\S*\/)?gh\s+issue\s+create\b/.test(seg)) hits.push(seg.length > 120 ? seg.slice(0, 120) + '…' : seg);
    else if (/^(?:\S*\/)?gh\s+api\b/.test(seg) && ghApiCreatesIssue(seg)) hits.push(seg.length > 120 ? seg.slice(0, 120) + '…' : seg);
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
  for (const seg of gateSegments(command)) {
    let m;
    if (/^(?:\S*\/)?gh\s+pr\s+merge\b/.test(seg)) {
      ops.push({ category: 'repo', scope: 'repo-merge', tool: 'gh pr', verb: 'merge' });
    } else if ((m = seg.match(/^(?:\S*\/)?gh\s+release\s+(create|edit|delete)\b/))) {
      ops.push({ category: 'repo', scope: 'repo-release', tool: 'gh release', verb: m[1] });
    } else if ((m = seg.match(/^(?:\S*\/)?gh\s+repo\s+(delete|archive)\b/))) {
      ops.push({ category: 'repo', scope: 'repo-delete', tool: 'gh repo', verb: m[1] });
    } else if (/^(?:\S*\/)?git\s+push\b/.test(seg)) {
      if (/(?:^|\s)(?:--force|--force-with-lease|-f)\b/.test(seg)) ops.push({ category: 'repo', scope: 'git-force', tool: 'git push', verb: 'force' });
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
    flow = flowGuideLoaded(hookInput.session_id, hookInput.transcript_path);
    const file = join(homedir(), '.claude', 'ops-agent', 'metrics', 'flow-entry.jsonl');
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify({
      ts: new Date().toISOString(),
      session: hookInput.session_id || '',
      actions,
      flow,
      repo: basename(extractCwdFromCommand(command, cwd)),
    }) + '\n');
  } catch { /* 기록 실패가 가드 판정을 바꾸지 않는다 */ }
  return { actions, flow };
}

// 대화 기록은 수십 MB 까지 자란다. 세션마다 읽은 위치를 캐시에 두고 그 뒤만 읽는다.
// 한 번 찾으면 그 세션은 끝까지 loaded 다. 예산이 모자라면 판정하지 않고 unknown 을 남긴다.
function flowGuideLoaded(sessionId, transcriptPath) {
  if (!sessionId || !existsSync(transcriptPath)) return 'unknown';
  const cacheFile = join(homedir(), '.claude', 'ops-agent', '.cache', 'flow-entry', `${sessionId}.json`);
  let state = { offset: 0, loaded: false };
  try { state = { ...state, ...JSON.parse(readFileSync(cacheFile, 'utf8')) }; } catch { /* 첫 호출 */ }
  if (state.loaded) return 'loaded';

  let verdict = 'missed';
  const fd = openSync(transcriptPath, 'r');
  try {
    const size = statSync(transcriptPath).size;
    if (size < state.offset) state.offset = 0; // 기록이 새로 쓰였다
    let pos = state.offset;
    while (pos < size) {
      if (remainingMs() < 300) { verdict = 'unknown'; break; }
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
      const hit = FLOW_ENTRY_RE.test(buf.toString('utf8', 0, end + 1));
      pos += end + 1;
      if (hit) { state.loaded = true; verdict = 'loaded'; break; }
    }
    state.offset = pos;
  } finally {
    closeSync(fd);
  }
  try {
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(state));
  } catch { /* 캐시가 없으면 다음 호출이 처음부터 읽는다 */ }
  return verdict;
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
