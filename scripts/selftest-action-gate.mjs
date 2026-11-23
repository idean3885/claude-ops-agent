#!/usr/bin/env node
/**
 * selftest-action-gate.mjs — 한시 권한 판정 자체 점검.
 *
 * `pre-tool-use.mjs` 를 고쳤으면 이것을 돌린다. 게이트는 발동할 때만 존재가 드러나므로,
 * 조용히 무력화되면 아무 신호가 없다. 실제로 판정 스니펫의 종료 코드가 뒤집힌 채 배포된
 * 이력이 있다 (#386).
 *
 * 갈래를 모두 열어(OPS_AGENT_ACTION_GATE_ALLOW=1) 돌린다. 동거 검사는 게이트가 열린 상태에서만
 * 발동하고, 그 상태가 정확히 사고가 난 조건이다.
 *
 * 사용: node scripts/selftest-action-gate.mjs
 * 종료 코드: 실패 1, 전부 통과 0
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { basename, dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const hook = join(here, 'pre-tool-use.mjs');
const repoRoot = join(here, '..');

// 레포 유형 선언이 없으면 work 라 `gh pr merge` 가 거부된다 (ADR-0028). 기존 케이스는 갈래 판정을 보는 것이라
// 저장소 유형을 선언한 임시 레포를 cwd 로 쓴다.
const storageRepo = mkdtempSync(join(tmpdir(), 'storage-repo-'));
mkdirSync(join(storageRepo, '.git'));
mkdirSync(join(storageRepo, '.ops-agent'));
writeFileSync(join(storageRepo, '.ops-agent', 'repo-type.json'), '{"type": "storage"}');
// 드래프트 생략을 선언한 개인 레포 (#1166). 선언이 있을 때만 드래프트 없는 생성 · 준비 완료 전환이 통과한다.
const skipDraftRepo = mkdtempSync(join(tmpdir(), 'skip-draft-repo-'));
mkdirSync(join(skipDraftRepo, '.git'));
mkdirSync(join(skipDraftRepo, '.ops-agent'));
writeFileSync(join(skipDraftRepo, '.ops-agent', 'repo-type.json'), '{"type": "storage", "allow": ["skip-draft"]}');

// want: 'pass' = 통과해야 한다, 'deny' = 차단되어야 한다
const CASES = [
  ['gated 행위 단독', 'gh pr merge 386 --merge', 'pass'],
  ['cd 뒤 머지', `cd ${storageRepo} && gh pr merge 386 --merge`, 'pass'],
  ['레포 밖으로 cd 한 머지는 work 취급', 'cd /tmp && gh pr merge 386 --merge', 'deny'],
  ['주석 뒤 머지', '# 버전 대조 통과\ngh pr merge 386 --merge', 'pass'],
  ['환경 설정 뒤 머지', 'export GH_HOST=github.com\ngh pr merge 386 --merge', 'pass'],
  ['머지 뒤 정리', 'gh pr merge 386 --merge && git worktree list', 'pass'],
  ['버전 검사 체인', 'bash scripts/pre-merge-check.sh fix/1 main && gh pr merge 1 --merge', 'pass'],
  ['버전 검사 절대경로 체인', 'bash /a/b/scripts/pre-merge-check.sh && gh pr merge 1 --merge', 'pass'],
  ['게이트 무관 명령', 'git log --oneline -3\ngit status', 'pass'],
  // 사고 재현: 판정을 출력하는 스니펫과 머지가 한 블록
  ['판정 스니펫 뒤 머지', 'bv=$(git show origin/main:VERSION)\necho "$bv"\ngh pr merge 386 --merge', 'deny'],
  ['조회 뒤 머지', 'git log --oneline -3\ngh pr merge 386 --merge', 'deny'],
  ['조회 뒤 릴리즈', 'gh release list\ngh release create v1 -n x', 'deny'],
  ['조회 뒤 클러스터 삭제', 'kubectl get pods\nkubectl delete pod x', 'deny'],
  ['파이프 뒤 머지', 'echo y | gh pr merge 386 --merge', 'deny'],
  // 따옴표 안 구분자는 명령 경계가 아니다 (#473). 검색 패턴·인용문의 행위 문구가 세그먼트로 떨어져 오탐했다.
  ["따옴표 안 행위 문구를 검색하는 읽기 명령", "grep -n '웹 머지\\|머지는 사용자가\\|gh pr merge' skills/flow/SKILL.md | head -12", "pass"],
  ["따옴표 안 행위 문구 echo", "echo 'gh pr merge 1 --merge'", "pass"],
  ["큰따옴표 안 구분자와 행위 문구", "echo \"x; gh pr merge 1 --merge\"", "pass"],
  ["따옴표 밖 구분자 뒤 머지", "echo x; gh pr merge 1 --merge", "deny"],
  ["닫힌 따옴표 뒤 실제 체인", "echo 'x'; gh pr merge 1 --merge", "deny"],
  ["따옴표 안 문구 조회 뒤 실제 머지", "git log --grep='gh pr merge' -1\ngh pr merge 1 --merge", "deny"],
  ["닫히지 않은 따옴표는 종전 분할로 폴백", "echo 'x; gh pr merge 1 --merge", "deny"],
];

// 개방 안내가 「잃는 갈래」만 알리는지. prev → new 로 다시 열 때 사라지는 갈래가 없으면
// 알릴 것이 없다. 알리면 사용자가 그 문구를 실행해 중복된 목록을 마커에 넣는다 (#388).
// 마커를 만들지 않도록 함수만 불러 쓴다(OPS_AGENT_GATE_LIB=1).
const SCOPE_CASES = [
  ['새 목록이 이전을 포함', 'repo-merge', 'repo-merge,worktree-destructive,git-force', ''],
  ['같은 목록', 'repo-merge', 'repo-merge', ''],
  ['이전이 없음', '', 'repo-merge', ''],
  ['새 목록이 전체 개방', 'repo-merge,git-force', 'all', ''],
  ['갈래 하나가 닫힘', 'repo-merge,git-force', 'repo-merge', 'on repo-merge,git-force'],
  ['갈래가 전부 교체', 'repo-merge', 'cluster-write', 'on cluster-write,repo-merge'],
  ['전체 개방이 닫힘', 'all', 'repo-merge', 'on all'],
  ['이전 목록에 공백', 'repo-merge, git-force', 'repo-merge', 'on repo-merge,git-force'],
  ['이름에 all 을 담은 갈래', 'install-write', 'repo-merge', 'on repo-merge,install-write'],
];

let failed = 0;
for (const [name, prev, next, expect] of SCOPE_CASES) {
  const res = spawnSync('bash', ['-c',
    'set -euo pipefail; OPS_AGENT_GATE_LIB=1 . "$1"; warn_lost_scopes "$2" "$3"',
    'selftest', join(here, 'action-gate-allow.sh'), prev, next,
  ], { encoding: 'utf8' });
  const warn = (res.stderr || '').trim();
  const ok = expect ? warn.includes(expect) : warn === '';
  if (!ok) failed++;
  console.log(`${ok ? '  OK' : '  XX'}  개방 안내: ${name} — ${warn || '알림 없음'}`);
}

// ttl 자리에 숫자가 아닌 값이 오면 산술식에 넣기 전에 형식을 돌려주는지. 갈래를 공백으로
// 나열하면 둘째 갈래가 이 자리로 들어오고, 그대로 두면 bash 내부 오류로 죽어 원인이
// 가려진다 (#414). HOME 을 임시 경로로 돌려 사용자가 연 게이트를 건드리지 않는다.
const TTL_CASES = [
  ['갈래를 공백으로 나열', ['on', 'git-force', 'cluster-write'], 1, 'on git-force,cluster-write'],
  ['ttl 이 숫자', ['on', 'git-force', '30'], 0, ''],
  ['ttl 생략', ['on', 'git-force'], 0, ''],
  ['옛 형식 (ttl 만)', ['on', '30'], 0, ''],
  // 갈래 이름은 스크립트 머리 주석의 목록과 대조한다 (#439). 오타가 마커에 들어가면 열린 것처럼 보인다.
  ['없는 갈래 이름', ['on', 'clustr-write'], 1, '유효한 갈래: '],
  ['목록 중 하나가 없는 이름', ['on', 'repo-merge,git-frce'], 1, '없는 갈래입니다: git-frce'],
  ['새 갈래 이름', ['on', 'cluster-exec'], 0, ''],
];
for (const [name, args, wantCode, expect] of TTL_CASES) {
  const home = mkdtempSync(join(tmpdir(), 'gate-selftest-'));
  const res = spawnSync('bash', [join(here, 'action-gate-allow.sh'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
  const err = (res.stderr || '').trim();
  const ok = res.status === wantCode && (expect ? err.includes(expect) : true);
  if (!ok) failed++;
  rmSync(home, { recursive: true, force: true });
  console.log(`${ok ? '  OK' : '  XX'}  ttl 검사: ${name} — want ${wantCode}, got ${res.status}${err ? ` · ${err.split('\n').pop()}` : ''}`);
}

for (const [name, command, want] of CASES) {
  const res = spawnSync('node', [hook], {
    input: JSON.stringify({
      tool_name: 'Bash',
      cwd: storageRepo,
      session_id: 'selftest',
      tool_input: { command },
    }),
    encoding: 'utf8',
    // 통과 기록 검사는 아래 별도 케이스에서 본다. 여기서는 동거 검사 판정만 보도록 끈다.
    env: { ...process.env, OPS_AGENT_ACTION_GATE_ALLOW: '1', OPS_AGENT_FINAL_CHECK_DISABLE: '1' },
  });

  let got = 'pass';
  let detail = '';
  const out = (res.stdout || '').trim();
  if (out) {
    try {
      const d = JSON.parse(out);
      const hs = d.hookSpecificOutput;
      if (hs && hs.permissionDecision === 'deny') {
        got = 'deny';
        detail = hs.permissionDecisionReason.split('\n')[0];
      } else if (d.systemMessage) {
        got = 'error';
        detail = d.systemMessage.split('\n')[0];
      }
    } catch {
      got = 'unparsed';
      detail = out.slice(0, 160);
    }
  }

  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? '  OK' : '  XX'}  ${name} — want ${want}, got ${got}${detail ? ` · ${detail}` : ''}`);
}

// 마커로 연 갈래별 판정. 임시 HOME 에 마커를 만들어 갈래가 행위를 가르는지 본다.
// scopes 가 null 이면 마커가 없다(전부 닫힘). 사용자가 연 게이트를 건드리지 않는다.
function scopeGateCase(name, want, command, scopes) {
  const home = mkdtempSync(join(tmpdir(), 'scope-selftest-'));
  if (scopes) {
    const dir = join(home, '.claude', 'ops-agent', '.cache');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'action-gate-allow.json'), JSON.stringify({ expiresAt: Date.now() + 600000, scopes }));
  }
  const res = spawnSync('node', [hook], {
    input: JSON.stringify({ tool_name: 'Bash', cwd: repoRoot, session_id: 'selftest', tool_input: { command } }),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, OPS_AGENT_ACTION_GATE_ALLOW: '', OPS_AGENT_CLUSTER_WRITE_ALLOW: '', OPS_AGENT_FINAL_CHECK_DISABLE: '1' },
  });
  let got = 'pass';
  try {
    const hs = JSON.parse((res.stdout || '').trim()).hookSpecificOutput;
    if (hs && hs.permissionDecision === 'deny') got = 'deny';
  } catch { /* 출력 없음 = 통과 */ }
  rmSync(home, { recursive: true, force: true });
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? '  OK' : '  XX'}  갈래 판정: ${name} — want ${want}, got ${got}`);
}
const SCOPE_GATE_CASES = [
  // git clean 은 지우는 실행만 대상이다. 목록만 보는 -n · --dry-run 은 막지 않는다 (#660).
  ['git clean -fd 는 닫힘', 'deny', 'git clean -fd', null],
  ['git clean -nfd 는 통과', 'pass', 'git clean -nfd', null],
  ['git clean -fdn 은 통과', 'pass', 'git clean -fdn', null],
  ['git clean -fd --dry-run 은 통과', 'pass', 'git clean -fd --dry-run', null],
  ['git clean -fd 는 열린 갈래에서 통과', 'pass', 'git clean -fd', ['worktree-destructive']],
  // exec · cp 는 cluster-exec 로 분리했다. 쓰기 갈래를 열지 않고 진입만 열 수 있다 (#445).
  ['exec 는 닫힘', 'deny', 'kubectl exec -it pod-a -- sh', null],
  ['cluster-exec 가 exec 를 연다', 'pass', 'kubectl exec -it pod-a -- sh', ['cluster-exec']],
  ['cluster-exec 가 cp 를 연다', 'pass', 'kubectl cp pod-a:/tmp/x ./x', ['cluster-exec']],
  ['cluster-exec 는 쓰기를 열지 않는다', 'deny', 'kubectl delete pod pod-a', ['cluster-exec']],
  ['cluster-write 는 exec 를 계속 연다 (호환)', 'pass', 'kubectl exec -it pod-a -- sh', ['cluster-write']],
  ['cluster-write 는 쓰기를 연다', 'pass', 'kubectl delete pod pod-a', ['cluster-write']],
  // git 전역 옵션이 앞에 와도 같은 행위로 감지한다 (#1083)
  ['-C 선행 강제 푸시는 닫힘', 'deny', 'git -C /tmp/x push --force-with-lease origin feature/x', null],
  ['-c 선행 강제 푸시는 닫힘', 'deny', 'git -c core.quotepath=false push --force origin feature/x', null],
  ['--git-dir= 선행 원격 브랜치 삭제는 닫힘', 'deny', 'git --git-dir=/tmp/x/.git push origin --delete feature/x', null],
  ['-C 선행 기본 브랜치 push 는 닫힘', 'deny', 'git -C . push origin main', null],
  ['-C 선행 reset --hard 는 닫힘', 'deny', 'git -C . reset --hard HEAD~1', null],
  ['-C 선행 일반 push 는 통과', 'pass', 'git -C . push origin feature/x', null],
  ['-C 선행 강제 푸시는 열린 갈래에서 통과', 'pass', 'git -C /tmp/x push --force-with-lease origin feature/x', ['git-force']],
  // 기본 브랜치 강제 푸시는 git-force 와 git-default-push 둘 다 열려야 통과한다 (#1133)
  ['기본 브랜치 강제 푸시는 닫힘', 'deny', 'git push --force-with-lease origin main', null],
  ['기본 브랜치 강제 푸시는 git-force 만으로 닫힘', 'deny', 'git push --force-with-lease origin main', ['git-force']],
  ['기본 브랜치 강제 푸시는 git-default-push 만으로 닫힘', 'deny', 'git push --force origin main', ['git-default-push']],
  ['기본 브랜치 강제 푸시는 두 갈래가 열리면 통과', 'pass', 'git push --force-with-lease origin main', ['git-force', 'git-default-push']],
  ['기본 브랜치가 아닌 강제 푸시는 git-force 만으로 통과', 'pass', 'git push --force origin feature/x', ['git-force']],
  ['기본 브랜치 일반 push 는 git-force 만으로 닫힘 (회귀)', 'deny', 'git push origin main', ['git-force']],
  ['기본 브랜치가 아닌 일반 push 는 통과 (회귀)', 'pass', 'git push origin feature/x', null],
  // `+` refspec 은 강제 푸시다 (#1133)
  ['+refspec 강제 푸시는 닫힘', 'deny', 'git push origin +feature/x', null],
  ['+refspec 강제 푸시는 git-force 로 통과', 'pass', 'git push origin +feature/x', ['git-force']],
  ['+src:dst 강제 푸시는 닫힘', 'deny', 'git push origin +HEAD:feature/x', null],
  ['+기본 브랜치 refspec 은 git-force 만으로 닫힘', 'deny', 'git push origin +HEAD:main', ['git-force']],
  ['+기본 브랜치 refspec 은 두 갈래가 열리면 통과', 'pass', 'git push origin +HEAD:main', ['git-force', 'git-default-push']],
];
for (const [name, want, command, scopes] of SCOPE_GATE_CASES) scopeGateCase(name, want, command, scopes);

// 최종 점검 통과 기록 (#612). 게이트가 열린 상태에서 `gh pr merge` 가 통과 기록으로 갈리는지 본다.
// 임시 HOME 에 통과 기록을 만들고 임시 레포의 origin 추적 브랜치와 대조한다. 사용자의 통과 기록·
// 지표 파일을 건드리지 않고 네트워크도 쓰지 않는다.
const RECEIPT_REPO = 'selftest/repo';
const RECEIPT_BRANCH = 'feat/7';
function receiptCase(name, want, setup, command = 'gh pr merge 7 --merge') {
  const home = mkdtempSync(join(tmpdir(), 'receipt-selftest-'));
  const repo = join(home, 'work');
  mkdirSync(repo);
  const git = (...a) => spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  git('init', '-q');
  mkdirSync(join(repo, '.ops-agent'));
  writeFileSync(join(repo, '.ops-agent', 'repo-type.json'), '{"type": "storage"}');
  git('remote', 'add', 'origin', `https://github.com/${RECEIPT_REPO}.git`);
  git('commit', '-q', '--allow-empty', '-m', 'x');
  const head = git('rev-parse', 'HEAD').stdout.trim();
  git('update-ref', `refs/remotes/origin/${RECEIPT_BRANCH}`, head);
  const dir = join(home, '.claude', 'ops-agent', '.cache', 'final-check');
  mkdirSync(dir, { recursive: true });
  setup({ dir, head });

  const res = spawnSync('node', [hook], {
    input: JSON.stringify({ tool_name: 'Bash', cwd: repo, session_id: 'selftest', tool_input: { command } }),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, OPS_AGENT_ACTION_GATE_ALLOW: '1', OPS_AGENT_FINAL_CHECK_DISABLE: '' },
  });
  let got = 'pass';
  let detail = '';
  try {
    const hs = JSON.parse((res.stdout || '').trim()).hookSpecificOutput;
    if (hs && hs.permissionDecision === 'deny') { got = 'deny'; detail = hs.permissionDecisionReason.split('\n')[0]; }
  } catch { /* 출력 없음 = 통과 */ }
  // 차단이면 지표에 blocked 한 줄이 남아야 하고, 통과면 남지 않아야 한다.
  const metrics = join(home, '.claude', 'ops-agent', 'metrics', 'final-check.jsonl');
  const logged = existsSync(metrics) && readFileSync(metrics, 'utf8').includes('"result":"blocked"');
  const ok = got === want && logged === (want === 'deny');
  if (!ok) failed++;
  rmSync(home, { recursive: true, force: true });
  console.log(`${ok ? '  OK' : '  XX'}  통과 기록: ${name} — want ${want}, got ${got}${logged ? ' · 지표 기록' : ''}${detail ? ` · ${detail}` : ''}`);
}
const writeReceipt = (dir, pr, head, branch = RECEIPT_BRANCH) =>
  writeFileSync(join(dir, `${RECEIPT_REPO.replace('/', '__')}__${pr}.json`),
    JSON.stringify({ pr, head, branch, repo: RECEIPT_REPO, at: new Date().toISOString() }));
