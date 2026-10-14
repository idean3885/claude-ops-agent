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
      cwd: repoRoot,
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
// scopes 가 null 이면 마커가 없다(전부 닫힘). 사용자의 열린 창을 건드리지 않는다.
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

console.log(failed ? `\n실패 ${failed}건` : `\n${CASES.length + SCOPE_CASES.length + TTL_CASES.length + SCOPE_GATE_CASES.length + RECEIPT_CASES.length}건 전부 통과`);
process.exit(failed ? 1 : 0);
