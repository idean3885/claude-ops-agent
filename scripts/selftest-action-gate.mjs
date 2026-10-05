#!/usr/bin/env node
/**
 * selftest-action-gate.mjs — 한시 권한 판정 자체 점검.
 *
 * `pre-tool-use.mjs` 를 고쳤으면 이것을 돌린다. 게이트는 발동할 때만 존재가 드러나므로,
 * 조용히 무력화되면 아무 신호가 없다. 실제로 판정 스니펫의 종료 코드가 뒤집힌 채 배포된
 * 이력이 있다 (#386).
 *
 * 갈래를 모두 열어(OPS_AGENT_ACTION_GATE_ALLOW=1) 돌린다. 동거 검사는 창이 열린 상태에서만
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

// want: 'pass' = 통과해야 한다, 'deny' = 차단되어야 한다
const CASES = [
  ['gated 행위 단독', 'gh pr merge 386 --merge', 'pass'],
  ['cd 뒤 머지', 'cd /tmp && gh pr merge 386 --merge', 'pass'],
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
// 가려진다 (#414). HOME 을 임시 경로로 돌려 사용자의 열린 창을 건드리지 않는다.
const TTL_CASES = [
  ['갈래를 공백으로 나열', ['on', 'git-force', 'cluster-write'], 1, 'on git-force,cluster-write'],
  ['ttl 이 숫자', ['on', 'git-force', '30'], 0, ''],
  ['ttl 생략', ['on', 'git-force'], 0, ''],
  ['옛 형식 (ttl 만)', ['on', '30'], 0, ''],
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
      cwd: repoRoot,
      session_id: 'selftest',
      tool_input: { command },
    }),
    encoding: 'utf8',
    // 통과 기록 검사는 아래 별도 케이스에서 본다. 여기서는 동거 검사 판정만 보도록 끈다.
    // 세션 범위도 끈다. 켜 두면 실제 HOME 에 범위 캐시가 쓰인다 (#613).
    env: { ...process.env, OPS_AGENT_ACTION_GATE_ALLOW: '1', OPS_AGENT_FINAL_CHECK_DISABLE: '1', OPS_AGENT_SESSION_SCOPE_DISABLE: '1' },
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

// 세션 범위 (#613). 임시 HOME 과 임시 레포 둘로, 처음 쓰기가 범위를 정하고 다른 레포 쓰기가
// 한 번 멈췄다 재시도에 통과하는지 본다. 실제 HOME 의 캐시·지표는 건드리지 않는다.
const scopeHome = mkdtempSync(join(tmpdir(), 'scope-selftest-'));
const mkRepo = name => {
  const dir = join(scopeHome, name);
  mkdirSync(dir);
  spawnSync('git', ['-C', dir, 'init', '-q']);
  return dir;
};
const repoA = mkRepo('repo-a');
const repoB = mkRepo('repo-b');
const plain = join(scopeHome, 'plain');
mkdirSync(plain);
function scopeRun(tool_name, tool_input, cwd = repoA) {
  const res = spawnSync('node', [hook], {
    input: JSON.stringify({ tool_name, cwd, session_id: 'scope-selftest', tool_input }),
    encoding: 'utf8',
    env: { ...process.env, HOME: scopeHome, OPS_AGENT_ACTION_GATE_ALLOW: '1', OPS_AGENT_FINAL_CHECK_DISABLE: '1', OPS_AGENT_SESSION_SCOPE_DISABLE: '' },
  });
  // 실행 실패나 해석 실패는 통과가 아니라 테스트 실패다.
  if (res.error || res.status !== 0) return 'error';
  try {
    const hs = JSON.parse((res.stdout || '').trim()).hookSpecificOutput;
    return hs && hs.permissionDecision === 'deny' ? 'deny' : 'pass';
  } catch { return 'error'; }
}
const SCOPE_RUNS = [
  ['첫 쓰기는 범위를 기록하고 통과', 'pass', 'Write', { file_path: join(repoA, 'a.txt') }],
  ['다른 레포 쓰기는 차단', 'deny', 'Write', { file_path: join(repoB, 'b.txt') }],
  ['같은 행위를 다시 하면 통과', 'pass', 'Write', { file_path: join(repoB, 'b.txt') }],
  ['범위 레포 쓰기는 통과', 'pass', 'Edit', { file_path: join(repoA, 'a.txt') }],
  ['읽기는 통과', 'pass', 'Read', { file_path: join(plain, 'c.txt') }],
  ['git 레포가 아닌 경로는 통과', 'pass', 'Write', { file_path: join(plain, 'p.txt') }],
  ['git 조회는 통과', 'pass', 'Bash', { command: 'git log -1' }, repoB],
  ['전역 -R 이 앞에 오는 gh 쓰기는 차단', 'deny', 'Bash', { command: 'gh -R other/zzz issue create -t x' }, repoA],
];
for (const [name, want, tool, input, cwd] of SCOPE_RUNS) {
  const got = scopeRun(tool, input, cwd);
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? '  OK' : '  XX'}  세션 범위: ${name} — want ${want}, got ${got}`);
}
const metricsFile = join(scopeHome, '.claude', 'ops-agent', 'metrics', 'session-scope.jsonl');
const scopeMetrics = existsSync(metricsFile) ? readFileSync(metricsFile, 'utf8').trim().split('\n').map(l => JSON.parse(l).result) : [];
const metricOk = scopeMetrics.join(',') === 'blocked,ack,blocked';
if (!metricOk) failed++;
console.log(`${metricOk ? '  OK' : '  XX'}  세션 범위: 지표는 blocked · ack · blocked 순 — ${scopeMetrics.join(',') || '없음'}`);
rmSync(scopeHome, { recursive: true, force: true });

console.log(failed ? `\n실패 ${failed}건` : `\n${CASES.length + SCOPE_CASES.length + TTL_CASES.length + RECEIPT_CASES.length + SCOPE_RUNS.length + 1}건 전부 통과`);
process.exit(failed ? 1 : 0);
