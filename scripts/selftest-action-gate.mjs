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
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const hook = join(here, 'pre-tool-use.mjs');
const repoRoot = join(here, '..');

// 레포 유형 선언이 없으면 work 라 `gh pr merge` 가 거부된다 (ADR-0028). 기존 케이스는 갈래 판정을 보는 것이라
// 저장소 유형을 선언한 임시 레포를 cwd 로 쓴다.
const storageRepo = mkdtempSync(join(tmpdir(), 'storage-repo-'));
mkdirSync(join(storageRepo, '.git'));
mkdirSync(join(storageRepo, '.ops-agent'));
writeFileSync(join(storageRepo, '.ops-agent', 'repo-type.json'), '{"type": "storage"}');

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
// 판단 검토 기록 (#772). 제로베이스 검토를 건너뛴 노트를 통과시키지 않는다. 함수만 불러 쓴다(FINAL_CHECK_LIB=1).
const reviewDir = mkdtempSync(join(tmpdir(), 'final-check-review-'));
function reviewCase(name, notes, wantPass, reasonHas = '') {
  const file = join(reviewDir, `${typeCaseCount}.md`);
  writeFileSync(file, notes);
  const res = spawnSync('bash', ['-c', 'set -uo pipefail; FINAL_CHECK_LIB=1 . "$1"; judgment_review_failure "$2"', 'selftest', FC, file], { encoding: 'utf8' });
  const out = (res.stdout || '').trim();
  const ok = res.status === 0 && (wantPass ? out === '' : out !== '' && out.includes(reasonHas));
  if (!ok) failed++;
  typeCaseCount++;
  console.log(`${ok ? '  OK' : '  XX'}  판단 검토: ${name} — ${out || '통과'}`);
}
reviewCase('2회 만에 차단 0건', '## 판단 검토\n\n- 1회: 차단 2건 · 권장 3건 · 사소 1건\n- 2회: 차단 0건 · 권장 1건 · 사소 2건\n', true);
reviewCase('1회 차단 0건', '## 판단 검토\n- 1회: 차단 0건 · 권장 0건 · 사소 0건\n', true);
reviewCase('들여쓴 회차 줄', '## 판단 검토\n  - 1회: 차단 0건 · 권장 2건\n', true);
reviewCase('절 없음', '## 교정\n해당 없음\n', false, '회차 줄');
reviewCase('해당 없음 한 줄', '## 판단 검토\n해당 없음\n', false, '회차 줄');
reviewCase('다른 절의 회차 줄', '## 교정\n- 1회: 차단 0건\n\n## 판단 검토\n했다\n', false, '회차 줄');
reviewCase('마지막 회차 차단 남음', '## 판단 검토\n- 1회: 차단 3건 · 권장 1건\n- 2회: 차단 1건 · 권장 0건\n', false, '0건이 아니면');
reviewCase('3회 채우고도 차단 남음', '## 판단 검토\n- 1회: 차단 3건\n- 2회: 차단 2건\n- 3회: 차단 1건\n', false, '0건이 아니면');
reviewCase('차단이 줄지 않음은 사람 판단', '## 판단 검토\n- 1회: 차단 0건\n- 2회: 차단 1건\n- 3회: 차단 1건\n', false, '사람 판단');
reviewCase('차단이 늘어도 사람 판단', '## 판단 검토\n- 1회: 차단 1건\n- 2회: 차단 2건\n', false, '사람 판단');
reviewCase('0건 뒤 차단은 멈춤이 아니다', '## 판단 검토\n- 1회: 차단 0건\n- 2회: 차단 1건\n', false, '마지막 회차(2회)');
reviewCase('차단 건수 없는 옛 형식', '## 판단 검토\n- 1회: 지적 0건\n', false, '차단 건수가 없다');
reviewCase('회차 상한은 스킬 몫', '## 판단 검토\n- 1회: 차단 3건\n- 2회: 차단 2건\n- 3회: 차단 1건\n- 4회: 차단 0건\n', true);
reviewCase('회차 건너뜀', '## 판단 검토\n- 1회: 차단 2건\n- 3회: 차단 0건\n', false, '이어지지 않는다');
reviewCase('첫 어긋난 줄을 가리킨다', '## 판단 검토\n- 2회: 차단 1건\n- 3회: 차단 0건\n', false, '1번째 줄이 2회');
{
  // 진입점 배선. 함수만 부르는 위 케이스는 본 경로에서 h 를 부르지 않아도 통과하므로 소스로 확인한다.
  const src = readFileSync(FC, 'utf8');
  const ok = src.includes('review_failure=$(judgment_review_failure "$NOTES")') && src.includes('fail h "판단 검토: $review_failure"') && src.includes('fail h "판단 검토: 노트 파일이 없다"');
  if (!ok) failed++;
  typeCaseCount++;
  console.log(`${ok ? '  OK' : '  XX'}  판단 검토: 진입점이 h 를 판정한다 — ${ok ? '배선 있음' : '배선 없음'}`);
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
function issueCase(name, want, command, { env = {}, reasonHas = '' } = {}) {
  const res = spawnSync('node', [hook], {
    input: JSON.stringify({ tool_name: 'Bash', cwd: storageRepo, session_id: 'selftest', tool_input: { command } }),
    encoding: 'utf8',
    env: { ...process.env, OPS_AGENT_ACTION_GATE_ALLOW: '1', OPS_AGENT_FINAL_CHECK_DISABLE: '1', OPS_AGENT_CONFIDENTIAL_CONFIG_PATH: issueCfg, ...env },
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
  console.log(`${ok ? '  OK' : '  XX'}  이슈 생성 가드: ${name} — want ${want}, got ${got}${reason ? ` · ${reason.split('\n')[0]}` : ''}`);
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
rmSync(issueHome, { recursive: true, force: true });
rmSync(storageRepo, { recursive: true, force: true });

console.log(failed ? `\n실패 ${failed}건` : `\n${CASES.length + SCOPE_CASES.length + TTL_CASES.length + SCOPE_GATE_CASES.length + RECEIPT_CASES.length + typeCaseCount + ISSUE_CASES.length}건 전부 통과`);
process.exit(failed ? 1 : 0);
