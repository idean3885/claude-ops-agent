#!/usr/bin/env node
/**
 * selftest-confidential-commit.mjs — 대외비 가드의 커밋 diff 검사 자체 점검.
 *
 * `pre-tool-use.mjs` 를 고쳤으면 이것을 돌린다. 대외비 커밋 검사가 main 의 동작보다 약해지지 않는지 본다.
 * 검사가 꺼지거나 diff 가 비면 대외비가 든 커밋이 신호 없이 통과한다(검사를 통째로 꺼도 다른 자체 점검은 실패하지 않았다).
 *
 * 임시 HOME · 실제 git 레포에서 훅을 실행한다. 키워드는 이 점검만의 값이고 사용자 설정을 읽지 않는다.
 *
 * 사용: node scripts/selftest-confidential-commit.mjs
 * 종료 코드: 실패 1, 전부 통과 0
 */
import { spawnSync, execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const hook = join(dirname(fileURLToPath(import.meta.url)), 'pre-tool-use.mjs');
const WORD = 'SELFTEST_COMMIT_SECRET';
let failed = 0;
let passed = 0;

// 키워드가 놓인 자리: staged(스테이징된 새 파일) · tracked(추적 파일의 미스테이징 변경) · untracked(추적 안 하는 새 파일) · none
// big: 무해한 큰 스테이징분(150KB) + 추적 파일의 미스테이징 변경(키워드)
function repoWith(where) {
  const home = mkdtempSync(join(tmpdir(), 'conf-commit-'));
  const repo = join(home, 'work', 'my-repo');
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(home, '.claude', 'ops-agent'), { recursive: true });
  writeFileSync(join(home, '.claude', 'ops-agent', 'confidential-keywords.local.json'), JSON.stringify({ keywords: [WORD] }));
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  writeFileSync(join(repo, 'seed.txt'), 'seed\n');
  writeFileSync(join(repo, 'b.txt'), 'b\n');
  writeFileSync(join(repo, 'list.txt'), 'b.txt\n');
  git('add', '.');
  git('commit', '-q', '-m', 'seed');
  if (where === 'staged') { writeFileSync(join(repo, 'leak.txt'), `${WORD}\n`); git('add', 'leak.txt'); }
  if (where === 'tracked') writeFileSync(join(repo, 'seed.txt'), `seed\n${WORD}\n`);
  if (where === 'untracked') writeFileSync(join(repo, 'new.txt'), `${WORD}\n`);
  if (where === 'big') {
    const line = 'lorem ipsum dolor sit amet consectetur adipiscing elit\n';
    writeFileSync(join(repo, 'a-big.txt'), line.repeat(Math.ceil(150 * 1024 / line.length)));
    git('add', 'a-big.txt');
    writeFileSync(join(repo, 'seed.txt'), `seed\n${WORD}\n`);
  }
  return { home, repo };
}

function decide(where, command) {
  const { home, repo } = repoWith(where);
  try {
    const r = spawnSync('node', [hook], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, session_id: 's', cwd: repo }),
      encoding: 'utf8', cwd: home,
      env: {
        ...process.env, HOME: home,
        OPS_AGENT_CONFIDENTIAL_DISABLE: '', OPS_AGENT_WHAT_GUARD_DISABLE: '1', OPS_AGENT_ACTION_GATE_DISABLE: '1',
        OPS_AGENT_FINAL_CHECK_DISABLE: '1', OPS_AGENT_FLOW_ENTRY_DISABLE: '1', OPS_AGENT_EXPERT_ROUTE_DISABLE: '1',
        OPS_AGENT_HAN_GUARD_DISABLE: '1',
      },
    });
    return /"permissionDecision"\s*:\s*"deny"/.test(r.stdout || '') && (r.stdout || '').includes('대외비') ? 'deny' : 'pass';
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function expect(where, command, want, why) {
  const got = decide(where, command);
  if (got === want) { passed++; console.log(`ok   [${where}] ${want} ${JSON.stringify(command)}`); return; }
  failed++;
  console.log(`FAIL [${where}] ${JSON.stringify(command)} — 기대 ${want}, 받은 값 ${got}${why ? ` (${why})` : ''}`);
}

// ─── 스테이징된 대외비: 커밋 명령 모양과 무관하게 막는다 ───
// 커밋 대상을 명령 글자로 좁히는 해석이 들어오면 이 모양들에서 범위가 엉뚱한 경로가 되어 통과한다(#1155 주장 검증 반례)
for (const command of [
  'git commit -m x',
  'git commit -m x 2>&1',
  'git commit -m x 2>&1 | tail -3',
  'git commit -m x > /dev/null',
  "git commit -q -F - <<'EOF'\nfix: x\nEOF",
  "git commit -m \"$(cat <<'EOF'\nfix: the \"quoted\" word\nEOF\n)\"",
  "git commit -m \"$(cat <<'EOF'\nfix: it's fine\nEOF\n)\"",
  "git commit -m $'a b'",
  'git commit -m x b.txt --include',
  'git commit --pathspec-from-file=list.txt -m x',
  'git commit --author "A <a@example.com>" -m x',
  'git commit -m x -- 2>&1',
  'git commit -m x &>/dev/null',
  'git commit -m x < /dev/null',
  'git commit -m "a" -m "b"',
  'git commit -m "say \\"hi\\""',
  'git -c core.hooksPath=/dev/null commit -m x',
  'git commit -m x; echo done',
  'git commit --message="fix two words"',
  'git commit -m"fix two words"',
  "git commit -m 'x' --author=\"A B <a@example.com>\"",
  'git commit -m x b.txt',
  'git commit -m "unclosed',
]) expect('staged', command, 'deny');

// ─── 추적 파일의 미스테이징 변경: -a 커밋은 막는다 ───
expect('tracked', 'git commit -am x', 'deny', '-a');
expect('tracked', 'git commit -m x && git commit -a -m y', 'deny', '뒤 커밋의 -a');
expect('tracked', "git commit -m x; bash -c 'git commit -am y'", 'deny', '셸 안쪽 커밋의 -a');
expect('big', 'git commit -am x', 'deny', '큰 스테이징분이 있어도 추적 파일의 변경까지 검사 한도 안에서 읽는다');
expect('tracked', 'git commit -m x', 'pass', '스테이징분만 담긴다');
expect('tracked', 'git commit -m x b.txt', 'pass', '다른 경로만 담긴다');

// ─── 추적 안 하는 새 파일 ───
expect('untracked', 'git commit -m x', 'pass', '새 파일은 담기지 않는다');

// ─── 대외비 없음 ───
expect('none', 'git commit -am x 2>&1', 'pass');

console.log(failed ? `\n실패 ${failed}건` : `\n${passed}건 전부 통과`);
process.exit(failed ? 1 : 0);