const RECEIPT_CASES = [
  ['통과 기록 없음', 'deny', () => {}],
  ['head 일치', 'pass', ({ dir, head }) => writeReceipt(dir, 7, head)],
  ['head 불일치 (푸시로 바뀜)', 'deny', ({ dir }) => writeReceipt(dir, 7, '0'.repeat(40))],
  ['다른 PR 의 통과 기록', 'deny', ({ dir, head }) => writeReceipt(dir, 8, head)],
  ['번호 없이 브랜치명으로 일치', 'pass', ({ dir, head }) => writeReceipt(dir, 7, head), `gh pr merge ${RECEIPT_BRANCH} --merge`],
  ['번호 앞 값 플래그', 'pass', ({ dir, head }) => writeReceipt(dir, 7, head), 'gh pr merge --subject "x y" 7 --merge'],
];
for (const [name, want, setup, command] of RECEIPT_CASES) receiptCase(name, want, setup, command);

// 레포 유형 (ADR-0028). 임시 레포(git init)에 선언을 두고 훅과 개방 스크립트가 같은 판정을 내리는지 본다.
// 선언 없음 · 잘못된 JSON · 모르는 값은 work 다.
const TYPE_MERGE = 'gh pr merge 7 --merge';
function typeRepo(decl) {
  const home = mkdtempSync(join(tmpdir(), 'type-selftest-'));
  const repo = join(home, 'work');
  mkdirSync(repo);
  spawnSync('git', ['-C', repo, 'init', '-q']);
  if (decl !== null) {
    mkdirSync(join(repo, '.ops-agent'));
    writeFileSync(join(repo, '.ops-agent', 'repo-type.json'), decl);
  }
  return { home, repo };
}
function runHook({ home, repo }, toolName, toolInput, marker = 'all') {
  if (marker) {
    const dir = join(home, '.claude', 'ops-agent', '.cache');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'action-gate-allow.json'), JSON.stringify({ expiresAt: Date.now() + 600000, scopes: marker.split(',') }));
  }
  const res = spawnSync('node', [hook], {
    input: JSON.stringify({ tool_name: toolName, cwd: repo, session_id: 'selftest', tool_input: toolInput }),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, OPS_AGENT_ACTION_GATE_ALLOW: '', OPS_AGENT_CLUSTER_WRITE_ALLOW: '', OPS_AGENT_FINAL_CHECK_DISABLE: '' },
  });
  try {
    const hs = JSON.parse((res.stdout || '').trim()).hookSpecificOutput;
    if (hs && hs.permissionDecision === 'deny') return { got: 'deny', reason: hs.permissionDecisionReason };
  } catch { /* 출력 없음 = 통과 */ }
  return { got: 'pass', reason: '' };
}
function typeCase(group, name, want, decl, toolName, toolInput, { marker = 'all', reasonHas = '' } = {}) {
  const ctx = typeRepo(decl);
  const { got, reason } = runHook(ctx, toolName, toolInput, marker);
  rmSync(ctx.home, { recursive: true, force: true });
  const ok = got === want && (!reasonHas || reason.includes(reasonHas));
  if (!ok) failed++;
  console.log(`${ok ? '  OK' : '  XX'}  ${group}: ${name} — want ${want}, got ${got}${reasonHas ? ` (${reasonHas})` : ''}`);
}
const TYPE_DENY = '레포 유형 · 차단';
const TYPE_MERGE_MSG = '사람이 웹에서 병합한다';
const RECEIPT_MSG = '최종 점검';
let typeCaseCount = 0;
const T = (...a) => { typeCaseCount++; typeCase(...a); };
// S1: 유형 판정은 병합 거부로 드러난다. 갈래는 repo-merge 만 연 상태다.
T('유형 판정', '선언 없음은 work', 'deny', null, 'Bash', { command: TYPE_MERGE }, { marker: 'repo-merge', reasonHas: TYPE_MERGE_MSG });
T('유형 판정', 'work', 'deny', '{"type": "work"}', 'Bash', { command: TYPE_MERGE }, { marker: 'repo-merge', reasonHas: TYPE_MERGE_MSG });
T('유형 판정', 'principle', 'deny', '{"type": "principle"}', 'Bash', { command: TYPE_MERGE }, { marker: 'repo-merge', reasonHas: TYPE_MERGE_MSG });
T('유형 판정', 'storage 는 기존 흐름(통과 기록 없음)', 'deny', '{"type": "storage"}', 'Bash', { command: TYPE_MERGE }, { marker: 'repo-merge', reasonHas: RECEIPT_MSG });
T('유형 판정', '잘못된 JSON 은 work', 'deny', '{type: storage', 'Bash', { command: TYPE_MERGE }, { marker: 'repo-merge', reasonHas: TYPE_MERGE_MSG });
T('유형 판정', '모르는 값은 work', 'deny', '{"type": "team"}', 'Bash', { command: TYPE_MERGE }, { marker: 'repo-merge', reasonHas: TYPE_MERGE_MSG });
T('유형 판정', 'type 키 없음은 work', 'deny', '{}', 'Bash', { command: TYPE_MERGE }, { marker: 'repo-merge', reasonHas: TYPE_MERGE_MSG });
// S2: 편집 차단
const TYPE_PATH = '/x/repo/.ops-agent/repo-type.json';
T('유형 편집', 'Write', 'deny', null, 'Write', { file_path: TYPE_PATH, content: '{}' }, { marker: null, reasonHas: '사람이 한다' });
T('유형 편집', 'Edit', 'deny', null, 'Edit', { file_path: TYPE_PATH, old_string: 'a', new_string: 'b' }, { marker: null, reasonHas: '사람이 한다' });
T('유형 편집', 'MultiEdit', 'deny', null, 'MultiEdit', { file_path: TYPE_PATH, edits: [] }, { marker: null, reasonHas: '사람이 한다' });
T('유형 편집', 'NotebookEdit', 'deny', null, 'NotebookEdit', { notebook_path: TYPE_PATH }, { marker: null, reasonHas: '사람이 한다' });
T('유형 편집', '다른 .ops-agent 파일은 통과', 'pass', null, 'Write', { file_path: '/x/repo/.ops-agent/confidential.json', content: '{}' }, { marker: null });
T('유형 편집', '이름만 비슷한 파일은 통과', 'pass', null, 'Write', { file_path: '/x/repo/docs/repo-type.json', content: '{}' }, { marker: null });
const BASH_DENY = [
  ['리다이렉트', `echo '{"type":"storage"}' > .ops-agent/repo-type.json`],
  ['추가 리다이렉트', `echo x >> .ops-agent/repo-type.json`],
  ['따옴표 리다이렉트 대상', `echo x > ".ops-agent/repo-type.json"`],
  ['tee', `echo x | tee .ops-agent/repo-type.json`],
  ['sed -i', `sed -i 's/work/storage/' .ops-agent/repo-type.json`],
  ['cp 대상', `cp /tmp/a.json .ops-agent/repo-type.json`],
  ['mv', `mv /tmp/a.json .ops-agent/repo-type.json`],
  ['ln 대상', `ln -s /tmp/a.json .ops-agent/repo-type.json`],
  ['rm', `rm .ops-agent/repo-type.json`],
  ['체인 안의 쓰기', `mkdir -p .ops-agent && echo x > .ops-agent/repo-type.json`],
];
for (const [name, command] of BASH_DENY) T('유형 편집', `Bash ${name}`, 'deny', null, 'Bash', { command }, { marker: null, reasonHas: '사람이 한다' });
const BASH_PASS = [
  ['cat', 'cat .ops-agent/repo-type.json'],
  ['grep', 'grep type .ops-agent/repo-type.json'],
  ['jq', 'jq .type .ops-agent/repo-type.json'],
  ['sed 읽기', 'sed -n 1p .ops-agent/repo-type.json'],
  ['cp 원본', 'cp .ops-agent/repo-type.json /tmp/backup.json'],
  ['읽은 뒤 다른 파일에 쓰기', 'cat .ops-agent/repo-type.json > /tmp/out.json'],
];
for (const [name, command] of BASH_PASS) T('유형 편집', `Bash ${name}`, 'pass', null, 'Bash', { command }, { marker: null });
// S3: 병합 거부. 갈래를 all 로 열어도 work · principle 은 거부하고, 대상이 로컬이 아니면 work 로 본다.
T('병합 거부', 'work, 전체 개방에서도', 'deny', '{"type": "work"}', 'Bash', { command: TYPE_MERGE }, { marker: 'all', reasonHas: TYPE_MERGE_MSG });
T('병합 거부', 'principle, 전체 개방에서도', 'deny', '{"type": "principle"}', 'Bash', { command: TYPE_MERGE }, { marker: 'all', reasonHas: TYPE_MERGE_MSG });
T('병합 거부', 'work, 갈래 닫힘도 유형 메시지', 'deny', '{"type": "work"}', 'Bash', { command: TYPE_MERGE }, { marker: null, reasonHas: TYPE_MERGE_MSG });
T('병합 거부', 'storage 는 갈래 닫힘이면 기존 갈래 메시지', 'deny', '{"type": "storage"}', 'Bash', { command: TYPE_MERGE }, { marker: null, reasonHas: '한시 권한' });
T('병합 거부', 'storage -R 지정은 work 취급', 'deny', '{"type": "storage"}', 'Bash', { command: 'gh pr merge 7 -R o/r --merge' }, { marker: 'all', reasonHas: TYPE_MERGE_MSG });
T('병합 거부', 'storage --repo 지정은 work 취급', 'deny', '{"type": "storage"}', 'Bash', { command: 'gh pr merge 7 --repo o/r --merge' }, { marker: 'all', reasonHas: TYPE_MERGE_MSG });
T('병합 거부', 'work 가 아닌 명령은 영향 없음', 'pass', '{"type": "work"}', 'Bash', { command: 'git status' }, { marker: 'all' });
// S4: 개방 스크립트 경고. 개방은 막지 않는다.
function allowCase(name, decl, scopes, wantWarn) {
  const ctx = typeRepo(decl);
  const res = spawnSync('bash', [join(here, 'action-gate-allow.sh'), 'on', scopes], {
    cwd: ctx.repo, encoding: 'utf8', env: { ...process.env, HOME: ctx.home },
  });
  const warned = (res.stderr || '').includes('병합이 거부된다');
  const opened = existsSync(join(ctx.home, '.claude', 'ops-agent', '.cache', 'action-gate-allow.json'));
  rmSync(ctx.home, { recursive: true, force: true });
  const ok = res.status === 0 && opened && warned === wantWarn;
  if (!ok) failed++;
  typeCaseCount++;
  console.log(`${ok ? '  OK' : '  XX'}  개방 경고: ${name} — ${warned ? '경고' : '경고 없음'}${opened ? ', 개방됨' : ', 개방 안 됨'}`);
}
allowCase('선언 없음 + repo-merge', null, 'repo-merge', true);
allowCase('work + all', '{"type": "work"}', 'all', true);
allowCase('principle + repo-merge', '{"type": "principle"}', 'repo-merge,git-force', true);
allowCase('storage + repo-merge', '{"type": "storage"}', 'repo-merge', false);
allowCase('work 이어도 병합 갈래 아님', '{"type": "work"}', 'cluster-write', false);

