#!/usr/bin/env node
/**
 * selftest-confidential-commit.mjs — 대외비 가드의 커밋 diff 검사 자체 점검.
 *
 * `pre-tool-use.mjs` 를 고쳤으면 이것을 돌린다. 대외비 커밋 검사가 main 의 동작보다 약해지지 않는지 본다.
 * 검사가 꺼지거나 diff 가 비면 대외비가 든 커밋이 신호 없이 통과한다(검사를 통째로 꺼도 다른 자체 점검은 실패하지 않았다).
 *
 * 임시 HOME · 실제 git 레포에서 훅을 실행한다. 키워드는 이 점검만의 값이고 사용자 설정을 읽지 않는다.
 *
 * 행 = 명령 모양 × 레포 상태. 행마다 기준 커밋(BASE_SHA)의 훅 사본도 돌려 「기준 deny ⇒ 이 훅 deny」를 단언한다(약해지지 않음).
 * 기준은 실행 시점의 origin/main 이 아니라 이 변경이 분기한 커밋으로 고정한다. 그 커밋을 못 읽으면 실패다.
 *
 * 사용: node scripts/selftest-confidential-commit.mjs
 * 종료 코드: 실패 1, 전부 통과 0
 */
import { spawnSync, execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const hook = join(here, 'pre-tool-use.mjs');
const WORD = 'SELFTEST_COMMIT_SECRET';
let failed = 0;
let passed = 0;

// 기준 커밋 사본. 그 커밋의 scripts 를 통째로 풀어 같은 import(옆 모듈)를 쓰게 한다.
// 기준 커밋: #1161 이 분기한 release 9.74.2. origin/main 은 실행 시점마다 달라 비교 대상이 흔들린다.
const BASE_SHA = 'c844c6f1d65f1d77ac0593dc1ea31e27a4845c18';
let baseHook = null;
const baseDir = mkdtempSync(join(tmpdir(), 'conf-commit-base-'));
try {
  const tar = execFileSync('git', ['-C', join(here, '..'), 'archive', BASE_SHA, 'scripts', 'config'], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', baseDir], { input: tar });
  baseHook = join(baseDir, 'scripts', 'pre-tool-use.mjs');
} catch {
  console.log(`FAIL 기준 커밋 ${BASE_SHA} 을 읽지 못해 기준 대비 단언을 할 수 없습니다.`);
  rmSync(baseDir, { recursive: true, force: true });
  process.exit(1);
}

// 키워드가 놓인 자리: staged(스테이징된 새 파일) · tracked(추적 파일의 미스테이징 변경) · untracked(추적 안 하는 새 파일) · none
// big: 무해한 큰 스테이징분(150KB) + 추적 파일의 미스테이징 변경(키워드)
// gh: 공개 여부 조회를 대신하는 가짜 gh. 'slow-public'(1.6초 뒤 PUBLIC) · 'slow-diff'(즉시 PUBLIC, 검사 안 첫 git diff 만 1.1초 지연) · 'private'. 주면 origin 리모트를 단다.
function repoWith(where, gh) {
  const home = mkdtempSync(join(tmpdir(), 'conf-commit-'));
  const repo = join(home, 'work', 'my-repo');
  mkdirSync(join(repo, 'sub'), { recursive: true });
  mkdirSync(join(home, '.claude', 'ops-agent'), { recursive: true });
  writeFileSync(join(home, '.claude', 'ops-agent', 'confidential-keywords.local.json'), JSON.stringify({ keywords: [WORD] }));
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  writeFileSync(join(repo, 'seed.txt'), 'seed\n');
  writeFileSync(join(repo, 'b.txt'), 'b\n');
  writeFileSync(join(repo, 'list.txt'), 'b.txt\n');
  writeFileSync(join(repo, 'sub', 'keep.txt'), 'k\n');
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
  let bin = null;
  if (gh) {
    git('remote', 'add', 'origin', 'https://github.com/selftest-owner/selftest-repo.git');
    bin = join(home, 'bin');
    mkdirSync(bin);
    const out = gh === 'private' ? 'echo PRIVATE' : gh === 'slow-diff' ? 'echo PUBLIC' : 'sleep 1.6; echo PUBLIC';
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\n${out}\n`);
    chmodSync(join(bin, 'gh'), 0o755);
    if (gh === 'slow-diff') {
      const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
      const mark = join(home, 'diff-delayed');
      writeFileSync(join(bin, 'git'), `#!/bin/sh\nfor a in "$@"; do [ "$a" = diff ] && [ ! -e '${mark}' ] && : > '${mark}' && sleep 1.1 && break; done\nexec '${realGit}' "$@"\n`);
      chmodSync(join(bin, 'git'), 0o755);
    }
  }
  return { home, repo, bin };
}

function run(hookPath, where, command, opts) {
  const { home, repo, bin } = repoWith(where, opts.gh);
  try {
    const r = spawnSync('node', [hookPath], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, session_id: 's', cwd: opts.sub ? join(repo, 'sub') : repo }),
      encoding: 'utf8', cwd: home,
      env: {
        ...process.env, HOME: home, PATH: bin ? `${bin}:${process.env.PATH}` : process.env.PATH,
        OPS_AGENT_CONFIDENTIAL_DISABLE: '', OPS_AGENT_CONFIDENTIAL_DRYRUN: '', OPS_AGENT_HOOK_BUDGET_MS: opts.budget ? String(opts.budget) : '',
        OPS_AGENT_WHAT_GUARD_DISABLE: '1', OPS_AGENT_ACTION_GATE_DISABLE: '1',
        OPS_AGENT_FINAL_CHECK_DISABLE: '1', OPS_AGENT_FLOW_ENTRY_DISABLE: '1', OPS_AGENT_EXPERT_ROUTE_DISABLE: '1',
        OPS_AGENT_HAN_GUARD_DISABLE: '1',
      },
    });
    const decision = /"permissionDecision"\s*:\s*"deny"/.test(r.stdout || '') && (r.stdout || '').includes('대외비') ? 'deny' : 'pass';
    return { decision, stdout: r.stdout || '' };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function expect(where, command, want, why, opts = {}) {
  const res = run(hook, where, command, opts);
  let got = res.decision;
  // opts.text: deny 안내에 있어야 할 문구. 없으면 실패로 센다
  if (opts.text && !res.stdout.includes(opts.text)) got = `${got} (안내 문구 「${opts.text}」 없음)`;
  const base = run(baseHook, where, command, opts).decision;
  const label = `[${where}${opts.sub ? ' · 하위 디렉토리' : ''}${opts.gh ? ` · ${opts.gh}` : ''}${opts.text ? ' · 안내 문구' : ''}]`;
  const weaker = base === 'deny' && res.decision !== 'deny';
  if (got === want && !weaker) { passed++; console.log(`ok   ${label} ${want} (기준 ${base}) ${JSON.stringify(command)}`); return; }
  failed++;
  console.log(`FAIL ${label} ${JSON.stringify(command)} — 기대 ${want}, 받은 값 ${got}, 기준 ${base}${weaker ? ' (기준보다 약함)' : ''}${why ? ` (${why})` : ''}`);
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
expect('tracked', 'git commit -m x b.txt', 'deny', '경로 인자는 단독 커밋이 아니다(#1161)');

// ─── 추적 안 하는 새 파일 ───
expect('untracked', 'git commit -m x', 'pass', '새 파일은 담기지 않는다');

// ─── 대외비 없음 ───
expect('none', 'git commit -am x 2>&1', 'deny', '리다이렉션은 단독 커밋이 아니다(#1161)');

// ─── 커밋 모양 게이트 (#1161): 단독 커밋 호출만 검사로 넘긴다 ───
// main 이 놓치던 네 형태. 검사가 본 diff 와 실제 커밋이 다르다
expect('untracked', 'git add new.txt && git commit -m x', 'deny', '같은 명령 add 뒤 커밋');
expect('tracked', 'git commit -m x seed.txt', 'deny', '경로 지정');
expect('staged', 'cd .. && git commit -m x', 'deny', '상대 cd 뒤', { sub: true });
expect('staged', 'git -C .. commit -m x', 'deny', '상대 -C', { sub: true });
// 반드시 막을 모양 (깨끗한 레포에서도 막는다)
for (const command of [
  'git add . && git commit -m x',
  'git add -A; git commit -m x',
  'git commit -m x || true',
  'git commit -m x | cat',
  'git commit -m x &',
  'git commit -m x -- seed.txt',
  'git commit -m x --',
  'cd . && git commit -m x',
  'git -C . commit -m x',
  'git --git-dir=.git commit -m x',
  'git --work-tree=. commit -m x',
  'git -c user.name=t commit -m x',
  'git -c core.hooksPath=/dev/null commit -m x',
  'GIT_INDEX_FILE=/tmp/idx git commit -m x',
  'LANG=C git commit -m x',
  "sh -c 'git commit -m x'",
  "bash -c 'git commit -m x'",
  "eval 'git commit -m x'",
  '(git commit -m x)',
  'echo "$(git commit -m x)"',
  'echo `git commit -m x`',
  'git commit -n -m x',
  'git commit --no-verify -m x',
  'git commit -o -m x seed.txt',
  'git commit --only -m x',
  'git commit -i -m x',
  'git commit --include -m x',
  'git commit --pathspec-from-file=list.txt -m x',
  'git commit -m x 2>&1',
  'git commit -m x > /dev/null',
  'git commit -m "$x"',
  'git commit -m x\ngit status',
  "git commit -m $'x'",
  'git commit -m x -v',
  'git commit --no-gpg-sign -m x',
  'cat <<EOF\n$(git commit -m x)\nEOF',
  'cat <<-EOF\n`git commit -m x`\nEOF',
]) expect('none', command, 'deny');
// 막을 때 안내: 나눠서 단독 커밋으로 다시 실행하게 한다
expect('none', 'git add . && git commit -m x', 'deny', '안내 문구', { text: '단독으로 다시 실행' });
expect('none', 'cat <<EOF\n$(git commit -m x)\nEOF', 'deny', '비인용 히어닥 본문의 명령 대체는 실행된다', { text: '단독으로 다시 실행' });
// 정상 단독 커밋
expect('none', 'git commit -m x', 'pass', '깨끗한 스테이징');
expect('staged', 'git commit -m x', 'deny', '키워드 스테이징');
expect('tracked', 'git commit -a -m x', 'deny', '-a 키워드');
// 허용 메시지 꼴 4종
expect('none', 'git commit -q -m "fix: two words"', 'pass', '따옴표 문자열');
expect('none', "git commit -m \"$(cat <<'EOF'\nfix: it's \"fine\"\n\nCo-Authored-By: A <a@example.com>\nEOF\n)\"", 'pass', '표준 히어닥 메시지');
expect('none', "git commit -s -F - <<'EOF'\nfix: x\nEOF", 'pass', '-F - 히어닥');
expect('none', 'git commit -F list.txt', 'pass', '-F 경로');
// 그 밖의 허용 옵션
expect('none', 'git commit --amend --no-edit --allow-empty -S', 'pass', '짧은 꼴 · 서명');
expect('none', 'git commit --quiet --signoff --all -m x', 'pass', '긴 꼴');
expect('none', 'git commit -SABCDEF12 -m x', 'pass', '-S<키>');
expect('none', 'git commit --gpg-sign=ABCDEF12 -m x', 'pass', '--gpg-sign=<키>');
// 따옴표 안의 커밋 글자는 커밋이 아니다
expect('none', "cat <<'EOF' > /dev/null\nrun git commit -m x\nEOF", 'pass', '인용 구분자 히어닥 본문');
expect('none', 'cat <<"EOF" > /dev/null\nrun $(git commit -m x)\nEOF', 'pass', '큰따옴표 구분자 히어닥 본문은 펼치지 않는다');
expect('none', 'echo "git commit -m x" > /dev/null', 'pass', '따옴표 안');
// 비공개 레포의 커밋 모양은 바꾸지 않는다
expect('none', 'git add . && git commit -m x', 'pass', '비공개 레포', { gh: 'private' });
// 대상 경로를 못 정하면 공개로 본다
// 대외비 검사도 따로 막으므로 게이트의 안내(커밋 모양)로 확인한다
expect('none', 'cd "$D" && git commit -m x', 'deny', '비공개 레포라도 셸 변수 cd 뒤 커밋은 대상을 못 정한다', { gh: 'private', text: '커밋 모양' });
// 공개 여부 조회가 예산을 넘기면 통과 대신 다시 실행
expect('none', 'git commit -m x', 'deny', '공개 여부 조회 1.6초 지연', { gh: 'slow-public' });
// 예산 미만이어도 검사가 절반 이상 걸리면 막는다. 검사 안 git diff 의 시간 초과를 바깥에서 구분할 수 없다.
// 기본 예산(1.5초)은 검사 밖 고정 비용(약 0.75초)과 합쳐 예산 초과 분기로 먼저 막히므로, 예산을 2.1초로 두고
// 검사 안 git diff 를 1.1초(git diff 시간 제한 1.2초 미만) 늦춘다: 검사 ≥ 절반(1.05초), 훅 전체 < 예산
expect('none', 'git commit -m x', 'deny', '검사 1.1초(예산 2.1초의 절반 이상 · 예산 미만)', { gh: 'slow-diff', budget: 2100 });

rmSync(baseDir, { recursive: true, force: true });
console.log(failed ? `\n실패 ${failed}건` : `\n${passed}건 전부 통과`);
process.exit(failed ? 1 : 0);