// 최종 점검 통과 뒤 끝 안내 (ADR-0029). 함수만 불러 쓴다(FINAL_CHECK_LIB=1). gh 를 부르지 않는다.
// 저장소 유형만 gh pr merge 를 안내하고, 그 밖은 웹 병합 + 보고 첨부다. 통과 기록 경로는 유형과 무관하게 나온다.
const FC = join(here, 'final-check.sh');
const FC_HEAD = 'a'.repeat(40);
function guidanceCase(type, wantMerge) {
  const res = spawnSync('bash', ['-c', 'set -euo pipefail; FINAL_CHECK_LIB=1 . "$1"; pass_guidance "$2" 7 "$3" /r/x.json', 'selftest', FC, type, FC_HEAD], { encoding: 'utf8' });
  const out = res.stdout || '';
  const hasMerge = out.includes(`gh pr merge 7 --merge --match-head-commit ${FC_HEAD}`);
  const hasWeb = out.includes('병합은 웹에서 사람이 한다');
  const ok = res.status === 0 && out.includes('통과 기록: /r/x.json') && hasMerge === wantMerge && hasWeb === !wantMerge;
  if (!ok) failed++;
  typeCaseCount++;
  console.log(`${ok ? '  OK' : '  XX'}  끝 안내: ${type} — ${hasMerge ? 'gh pr merge' : ''}${hasWeb ? '웹 병합' : ''}${res.status ? ` · exit ${res.status}` : ''}`);
}
guidanceCase('storage', true);
guidanceCase('work', false);
guidanceCase('principle', false);
// 미해결 리뷰 스레드 (#1130). 실패로 세지 않고 목록만 안내한다. 조회 실패만 실패 b 다. 함수만 불러 쓴다(FINAL_CHECK_LIB=1).
function threadCase(name, rc, threads, wantStatus, wantLines) {
  const res = spawnSync('bash', ['-c', 'set -uo pipefail; FINAL_CHECK_LIB=1 . "$1"; thread_notice "$2" "$3"', 'selftest', FC, String(rc), threads], { encoding: 'utf8' });
  const lines = (res.stdout || '').split('\n').filter(Boolean);
  const ok = res.status === wantStatus && JSON.stringify(lines) === JSON.stringify(wantLines);
  if (!ok) failed++;
  typeCaseCount++;
  console.log(`${ok ? '  OK' : '  XX'}  리뷰 스레드: ${name} — exit ${res.status}, ${lines.length}줄`);
}
threadCase('미해결 2건은 안내만', 0, 'a.java:1 (x)\nb.java:- (y)', 0, ['안내 b: 미해결 리뷰 스레드 2건. 실패로 세지 않는다. 상황 보고에 아래 목록을 싣는다', '  - a.java:1 (x)', '  - b.java:- (y)']);
threadCase('미해결 0건은 조용히 통과', 0, '', 0, []);
threadCase('조회 실패는 실패', 1, '', 1, []);
// 주장 검증 기록 (#772 · #810). 리뷰 준비 주장 검증을 건너뛴 노트를 통과시키지 않는다. 함수만 불러 쓴다(FINAL_CHECK_LIB=1).
const reviewDir = mkdtempSync(join(tmpdir(), 'final-check-review-'));
function reviewCase(name, notes, wantPass, reasonHas = '') {
  const file = join(reviewDir, `${typeCaseCount}.md`);
  writeFileSync(file, notes);
  const res = spawnSync('bash', ['-c', 'set -uo pipefail; FINAL_CHECK_LIB=1 . "$1"; claim_check_failure "$2"', 'selftest', FC, file], { encoding: 'utf8' });
  const out = (res.stdout || '').trim();
  const ok = res.status === 0 && (wantPass ? out === '' : out !== '' && out.includes(reasonHas));
  if (!ok) failed++;
  typeCaseCount++;
  console.log(`${ok ? '  OK' : '  XX'}  주장 검증: ${name} — ${out || '통과'}`);
}
reviewCase('2회 만에 차단 0건', '## 주장 검증\n\n- 1회: 차단 2건 · 권장 3건 · 사소 1건 · 못 본 행 1\n- 2회: 차단 0건 · 권장 1건 · 사소 2건 · 못 본 행 0\n', true);
reviewCase('가이드 형식(HEAD 접미)', '## 주장 검증\n- 1회: 차단 1건 · 권장 2건 · 사소 0건 (HEAD 1a2b3c4)\n- 2회: 차단 0건 · 권장 0건 · 사소 1건 · 못 본 행 0 (HEAD 5d6e7f8)\n', true);
reviewCase('1회 차단 0건', '## 주장 검증\n- 1회: 차단 0건 · 권장 0건 · 사소 0건 · 못 본 행 0\n', true);
// 못 본 행 (#1184). 시간 상한 안의 대조라 보지 못한 행이 남을 수 있고, 남은 회차는 차단 0건이어도 통과가 아니다
reviewCase('못 본 행이 남은 회차', '## 주장 검증\n- 1회: 차단 0건 · 권장 0건 · 사소 0건 · 못 본 행 2\n', false, '못 본 행이 남은 회차는 통과로 적지 않는다');
reviewCase('못 본 행 수 누락', '## 주장 검증\n- 1회: 차단 0건 · 권장 0건 · 사소 0건\n', false, '못 본 행 수가 없다');
reviewCase('못 본 행은 마지막 회차만 본다', '## 주장 검증\n- 1회: 차단 1건 · 못 본 행 3\n- 2회: 차단 0건 · 못 본 행 0\n', true);
reviewCase('앞 회차에만 못 본 행 수가 있다', '## 주장 검증\n- 1회: 차단 1건 · 못 본 행 0\n- 2회: 차단 0건\n', false, '못 본 행 수가 없다');
reviewCase('들여쓴 회차 줄', '## 주장 검증\n  - 1회: 차단 0건 · 권장 2건 · 못 본 행 0\n', true);
reviewCase('절 없음', '## 교정\n해당 없음\n', false, '회차 줄');
reviewCase('해당 없음 한 줄', '## 주장 검증\n해당 없음\n', false, '회차 줄');
reviewCase('다른 절의 회차 줄', '## 교정\n- 1회: 차단 0건\n\n## 주장 검증\n했다\n', false, '회차 줄');
reviewCase('글자 수가 같은 다른 한글 절', '## 설계 반영\n- 1회: 차단 0건\n\n## 주장 검증\n했다\n', false, '회차 줄');
// 회차 상한 2회 (#1184). 리뷰 준비와 머지 준비를 합친 수다
reviewCase('3회 만에 차단 0건은 상한 초과', '## 주장 검증\n- 1회: 차단 2건\n- 2회: 차단 1건\n- 3회: 차단 0건 · 권장 1건 · 못 본 행 0\n', false, '상한 2회');
reviewCase('9회 기록은 상한 초과', '## 주장 검증\n' + Array.from({ length: 9 }, (_, i) => `- ${i + 1}회: 차단 ${i === 8 ? 0 : 1}건 · 못 본 행 0\n`).join(''), false, '그 주장을 떼거나 PR 을 쪼갠다');
reviewCase('형식이 다른 회차 줄: 다른 제목의 절에 3회째', '## 주장 검증\n- 1회: 차단 1건\n- 2회: 차단 1건\n\n## 주장 검증 (머지 준비)\n- 3회: 차단 0건\n', false, '형식이 다른 회차 줄');
reviewCase('형식이 다른 회차 줄: 다른 제목의 절에서 1회부터', '## 주장 검증\n- 1회: 차단 1건\n- 2회: 차단 0건 · 못 본 행 0\n\n## 머지 준비 주장 검증\n- 1회: 차단 0건\n', false, '형식이 다른 회차 줄');
reviewCase('형식이 다른 회차 줄: 「N회차:」', '## 주장 검증\n- 1회: 차단 1건\n- 2회: 차단 1건\n- 3회차: 차단 0건\n', false, '형식이 다른 회차 줄');
reviewCase('형식이 다른 회차 줄: 콜론 앞 공백', '## 주장 검증\n- 1회: 차단 1건\n- 2회: 차단 1건\n- 3회 : 차단 0건\n', false, '형식이 다른 회차 줄');
reviewCase('형식이 다른 회차 줄: 글머리 없음', '## 주장 검증\n- 1회: 차단 1건\n- 2회: 차단 1건\n3회: 차단 0건\n', false, '형식이 다른 회차 줄');
reviewCase('형식이 다른 회차 줄: 굵게', '## 주장 검증\n- 1회: 차단 1건\n- 2회: 차단 1건\n- **3회**: 차단 0건\n', false, '형식이 다른 회차 줄');
reviewCase('형식이 다른 회차 줄: 번호 목록', '## 주장 검증\n- 1회: 차단 1건\n- 2회: 차단 1건\n3. 3회: 차단 0건\n', false, '형식이 다른 회차 줄');
reviewCase('형식이 다른 회차 줄: 전각 콜론', '## 주장 검증\n- 1회: 차단 1건\n- 2회: 차단 1건\n- 3회： 차단 0건\n', false, '형식이 다른 회차 줄');
reviewCase('형식이 다른 회차 줄: 「+」 글머리', '## 주장 검증\n- 1회: 차단 1건\n- 2회: 차단 1건\n+ 3회: 차단 0건\n', false, '형식이 다른 회차 줄');
reviewCase('형식이 다른 회차 줄: 인용', '## 주장 검증\n- 1회: 차단 1건\n- 2회: 차단 1건\n> - 3회: 차단 0건\n', false, '형식이 다른 회차 줄');
reviewCase('회차 아닌 줄의 「N회째」는 형식 검사 밖', '## 주장 검증\n- 1회: 차단 0건 · 못 본 행 0\n- 미결: 4회째가 필요한 경우 → 사용자 결정 대기\n', true);
// 줄 머리의 장식을 걷고 숫자(전각 포함) + 회 · 차 · 번째로 시작하는 줄은 회차로 읽힌다. 정해진 형식이 아니면 실패다(주장 검증 1회차 반례)
{
  const base = '## 주장 검증\n- 1회: 차단 1건\n- 2회: 차단 0건 · 못 본 행 0\n';
  for (const [kind, extra] of [
    ['붙임표', '- 3회 - 차단 0건\n'],
    ['콜론 없음', '- 3회 차단 0건\n'],
    ['「N회차」 콜론 없음', '- 3회차 차단 0건\n'],
    ['「N회째:」', '- 3회째: 차단 0건\n'],
    ['괄호 꼬리', '- 3회(머지 준비): 차단 0건\n'],
    ['마침표', '- 3회. 차단 0건\n'],
    ['닫는 괄호', '- 3회) 차단 0건\n'],
    ['코드', '- `3회`: 차단 0건\n'],
    ['기울임', '- _3회_: 차단 0건\n'],
    ['전각 숫자', '- ３회: 차단 0건\n'],
    ['하위 제목 「### 주장 검증 (머지 준비)」', '\n### 주장 검증 (머지 준비)\n- 3회: 차단 0건\n'],
    ['띄어쓰기 없는 「## 주장검증 머지」', '\n## 주장검증 머지\n- 3회: 차단 0건\n'],
    ['표', '\n| 회차 | 차단 |\n|---|---|\n| 3회 | 0건 |\n'],
    ['「N차:」', '- 3차: 차단 0건\n'],
    ['「N번째:」', '- 3번째: 차단 0건\n'],
  ]) reviewCase(`형식이 다른 회차 줄: ${kind}`, base + extra, false, '형식이 다른 회차 줄');
  // 줄 머리가 회차가 아닌 줄은 검사 밖이다
  for (const [kind, extra] of [
    ['경로에 「N회:」', '- 이슈 본문: /tmp/issue-3회: 메모.md\n'],
    ['설명 문장', '지난 PR 은 9회: 까지 갔다\n'],
    ['미결 줄', '- 미결: 4회째가 필요한 경우 → 사용자 결정 대기\n'],
  ]) reviewCase(`형식 검사 밖: ${kind}`, base + extra, true);
}
reviewCase('마지막 회차 차단 남음', '## 주장 검증\n- 1회: 차단 3건 · 권장 1건\n- 2회: 차단 1건 · 권장 0건\n', false, '0건이 아니면');
reviewCase('2회 채우고도 차단 남음', '## 주장 검증\n- 1회: 차단 3건\n- 2회: 차단 2건 · 못 본 행 0\n', false, '0건이 아니면');
reviewCase('차단이 줄지 않음은 사람 판단', '## 주장 검증\n- 1회: 차단 1건\n- 2회: 차단 1건\n', false, '사람 판단');
reviewCase('차단이 늘어도 사람 판단', '## 주장 검증\n- 1회: 차단 1건\n- 2회: 차단 2건\n', false, '사람 판단');
reviewCase('0건 뒤 차단은 멈춤이 아니다', '## 주장 검증\n- 1회: 차단 0건\n- 2회: 차단 1건\n', false, '마지막 회차(2회)');
reviewCase('차단 건수 없는 옛 형식', '## 주장 검증\n- 1회: 지적 0건\n', false, '차단 건수가 없다');
reviewCase('회차 건너뜀', '## 주장 검증\n- 1회: 차단 2건\n- 3회: 차단 0건\n', false, '이어지지 않는다');
reviewCase('첫 어긋난 줄을 가리킨다', '## 주장 검증\n- 2회: 차단 1건\n- 3회: 차단 0건\n', false, '1번째 줄이 2회');
// 주장 검증 입력 (#928). 「빠진 행」은 이슈 원문을 받아야 검출력이 있다. 노트에 원문 파일 경로가 있고 그 파일이 비어 있지 않아야 한다.
const issueRaw = join(reviewDir, 'issue-raw.md');
writeFileSync(issueRaw, '## Todo\n- [ ] 남은 항목\n');
const issueEmpty = join(reviewDir, 'issue-empty.md');
writeFileSync(issueEmpty, '');
function inputCase(name, notes, wantPass, reasonHas = '') {
  const file = join(reviewDir, `input-${typeCaseCount}.md`);
  writeFileSync(file, notes);
  const res = spawnSync('bash', ['-c', 'set -uo pipefail; FINAL_CHECK_LIB=1 . "$1"; claim_input_failure "$2"', 'selftest', FC, file], { encoding: 'utf8' });
  const out = (res.stdout || '').trim();
  const ok = res.status === 0 && (wantPass ? out === '' : out !== '' && out.includes(reasonHas));
  if (!ok) failed++;
  typeCaseCount++;
  console.log(`${ok ? '  OK' : '  XX'}  주장 검증 입력: ${name} — ${out || '통과'}`);
}
inputCase('원문 파일 경로', `## 주장 검증\n- 이슈 본문: ${issueRaw}\n- 1회: 차단 0건\n`, true);
inputCase('이슈 없는 PR 은 사유와 함께', '## 주장 검증\n- 이슈 본문: 없음 — 이슈 없는 문서 정정\n- 1회: 차단 0건\n', true);
inputCase('경로 줄 없음', '## 주장 검증\n- 1회: 차단 0건\n', false, '이슈 본문');
inputCase('다른 절의 경로 줄', `## 교정\n- 이슈 본문: ${issueRaw}\n\n## 주장 검증\n- 1회: 차단 0건\n`, false, '이슈 본문');
inputCase('없는 파일', '## 주장 검증\n- 이슈 본문: /nonexistent/issue.md\n', false, '없다');
inputCase('빈 파일', `## 주장 검증\n- 이슈 본문: ${issueEmpty}\n`, false, '비어');
inputCase('사유 없는 없음', '## 주장 검증\n- 이슈 본문: 없음\n', false, '사유');
// 커밋 정리 (ADR-0039, #1013). 세션 묶음 PR 은 이슈마다 커밋 하나다. 이슈 번호는 제목 줄에서만 읽는다.
function commitCase(name, msgs, wantPass, reasonHas = '') {
  const res = spawnSync('bash', ['-c', 'set -uo pipefail; FINAL_CHECK_LIB=1 . "$1"; commit_issue_failure', 'selftest', FC], { encoding: 'utf8', input: msgs.map((m) => `${m}\x1e`).join('') });
  const out = (res.stdout || '').trim();
  const ok = res.status === 0 && (wantPass ? out === '' : out !== '' && out.includes(reasonHas));
  if (!ok) failed++;
  typeCaseCount++;
  console.log(`${ok ? '  OK' : '  XX'}  커밋 정리: ${name} — ${out || '통과'}`);
}
commitCase('이슈마다 커밋 하나', ['docs: 원칙 추가 (#1002)\n\n본문', 'feat: 측정 (#1000)'], true);
commitCase('한 커밋이 이슈 둘', ['docs: 원칙과 용어 (#1002 · #1004)'], true);
commitCase('본문의 다른 이슈 언급은 세지 않는다', ['docs: 원칙 추가 (#1002)\n\n기존 기록: #775', 'feat: 측정 (#775)'], true);
commitCase('같은 이슈의 교정 커밋', ['docs: 원칙 추가 (#1002)', 'docs: 문구 교정 (#1002)'], false, '#1002');
commitCase('커밋 하나는 이슈 번호 없이도 통과 (트래커 링크를 본문에 두는 레포)', ['feat: 기능 추가\nhttps://tracker.example/tasks/1'], true);
commitCase('여럿 중 제목에 이슈 번호 없음', ['docs: 원칙 추가 (#1002)', 'docs: 용어\n\nCloses #1004'], false, '이슈 번호가 없다');
commitCase('커밋 없음', [], false, '커밋이 없다');
{
  // 진입점 배선. 커밋 수 1개 규칙이 남아 있으면 세션 묶음 PR 이 막힌다.
  const src = readFileSync(FC, 'utf8');
  const ok = src.includes('commit_failure=$(printf \'%s\' "$commit_msgs" | commit_issue_failure)') && src.includes('fail g "$commit_failure') && !src.includes('1개로 스쿼시한다');
  if (!ok) failed++;
  typeCaseCount++;
  console.log(`${ok ? '  OK' : '  XX'}  커밋 정리: 진입점이 g 를 이슈 기준으로 판정한다 — ${ok ? '배선 있음' : '배선 없음'}`);
}
{
  // 진입점 배선. 함수만 부르는 위 케이스는 본 경로에서 h 를 부르지 않아도 통과하므로 소스로 확인한다.
  const src = readFileSync(FC, 'utf8');
  const ok = (src.match(/LC_ALL=C awk/g) || []).length >= 2 && src.includes('review_failure=$(claim_check_failure "$NOTES")') && src.includes('fail h "주장 검증: $review_failure"') && src.includes('fail h "주장 검증: 노트 파일이 없다"') && src.includes('input_failure=$(claim_input_failure "$NOTES")') && src.includes('fail h "주장 검증 입력: $input_failure"');
  if (!ok) failed++;
  typeCaseCount++;
  console.log(`${ok ? '  OK' : '  XX'}  주장 검증: 진입점이 h 를 판정한다 — ${ok ? '배선 있음' : '배선 없음'}`);
}
rmSync(reviewDir, { recursive: true, force: true });
{
  // 실제 진입점. PR 댓글 옵션은 없어졌으므로 거부되고(gh 호출 전 종료), 스크립트에 댓글 게시 호출이 없다.
  const res = spawnSync('bash', [FC, '7', '--notes', '/dev/null', '--no-comment'], { encoding: 'utf8' });
  const src = readFileSync(FC, 'utf8');
  const ok = res.status === 2 && (res.stderr || '').includes('알 수 없는 옵션') && !src.includes('gh pr comment');
  if (!ok) failed++;
  typeCaseCount++;
  console.log(`${ok ? '  OK' : '  XX'}  끝 안내: PR 댓글 게시 없음 — --no-comment exit ${res.status}, 소스에 gh pr comment ${src.includes('gh pr comment') ? '있음' : '없음'}`);
}

// 이슈 생성 가드 (#696). 직접 호출은 거부하고 어댑터(gh-issue.sh)는 통과한다. 어댑터 호출의 제목 · 본문 파일은
// 대외비 가드가 직접 호출과 같이 본다. 키워드 · 사내 호스트는 임시 설정으로 주입한다 (사용자 로컬 설정에 기대지 않는다).
const issueHome = mkdtempSync(join(tmpdir(), 'issue-guard-selftest-'));
const issueCfg = join(issueHome, 'confidential.json');
writeFileSync(issueCfg, JSON.stringify({
  externalOnly: { keywords: ['SELFTEST_INTERNAL_WORD'] },
  personalDevOnly: { keywords: ['SELFTEST_HOME_WORD'] },
  internalHosts: ['ghe.selftest.internal'],
}));
const bodyOf = (name, text) => { const p = join(issueHome, name); writeFileSync(p, text); return p; };
const cleanBody = bodyOf('clean.md', '## What\n한 줄\n\n## Why\n- 사실 1\n- 사실 2\n- 기존 기록: 없음 · docs\n');
const internalWordBody = bodyOf('internal-word.md', '## What\nSELFTEST_INTERNAL_WORD 를 다룬다\n\n## Why\n- 사실 1\n- 사실 2\n- 기존 기록: 없음 · docs\n');
const homeWordBody = bodyOf('home-word.md', '## What\nSELFTEST_HOME_WORD 를 다룬다\n\n## Why\n- 사실 1\n- 사실 2\n- 기존 기록: 없음 · docs\n');
const ADAPTER = 'bash ~/.claude/ops-agent/current/scripts/gh-issue.sh';
const ISSUE_DENY = '이슈 생성 가드';
function issueCase(name, want, command, { env = {}, reasonHas = '', label = '이슈 생성 가드', cwd = storageRepo } = {}) {
  const res = spawnSync('node', [hook], {
    input: JSON.stringify({ tool_name: 'Bash', cwd, session_id: 'selftest', tool_input: { command } }),
    encoding: 'utf8',
    env: { ...process.env, HOME: issueHome, // 지표가 사용자 HOME 에 시험 줄을 남기지 않게 한다 (#1236)
      OPS_AGENT_ACTION_GATE_ALLOW: '1', OPS_AGENT_FINAL_CHECK_DISABLE: '1', OPS_AGENT_CONFIDENTIAL_CONFIG_PATH: issueCfg, ...env },
  });
  let got = 'pass';
  let reason = '';
  try {
    const d = JSON.parse((res.stdout || '').trim());
    const hs = d.hookSpecificOutput;
    if (hs && hs.permissionDecision === 'deny') { got = 'deny'; reason = hs.permissionDecisionReason; }
    else if (d.systemMessage) { got = 'error'; reason = d.systemMessage; }
  } catch { /* 출력 없음 = 통과 */ }
  const ok = got === want && (!reasonHas || reason.includes(reasonHas));
  if (!ok) failed++;
  console.log(`${ok ? '  OK' : '  XX'}  ${label}: ${name} — want ${want}, got ${got}${reason ? ` · ${reason.split('\n')[0]}` : ''}`);
}
const ISSUE_CASES = [
  ['gh issue create 직접 호출', 'deny', 'gh issue create --title "x" --body "y"', { reasonHas: ISSUE_DENY }],
  ['gh api -X POST …/issues', 'deny', 'gh api -X POST repos/o/r/issues -f title=x', { reasonHas: ISSUE_DENY }],
  ['gh api …/issues -f (메서드 생략은 POST)', 'deny', 'gh api repos/o/r/issues -f title=x -f body=y', { reasonHas: ISSUE_DENY }],
  ['gh api …/issues --input', 'deny', 'gh api repos/o/r/issues --input body.json', { reasonHas: ISSUE_DENY }],
  ['gh api …/issues 조회', 'pass', 'gh api repos/o/r/issues?state=open --jq ".[].number"'],
  ['gh api …/issues -X GET', 'pass', 'gh api -X GET repos/o/r/issues -f state=open'],
  ['gh api …/issues/1/comments 는 코멘트', 'pass', 'gh api repos/o/r/issues/1/comments -f body=x'],
  ['gh api …/issues/1/labels 는 라벨', 'pass', 'gh api repos/o/r/issues/1/labels -f "labels[]=feat"'],
  ['gh api graphql createIssue', 'deny', `gh api graphql -f query='mutation { createIssue(input: {repositoryId: "x", title: "t"}) { issue { number } } }'`, { reasonHas: ISSUE_DENY }],
  ['gh api graphql 조회', 'pass', `gh api graphql -f query='query { repository(owner: "o", name: "r") { issues(first: 1) { nodes { number } } } }'`],
  ['어댑터 호출', 'pass', `${ADAPTER} create --title "x" --body-file ${cleanBody} --type feat --no-start "후속"`],
  ['어댑터 뒤에 붙인 직접 호출', 'deny', `${ADAPTER} create --title "x" --body-file ${cleanBody} --type feat --start; gh issue create --title y --body z`, { reasonHas: ISSUE_DENY }],
  ['경로 언급만 하는 검색', 'pass', "grep -n 'gh issue create' skills/flow/guides/issue.md"],
  ['문구 echo', 'pass', "echo 'gh issue create --title x'"],
  ['드라이런은 통과', 'pass', 'gh issue create --title "x" --body "y"', { env: { OPS_AGENT_ISSUE_CREATE_GUARD_DRYRUN: '1' } }],
  ['비활성은 통과', 'pass', 'gh issue create --title "x" --body "y"', { env: { OPS_AGENT_ISSUE_CREATE_GUARD_DISABLE: '1' } }],
  // 어댑터 호출의 본문 파일에 대외비 가드가 적용된다. cwd 에 origin 리모트가 없어 표면은 public 이다.
  ['어댑터 본문의 대외비 키워드', 'deny', `${ADAPTER} create --title "x" --body-file ${internalWordBody} --type feat --start`, { reasonHas: '대외비 가드' }],
  // -R 의 사내 호스트로 internal 표면이 잡힌다. 개인 환경 흔적은 막고, 사내 용어는 통과한다.
  ['어댑터 -R 사내 호스트 + 개인 환경 흔적', 'deny', `${ADAPTER} create --title "x" --body-file ${homeWordBody} --type feat -R ghe.selftest.internal/o/r --start`, { reasonHas: '사내 공유 표면 쓰기에서 개인 환경 흔적 히트' }],
  ['어댑터 -R 사내 호스트 + 사내 용어', 'pass', `${ADAPTER} create --title "x" --body-file ${internalWordBody} --type feat -R ghe.selftest.internal/o/r --start`],
];
for (const [name, want, command, opts] of ISSUE_CASES) issueCase(name, want, command, opts);

// 도구 경계 조치 한 줄 (#1035). 어댑터 생성은 통과하면서 로드맵 알림을 붙이고, 시작 · 직접 호출 거부 문구에도 같은 줄이 있다.
function issueNotice(command) {
  const res = spawnSync('node', [hook], {
    input: JSON.stringify({ tool_name: 'Bash', cwd: storageRepo, session_id: 'selftest', tool_input: { command } }),
    encoding: 'utf8',
    env: { ...process.env, OPS_AGENT_ACTION_GATE_ALLOW: '1', OPS_AGENT_FINAL_CHECK_DISABLE: '1', OPS_AGENT_CONFIDENTIAL_CONFIG_PATH: issueCfg },
  });
  try {
    const hs = JSON.parse((res.stdout || '').trim()).hookSpecificOutput || {};
    return { deny: hs.permissionDecision === 'deny', text: hs.additionalContext || hs.permissionDecisionReason || '' };
  } catch { return { deny: false, text: '' }; }
}
for (const [name, command, wantDeny, wantNotice] of [
  ['어댑터 생성은 통과 + 로드맵 알림', `${ADAPTER} create --title "x" --body-file ${cleanBody} --type feat --no-start "후속"`, false, true],
  ['어댑터 시작은 알림 없음', `${ADAPTER} start 12 --worktree`, false, false],
  ['직접 호출 거부 문구에 로드맵 알림', 'gh issue create --title "x" --body "y"', true, true],
]) {
  const r = issueNotice(command);
  const ok = r.deny === wantDeny && r.text.includes('로드맵 이슈') === wantNotice;
  if (!ok) failed++;
  console.log(`${ok ? '  OK' : '  XX'}  이슈 생성 로드맵 알림: ${name} — deny ${r.deny}, 알림 ${r.text.includes('로드맵 이슈')}`);
}

// 초안 PR 가드 (#876). 초안 플래그 없는 PR 생성은 거부한다. 훅 호출 방식이 같아 issueCase 로 돌린다. 플로우 진입 가드는 끈다.
const PR_DRAFT_DENY = '초안 PR 가드';
const PR_GUIDE = 'guides/pr.md';
const PR_DRAFT_CASES = [
  ['초안 플래그 없음 · 가이드로 보낸다', 'deny', 'gh pr create --base develop --title "x" --body-file b.md', { reasonHas: PR_GUIDE }],
  ['-fd 결합', 'pass', 'gh pr create -fd --base main'],
  ['create 앞 -R', 'deny', 'gh pr -R o/r create --title "x" --body "y"', { reasonHas: PR_DRAFT_DENY }],
  ['create 앞 -R + --draft', 'pass', 'gh pr -R o/r create --draft --title "x" --body "y"'],
  ['env 접두', 'deny', 'env GH_HOST=ghe.selftest.internal gh pr create --title "x" --body "y"', { reasonHas: PR_DRAFT_DENY }],
  ['--draft', 'pass', 'gh pr create --draft --base develop --title "x" --body-file b.md'],
  ['-d', 'pass', 'gh pr create -d --base main --title "x" --body "y"'],
  ['--draft=true', 'pass', 'gh pr create --draft=true --title "x" --body "y"'],
  ['제목에만 --draft', 'deny', 'gh pr create --title "add --draft flag" --body "y"', { reasonHas: PR_DRAFT_DENY }],
  ['환경 변수 접두', 'deny', 'GH_HOST=ghe.selftest.internal gh pr create --title "x" --body "y"', { reasonHas: PR_DRAFT_DENY }],
  ['뒤에 붙인 생성', 'deny', 'git push -u origin fix/1 && gh pr create --title "x" --body "y"', { reasonHas: PR_DRAFT_DENY }],
  ['준비 완료 전환 · 가이드로 보낸다', 'deny', 'gh pr ready 12', { reasonHas: '초안 상태 그대로' }],
  ['전환 앞 -R', 'deny', 'gh pr -R o/r ready 12', { reasonHas: PR_DRAFT_DENY }],
  ['뒤에 붙인 전환', 'deny', 'git push && gh pr ready 12', { reasonHas: PR_DRAFT_DENY }],
  ['GraphQL 전환', 'deny', "gh api graphql -f query='mutation { markPullRequestReadyForReview(input:{pullRequestId:\"x\"}) { clientMutationId } }'", { reasonHas: PR_DRAFT_DENY }],
  ['초안으로 되돌림은 통과', 'pass', 'gh pr ready 12 --undo'],
  ['전환 문구 검색은 통과', 'pass', "grep -n 'gh pr ready' skills/flow/guides/pr.md"],
  ['전환 드라이런은 통과', 'pass', 'gh pr ready 12', { env: { OPS_AGENT_PR_DRAFT_GUARD_DRYRUN: '1' } }],
  ['문구 검색', 'pass', "grep -n 'gh pr create' skills/flow/guides/pr.md"],
  ['드라이런은 통과', 'pass', 'gh pr create --title "x" --body "y"', { env: { OPS_AGENT_PR_DRAFT_GUARD_DRYRUN: '1' } }],
  ['비활성은 통과', 'pass', 'gh pr create --title "x" --body "y"', { env: { OPS_AGENT_PR_DRAFT_GUARD_DISABLE: '1' } }],
  // 드래프트 생략 선언 (#1166): 선언한 레포만 통과, 다른 레포 지정 · GraphQL 전환은 기본값(차단)
  ['생략 선언 레포 · 드래프트 없는 생성', 'pass', 'gh pr create --title "x" --body "y"', { cwd: skipDraftRepo }],
  ['생략 선언 레포 · 준비 완료 전환', 'pass', 'gh pr ready 12', { cwd: skipDraftRepo }],
  ['cd 로 생략 레포에 들어가 생성은 기본값', 'deny', `cd ${skipDraftRepo} && gh pr create --title "x" --body "y"`, { reasonHas: PR_DRAFT_DENY }],
  ['생략 선언 레포 · cd 로 다른 곳에 나가 생성', 'deny', 'cd /tmp && gh pr create --title "x" --body "y"', { cwd: skipDraftRepo, reasonHas: PR_DRAFT_DENY }],
  ['생략 선언 레포 · pushd', 'deny', 'pushd /tmp && gh pr create --title "x" --body "y"', { cwd: skipDraftRepo, reasonHas: PR_DRAFT_DENY }],
  ['생략 선언 레포 · git -C', 'deny', 'git -C /tmp status && gh pr create --title "x" --body "y"', { cwd: skipDraftRepo, reasonHas: PR_DRAFT_DENY }],
  ['생략 선언 레포 · GH_REPO', 'deny', 'GH_REPO=o/r gh pr create --title "x" --body "y"', { cwd: skipDraftRepo, reasonHas: PR_DRAFT_DENY }],
  ['생략 선언 레포 · export GH_REPO', 'deny', 'export GH_REPO=o/r; gh pr create --title "x" --body "y"', { cwd: skipDraftRepo, reasonHas: PR_DRAFT_DENY }],
  ['생략 선언 레포 · env GH_HOST', 'deny', 'env GH_HOST=h gh pr ready 12', { cwd: skipDraftRepo, reasonHas: PR_DRAFT_DENY }],
  ['생략 선언 레포 · 붙여 쓴 -R', 'deny', 'gh pr create -Ro/r --title "x" --body "y"', { cwd: skipDraftRepo, reasonHas: PR_DRAFT_DENY }],
  ['생략 선언 레포 · --repo=', 'deny', 'gh pr ready --repo=o/r 12', { cwd: skipDraftRepo, reasonHas: PR_DRAFT_DENY }],
  ['생략 선언 레포 · URL 인자 전환', 'deny', 'gh pr ready https://github.com/o/r/pull/12', { cwd: skipDraftRepo, reasonHas: PR_DRAFT_DENY }],
  ['생략 선언 레포 · 알려진 옵션 생성', 'pass', 'gh pr create --base main --title "a -R b" --body-file b.md --fill', { cwd: skipDraftRepo }],
  ['생략 선언 레포 · --title= 형태', 'pass', 'gh pr create --title=x --body y', { cwd: skipDraftRepo }],
  ['생략 선언 레포 · 역슬래시 cd', 'deny', '\\cd /tmp && gh pr create --title "x" --body "y"', { cwd: skipDraftRepo, reasonHas: PR_DRAFT_DENY }],
  ['생략 선언 레포 · 따옴표 cd', 'deny', '"cd" /tmp && gh pr create --title "x" --body "y"', { cwd: skipDraftRepo, reasonHas: PR_DRAFT_DENY }],
  ['생략 선언 레포 · 따옴표 -R', 'deny', 'gh pr create "-R" o/r --title "x" --body "y"', { cwd: skipDraftRepo, reasonHas: PR_DRAFT_DENY }],
  ['생략 선언 레포 · 묶음 -fR', 'deny', 'gh pr create -fR o/r', { cwd: skipDraftRepo, reasonHas: PR_DRAFT_DENY }],
  ['생략 선언 레포 · 쪼갠 --repo', 'deny', 'gh pr create --re""po o/r --title "x"', { cwd: skipDraftRepo, reasonHas: PR_DRAFT_DENY }],
  ['생략 선언 레포 · GIT_DIR', 'deny', 'GIT_DIR=/tmp/x/.git gh pr create --title "x" --body "y"', { cwd: skipDraftRepo, reasonHas: PR_DRAFT_DENY }],
  ['생략 선언 레포 · 쪼갠 GH_REPO', 'deny', 'export "GH_""REPO=o/r"; gh pr create --title "x"', { cwd: skipDraftRepo, reasonHas: PR_DRAFT_DENY }],
  ['생략 선언 레포 · 따옴표 안 명령 치환', 'deny', 'gh pr create --title "$(gh repo set-default o/r)" --body y', { cwd: skipDraftRepo, reasonHas: PR_DRAFT_DENY }],
  ['생략 선언 레포 · 변수 인자', 'deny', 'gh pr create $A o/r --title "x"', { cwd: skipDraftRepo, reasonHas: PR_DRAFT_DENY }],
  ['생략 선언 레포 · gh repo set-default 뒤', 'deny', 'gh repo set-default o/r; gh pr create --title "x"', { cwd: skipDraftRepo, reasonHas: PR_DRAFT_DENY }],
  ['생략 선언 레포 · -R 다른 레포 지정', 'deny', 'gh pr -R o/r create --title "x" --body "y"', { cwd: skipDraftRepo, reasonHas: PR_DRAFT_DENY }],
  ['생략 선언 레포 · GraphQL 전환', 'deny', "gh api graphql -f query='mutation { markPullRequestReadyForReview(input:{pullRequestId:\"x\"}) { clientMutationId } }'", { cwd: skipDraftRepo, reasonHas: PR_DRAFT_DENY }],
  ['선언 없는 레포에서 생략 레포로 cd 없이 생성', 'deny', 'gh pr create --title "x" --body "y"', { reasonHas: PR_DRAFT_DENY }],
];
for (const [name, want, command, opts] of PR_DRAFT_CASES) issueCase(name, want, command, { ...opts, label: PR_DRAFT_DENY, env: { OPS_AGENT_FLOW_ENTRY_DISABLE: '1', ...(opts?.env || {}) } });

// 드래프트 생략 선언 레포의 드래프트 생성은 통과하되 기록 · 안내한다 (#1178). 임시 HOME 의 지표 파일로 본다.
{
  const DRAFT_METRIC_CASES = [
    // [이름, cwd, 명령, 기록 기대, form 기대]
    ['선언 레포 · 단독 드래프트 생성', skipDraftRepo, 'gh pr create --draft --title "x" --body "y"', true, 'standalone'],
    ['선언 레포 · cd 로 묶은 드래프트 생성', storageRepo, `cd ${skipDraftRepo} && git status && gh pr create --draft --title "x" --body "y"`, true, 'compound'],
    ['선언 없는 레포 · 드래프트 생성은 기록 안 함', storageRepo, 'gh pr create --draft --title "x" --body "y"', false, ''],
    ['선언 레포 · 드래프트 없는 단독 생성은 기록 안 함', skipDraftRepo, 'gh pr create --title "x" --body "y"', false, ''],
  ];
  for (const [name, cwd, command, wantRec, wantForm] of DRAFT_METRIC_CASES) {
    const home = mkdtempSync(join(tmpdir(), 'draft-metric-home-'));
    const res = spawnSync('node', [hook], {
      input: JSON.stringify({ tool_name: 'Bash', cwd, session_id: 'selftest', tool_input: { command } }),
      encoding: 'utf8',
      env: { ...process.env, HOME: home, OPS_AGENT_ACTION_GATE_ALLOW: '1', OPS_AGENT_FINAL_CHECK_DISABLE: '1', OPS_AGENT_FLOW_ENTRY_DISABLE: '1', OPS_AGENT_CONFIDENTIAL_CONFIG_PATH: issueCfg },
    });
    const file = join(home, '.claude', 'ops-agent', 'metrics', 'draft-in-skip-repo.jsonl');
    let rows = [];
    try { rows = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { rows = []; }
    let ctx = '';
    let denied = false;
    try {
      const hs = JSON.parse((res.stdout || '').trim()).hookSpecificOutput || {};
      ctx = hs.additionalContext || '';
      denied = hs.permissionDecision === 'deny';
    } catch { /* 출력 없음 */ }
    const recOk = wantRec ? rows.length === 1 && rows[0].form === wantForm : rows.length === 0;
    const noticeOk = wantRec ? ctx.includes('드래프트 생략(skip-draft)을 선언') : !ctx.includes('드래프트 생략(skip-draft)을 선언');
    const ok = !denied && recOk && noticeOk;
    if (!ok) failed++;
    console.log(`${ok ? '  OK' : '  XX'}  드래프트 지표: ${name} — 기록 ${rows.length}건${rows[0] ? `(${rows[0].form})` : ''} · 안내 ${ctx ? '있음' : '없음'}${denied ? ' · 차단됨' : ''}`);
    rmSync(home, { recursive: true, force: true });
  }
}

// 세션당 PR 수 지표 (#1236). 같은 세션 · 같은 레포의 두 번째 생성부터 nth >= 2 로 남는다.
// 워크트리(.git 파일)는 디렉토리 이름이 달라도 본 레포 이름으로 센다. 막지 않는다.
{
  const home = mkdtempSync(join(tmpdir(), 'session-pr-home-'));
  const main = mkdtempSync(join(tmpdir(), 'session-pr-main-'));
  mkdirSync(join(main, '.git', 'worktrees', 'wt-a'), { recursive: true });
  mkdirSync(join(main, '.ops-agent'));
  writeFileSync(join(main, '.ops-agent', 'repo-type.json'), '{"type": "storage", "allow": ["skip-draft"]}');
  const wt = mkdtempSync(join(tmpdir(), 'session-pr-wt-'));
  writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt-a')}\n`);
  mkdirSync(join(wt, '.ops-agent'));
  writeFileSync(join(wt, '.ops-agent', 'repo-type.json'), '{"type": "storage", "allow": ["skip-draft"]}');
  const runPr = (cwd, session, command = 'gh pr create --title "x" --body "y"') => spawnSync('node', [hook], {
    input: JSON.stringify({ tool_name: 'Bash', cwd, session_id: session, tool_input: { command } }),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, OPS_AGENT_ACTION_GATE_ALLOW: '1', OPS_AGENT_FINAL_CHECK_DISABLE: '1', OPS_AGENT_FLOW_ENTRY_DISABLE: '1', OPS_AGENT_CONFIDENTIAL_CONFIG_PATH: issueCfg },
  });
  const r1 = runPr(main, 's1');
  runPr(wt, 's1');
  runPr(main, 's2');
  runPr(main, 's1', 'gh pr view 1');
  const file = join(home, '.claude', 'ops-agent', 'metrics', 'session-pr.jsonl');
  let rows = [];
  try { rows = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { rows = []; }
  let denied = false;
  try { denied = JSON.parse((r1.stdout || '').trim()).hookSpecificOutput?.permissionDecision === 'deny'; } catch { /* 출력 없음 */ }
  const repo = basename(main);
  const SESSION_PR_CASES = [
    ['첫 생성은 nth 1 이고 막지 않는다', !denied && rows[0]?.nth === 1 && rows[0]?.repo === repo],
    ['같은 세션 · 워크트리의 생성은 같은 레포의 nth 2', rows[1]?.nth === 2 && rows[1]?.repo === repo && rows[1]?.session === 's1'],
    ['다른 세션은 nth 1 부터', rows[2]?.nth === 1 && rows[2]?.session === 's2'],
    ['PR 생성이 아닌 명령은 기록하지 않는다', rows.length === 3],
  ];
  for (const [name, ok] of SESSION_PR_CASES) {
    if (!ok) failed++;
    console.log(`${ok ? '  OK' : '  XX'}  세션당 PR 지표: ${name}${ok ? '' : ` — ${JSON.stringify(rows)}`}`);
  }
  for (const d of [home, main, wt]) rmSync(d, { recursive: true, force: true });
}

// 한자 섞임 가드 (#1107). 커밋 메시지 · PR 제목 · 본문 · 코멘트에 한글과 붙은 한자가 있으면 거부한다.
// 커밋 대상 파일 · 이슈 · 공개 표면이 아닌 명령은 보지 않는다. 플로우 진입 가드는 끈다.
const HAN_DENY = '한자 섞임 가드';
const hanBody = bodyOf('han.md', '## 요약\n- 남은 일은 외部 대기\n');
const HAN_CASES = [
  ['커밋 메시지 -m', 'deny', 'git commit -m "fix: 외部 연동"', { reasonHas: HAN_DENY }],
  ['커밋 메시지 heredoc (-F -)', 'deny', "git commit -q -F - <<'EOF'\nfix: 남은 일은 외部 대기\nEOF", { reasonHas: HAN_DENY }],
  ['커밋 메시지 $(cat <<EOF) (-m)', 'deny', `git commit -m "$(cat <<'EOF'\nfix: 部분 완료\nEOF\n)"`, { reasonHas: HAN_DENY }],
  ['PR 본문 --body', 'deny', 'gh pr create --draft --title "x" --body "남은 일은 外部대기"', { reasonHas: HAN_DENY }],
  ['PR 제목 --title', 'deny', 'gh pr create --draft --title "外部연동" --body "y"', { reasonHas: HAN_DENY }],
  ['PR 본문 파일 --body-file', 'deny', `gh pr edit 3 --body-file ${hanBody}`, { reasonHas: HAN_DENY }],
  ['PR 코멘트', 'deny', 'gh pr comment 3 --body "部분 완료"', { reasonHas: HAN_DENY }],
  ['섞임 없는 커밋은 통과', 'pass', 'git commit -m "fix: 외부 연동"'],
  ['띄어 쓴 한자 낱말은 통과', 'pass', 'git commit -m "docs: 회의 메모 部長 참석"'],
  ['공개 표면 쓰기가 아닌 명령은 통과', 'pass', "cat > note.md <<'EOF'\n남은 일은 외部 대기\nEOF"],
  // 커밋은 단독 호출만 받으므로(#1161 커밋 모양 게이트) 엮는 쓰기 명령으로 PR 코멘트를 쓴다
  ['표준 입력 본문이 아니면 heredoc 은 보지 않는다', 'pass', "gh pr comment 3 --body \"y\" && cat > note.md <<'EOF'\n외部\nEOF"],
  ['이슈 코멘트는 범위 밖', 'pass', 'gh issue comment 3 --body "部분 완료"'],
  ['비활성은 통과', 'pass', 'git commit -m "fix: 외部 연동"', { env: { OPS_AGENT_HAN_GUARD_DISABLE: '1' } }],
];
for (const [name, want, command, opts] of HAN_CASES) issueCase(name, want, command, { ...opts, label: HAN_DENY, env: { OPS_AGENT_FLOW_ENTRY_DISABLE: '1', ...(opts?.env || {}) } });

// 글 판정 가드 (#1112). 트래커 · PR 본문이 문서 규칙의 확정 항목(L9 불릿 안 머리말 · PN8 · PN9)에 걸리면 거부한다.
// 고친 본문 · 형식이 정한 키(기존 기록) · 제목 · 본문 쓰기가 아닌 명령은 통과한다. 플로우 진입 가드는 끈다.
const LINT_DENY = '글 판정 가드';
const labelBody = bodyOf('label.md', '## 결과\n\n- 확인: 스테이징에서 재현되지 않는다\n- 원인: 캐시 만료가 짧다\n');
const fixedBody = bodyOf('fixed.md', '## 결과\n\n### 확인\n\n- 스테이징에서 재현되지 않는다\n\n### 원인\n\n- 캐시 만료가 짧다\n');
const recordBody = bodyOf('record.md', '## Why\n\n- 기존 기록: 없음 · 찾은 자리\n- 배경 사실 하나\n');
const LINT_CASES = [
  ['이슈 본문 갱신 --body-file', 'deny', `gh issue edit 3 --body-file ${labelBody}`, { reasonHas: LINT_DENY }],
  ['이슈 코멘트 --body', 'deny', 'gh issue comment 3 --body "- 확인: 재현 안 됨\n- 원인: 캐시"', { reasonHas: '[L9]' }],
  ['PR 본문 -F', 'deny', `gh pr create --draft --title "x" -F ${labelBody}`, { reasonHas: LINT_DENY }],
  ['PR 코멘트 heredoc (--body-file -)', 'deny', "gh pr comment 3 --body-file - <<'EOF'\n- 영향: 없음\nEOF", { reasonHas: LINT_DENY }],
  ['차단 안내에 판단 재료 점검', 'deny', `gh pr edit 3 --body-file ${labelBody}`, { reasonHas: 'tech-comm TC5 · TC6' }],
  ['PN8 물결표 취소선', 'deny', 'gh pr comment 3 --body "범위 1~2 와 3~4"', { reasonHas: '[PN8]' }],
  ['PN9 정정 취소선', 'deny', 'gh issue comment 3 --body "~~사용률이 0 이다~~ (정정: 옛 컬럼)"', { reasonHas: '[PN9]' }],
  ['고친 본문은 통과', 'pass', `gh issue edit 3 --body-file ${fixedBody}`],
  ['형식이 정한 키(기존 기록)는 통과', 'pass', `gh issue edit 3 --body-file ${recordBody}`],
  ['제목은 보지 않는다', 'pass', 'gh pr edit 3 --title "원인: 캐시"'],
  ['본문 쓰기가 아닌 명령은 통과', 'pass', `cat ${labelBody}`],
  ['비활성은 통과', 'pass', `gh issue edit 3 --body-file ${labelBody}`, { env: { OPS_AGENT_BODY_LINT_DISABLE: '1' } }],
];
for (const [name, want, command, opts] of LINT_CASES) issueCase(name, want, command, { ...opts, label: LINT_DENY, env: { OPS_AGENT_FLOW_ENTRY_DISABLE: '1', ...(opts?.env || {}) } });
rmSync(issueHome, { recursive: true, force: true });
rmSync(storageRepo, { recursive: true, force: true });

// 하네스 허용 규칙 형태 대조 (#1082). 임시 HOME 에 사용자 설정을 두고, 갈래(git-force)를 연 상태에서
// 규칙과 글자 형태가 다른 강제 푸시는 훅이 막고 규칙 형태 단독 실행은 통과하는지 본다.
const SHAPE_DENY = '형태 불일치';
const SHAPE_RULES = { permissions: { allow: ['Bash(git push --force-with-lease *)'] } };
const SHAPE_CASES = [
  ['규칙 형태 단독은 통과', 'pass', 'git push --force-with-lease origin feature/x', SHAPE_RULES],
  ['옵션 선행', 'deny', 'git push -q --force-with-lease origin feature/x', SHAPE_RULES],
  ['= 결합', 'deny', 'git push --force-with-lease=feature/x:abc123 origin feature/x', SHAPE_RULES],
  ['옵션 선행 + 파이프 (처음 막힌 형태)', 'deny', 'git push -q --force-with-lease=feature/x:abc origin feature/x 2>&1 | tail -3', SHAPE_RULES],
  ['cd 뒤 규칙 형태는 통과', 'pass', 'cd /tmp && git push --force-with-lease origin feature/x', SHAPE_RULES],
  ['규칙이 없는 환경은 종전대로 통과', 'pass', 'git push -q --force-with-lease origin feature/x', null],
  // 2회차 반례: 같은 명령 경로의 다른 행위는 대조하지 않는다 · 더 넓은 규칙이 맞으면 통과
  ['강제 푸시 규칙만 있으면 원격 브랜치 삭제는 대조하지 않음', 'pass', 'git push --delete origin feature/x', SHAPE_RULES],
  ['더 넓은 규칙이 맞으면 통과', 'pass', 'git push -q --force-with-lease origin feature/x', { permissions: { allow: ['Bash(*)', 'Bash(git push --force-with-lease *)'] } }],
  // 주장 검증 차단 반례: 같은 도구의 읽기 규칙만 있으면 쓰기 명령은 대조하지 않는다 (종전대로 통과)
  ['gh release 읽기 규칙만 있으면 create 는 대조하지 않음', 'pass', 'gh release create v1', { permissions: { allow: ['Bash(gh release view:*)', 'Bash(gh release list *)'] } }, 'repo-release'],
  ['git 읽기 규칙만 있으면 reset 은 대조하지 않음', 'pass', 'git reset --hard HEAD~1', { permissions: { allow: ['Bash(git status)', 'Bash(git diff *)'] } }, 'worktree-destructive'],
  ['규칙 머리 옵션이 없는 다른 행위는 대조하지 않음 (gh release)', 'pass', 'gh release create v1', { permissions: { allow: ['Bash(gh release create --draft *)'] } }, 'repo-release'],
  ['규칙 머리 옵션이 있는데 형태 다름은 차단 (gh release)', 'deny', 'gh release create -q --draft v1', { permissions: { allow: ['Bash(gh release create --draft *)'] } }, 'repo-release'],
  ['다른 도구 규칙만 있으면 대조하지 않음', 'pass', 'git push -q --force-with-lease origin feature/x', { permissions: { allow: ['Bash(gh pr merge *)'] } }],
];
for (const [name, want, command, settings, scope = 'git-force'] of SHAPE_CASES) {
  const ctx = typeRepo(null);
  mkdirSync(join(ctx.home, '.claude'), { recursive: true });
  if (settings) writeFileSync(join(ctx.home, '.claude', 'settings.json'), JSON.stringify(settings));
  const { got, reason } = runHook(ctx, 'Bash', { command }, scope);
  rmSync(ctx.home, { recursive: true, force: true });
  const ok = got === want && (want === 'pass' || reason.includes(SHAPE_DENY));
  if (!ok) failed++;
  console.log(`${ok ? '  OK' : '  XX'}  허용 규칙 형태: ${name} — want ${want}, got ${got}${got === 'deny' && !reason.includes(SHAPE_DENY) ? ` (${reason.split('\n')[0]})` : ''}`);
}

// 가드 해제 대입 차단 (#1142). 명령이 부르는 스크립트가 스스로 읽는 해제 변수는 명령 앞 대입으로 꺼진다.
// 막는 형태와 막지 않는 형태(따옴표 안 · heredoc 본문 · 주석 · 이름 언급 · 인자 자리)를 실제 훅에 넣어 본다.
// 판정 범위의 원천은 docs/action-gate.md 「가드 해제 대입 차단」.
const ASSIGN_DENY = '[ops-agent 가드 해제 대입 · 차단]';
const ASSIGN_CASES = [
  ['명령 머리 대입', 'deny', 'OPS_AGENT_BODY_LINT_DISABLE=1 bash scripts/gh-issue.sh create --title t'],
  ['접두가 다른 해제 변수', 'deny', 'TOOLKIT_SAMPLE_WRITE_GATE_DISABLE=1 node adapter.mjs'],
  ['다른 대입 뒤의 해제 대입', 'deny', 'FOO=1 OPS_AGENT_HAN_GUARD_DISABLE=1 node x.mjs'],
  ['값을 따옴표로 감싼 대입', 'deny', 'OPS_AGENT_HAN_GUARD_DISABLE="1" node x.mjs'],
  ['; 뒤', 'deny', 'cd /tmp; X_DISABLE=1 bash a.sh'],
  ['&& 뒤', 'deny', 'true && X_DISABLE=1 bash a.sh'],
  ['|| 뒤', 'deny', 'false || X_DISABLE=1 bash a.sh'],
  ['| 뒤', 'deny', 'echo y | X_DISABLE=1 bash a.sh'],
  ['서브셸 ( 뒤', 'deny', '(X_DISABLE=1 bash a.sh)'],
  ['명령 치환 $( 뒤', 'deny', 'out=$(X_DISABLE=1 bash a.sh)'],
  ['줄바꿈 뒤', 'deny', 'git status\nX_DISABLE=1 bash a.sh'],
  ['명령 없는 대입 (set -a 뒤)', 'deny', 'set -a; X_DISABLE=1; bash a.sh'],
  ['예약어 then 뒤', 'deny', 'if true; then X_DISABLE=1 bash a.sh; fi'],
  ['env 대입', 'deny', 'env X_DISABLE=1 bash a.sh'],
  ['env 옵션 · 다른 대입 뒤', 'deny', 'env -u FOO A=1 X_DISABLE=1 bash a.sh'],
  ['경로를 붙인 env', 'deny', '/usr/bin/env X_DISABLE=1 bash a.sh'],
  ['export 대입', 'deny', 'export X_DISABLE=1 && bash a.sh'],
  ['export 여러 대입 중 하나', 'deny', 'export FOO=1 X_DISABLE=1'],
  ['declare -x 대입', 'deny', 'declare -x X_DISABLE=1; bash a.sh'],
  ['typeset -x 대입', 'deny', 'typeset -x X_DISABLE=1; bash a.sh'],
  ['닫힌 따옴표 뒤 실제 대입', 'deny', "echo 'x'; X_DISABLE=1 bash a.sh"],
  ['heredoc 뒤 실제 대입', 'deny', "cat <<'EOF' > /dev/null\nnote\nEOF\nX_DISABLE=1 bash a.sh"],
  ['이 판정의 해제 변수도 대입은 차단', 'deny', 'OPS_AGENT_DISABLE_ASSIGN_GUARD_DISABLE=1 bash a.sh'],
  ['큰따옴표 안 문자열 grep', 'pass', 'grep -n "_DISABLE=1" scripts/pre-tool-use.mjs'],
  ['작은따옴표 안 문자열 echo', 'pass', "echo 'X_DISABLE=1'"],
  ['작은따옴표 안 대입 모양', 'pass', "echo 'a; X_DISABLE=1 bash a.sh'"],
  ['큰따옴표 안 대입 모양', 'pass', 'echo "a; X_DISABLE=1 bash a.sh"'],
  ['변수 이름만 언급한 조회', 'pass', 'grep -rn OPS_AGENT_HAN_GUARD_DISABLE docs'],
  ['명령 인자 자리의 NAME=값', 'pass', 'echo X_DISABLE=1'],
  ['heredoc 본문', 'pass', "cat <<'EOF' > /dev/null\nX_DISABLE=1 bash a.sh\nEOF"],
  ['주석', 'pass', 'git status # ; X_DISABLE=1 bash a.sh'],
  ['_DISABLE 로 끝나지 않는 이름', 'pass', 'X_DISABLED=1 X_DISABLE_LOG=1 bash a.sh'],
  ['드라이런 대입은 범위 밖', 'pass', 'OPS_AGENT_ACTION_GATE_DRYRUN=1 bash a.sh'],
  ['env 의 다른 대입', 'pass', 'env FOO=1 bash a.sh'],
  ['export 조회', 'pass', 'export -p | grep _DISABLE'],
  ['세션 환경에서 끄면 통과', 'pass', 'X_DISABLE=1 bash a.sh', { OPS_AGENT_DISABLE_ASSIGN_GUARD_DISABLE: '1' }],
];
const assignHome = mkdtempSync(join(tmpdir(), 'assign-selftest-'));
for (const [name, want, command, env = {}] of ASSIGN_CASES) {
  const res = spawnSync('node', [hook], {
    input: JSON.stringify({ tool_name: 'Bash', cwd: assignHome, session_id: 'selftest', tool_input: { command } }),
    encoding: 'utf8',
    env: { ...process.env, HOME: assignHome, OPS_AGENT_DISABLE_ASSIGN_GUARD_DISABLE: '', ...env },
  });
  let got = 'pass';
  let reason = '';
  try {
    const hs = JSON.parse((res.stdout || '').trim()).hookSpecificOutput;
    if (hs && hs.permissionDecision === 'deny') { got = 'deny'; reason = hs.permissionDecisionReason; }
  } catch { /* 출력 없음 = 통과 */ }
  const ok = got === want && (want === 'pass' || reason.startsWith(ASSIGN_DENY));
  if (!ok) failed++;
  console.log(`${ok ? '  OK' : '  XX'}  가드 해제 대입: ${name} — want ${want}, got ${got}${reason ? ` · ${reason.split('\n')[0]}` : ''}`);
}
rmSync(assignHome, { recursive: true, force: true });

console.log(failed ? `\n실패 ${failed}건` : `\n${CASES.length + SCOPE_CASES.length + TTL_CASES.length + SCOPE_GATE_CASES.length + RECEIPT_CASES.length + typeCaseCount + ISSUE_CASES.length + PR_DRAFT_CASES.length + HAN_CASES.length + LINT_CASES.length + SHAPE_CASES.length + ASSIGN_CASES.length}건 전부 통과`);
process.exit(failed ? 1 : 0);
