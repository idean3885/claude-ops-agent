#!/usr/bin/env node
/**
 * selftest-repo-allowlist.mjs — 레포 허용 목록 가드 자체 점검 (#969).
 *
 * `repo-allowlist-rules.mjs` 나 `pre-tool-use.mjs` 의 허용 목록 블록을 고쳤으면 돌린다.
 * 가드는 발동할 때만 존재가 드러나므로 조용히 무력화되면 신호가 없다.
 * 실제 훅을 실행한다. 가짜 레포를 만들고 OPS_AGENT_REPO_ALLOWLIST 로 목록 파일을 바꾼다.
 *
 * 사용: node scripts/selftest-repo-allowlist.mjs
 * 종료 코드: 실패 1, 전부 통과 0
 */
import { spawnSync, execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const hook = join(here, 'pre-tool-use.mjs');
const MARK = '[ops-agent 레포 허용 목록';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'ops-repo-allowlist-')));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' });
function repo(name, remote) {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  if (remote) git(dir, 'remote', 'add', 'origin', remote);
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}
const W = repo('write', 'https://git.corp.test/Org/Write-Repo.git');
const R = repo('read', 'git@git.corp.test:org/read-repo.git');
const X = repo('unlisted', 'ssh://git@git.corp.test/org/unlisted.git');
const P = repo('public', 'https://github.com/someone/pub.git');
const L = repo('local', null);
const XW = join(base, 'unlisted-wt');
git(X, 'worktree', 'add', '-q', XW);
const PLAIN = join(base, 'plain');
mkdirSync(PLAIN);

const LIST = join(base, 'repo-allowlist.local.json');
writeFileSync(LIST, JSON.stringify({
  hosts: ['git.corp.test'],
  write: ['git.corp.test/org/write-repo'],
  read: ['git.corp.test/org/read-repo'],
}));
const LIST_ALL_HOSTS = join(base, 'all-hosts.json');
writeFileSync(LIST_ALL_HOSTS, JSON.stringify({ write: ['git.corp.test/org/write-repo'] }));
const MISSING = join(base, 'none.json');

const bash = (command, cwd = PLAIN) => ['Bash', { command }, cwd];
// [이름, 도구, 입력, cwd, 기대(pass|deny), 목록 파일]
const CASES = [
  ['쓰기 레포 Read', 'Read', { file_path: join(W, 'a.txt') }, PLAIN, 'pass'],
  ['쓰기 레포 Edit', 'Edit', { file_path: join(W, 'a.txt'), old_string: 'a', new_string: 'b' }, PLAIN, 'pass'],
  ['읽기 전용 Read', 'Read', { file_path: join(R, 'a.txt') }, PLAIN, 'pass'],
  ['읽기 전용 Edit', 'Edit', { file_path: join(R, 'a.txt'), old_string: 'a', new_string: 'b' }, PLAIN, 'deny'],
  ['읽기 전용 Write 새 하위 경로', 'Write', { file_path: join(R, 'new', 'dir', 'b.txt'), content: 'x' }, PLAIN, 'deny'],
  ['미등록 Read', 'Read', { file_path: join(X, 'a.txt') }, PLAIN, 'deny'],
  ['미등록 워크트리 Read', 'Read', { file_path: join(XW, 'a.txt') }, PLAIN, 'deny'],
  ['미등록 cwd Grep (경로 생략)', 'Grep', { pattern: 'a' }, X, 'deny'],
  ['읽기 전용 Glob', 'Glob', { pattern: '*', path: R }, PLAIN, 'pass'],
  ['판정 밖 호스트 Edit', 'Edit', { file_path: join(P, 'a.txt'), old_string: 'a', new_string: 'b' }, PLAIN, 'pass'],
  ['원격 없는 레포 Edit', 'Edit', { file_path: join(L, 'a.txt'), old_string: 'a', new_string: 'b' }, PLAIN, 'pass'],
  ['git 아닌 경로 Write', 'Write', { file_path: join(PLAIN, 'x.txt'), content: 'x' }, PLAIN, 'pass'],
  ['미등록 클론', ...bash('git clone https://git.corp.test/org/unlisted.git /tmp/x'), 'deny'],
  ['읽기 전용 클론', ...bash('git clone git@git.corp.test:org/read-repo.git /tmp/x'), 'pass'],
  ['읽기 전용 git log', ...bash('git log --oneline -3', R), 'pass'],
  ['읽기 전용 워크트리 추가', ...bash(`git -C ${R} worktree add ../r-wt`), 'pass'],
  ['읽기 전용 git commit', ...bash('git commit -m x', R), 'deny'],
  ['읽기 전용 git -C push', ...bash(`git -C ${R} push origin HEAD`), 'deny'],
  ['쓰기 레포 cd 후 commit', ...bash(`cd ${W} && git add a.txt && git commit -m x`), 'pass'],
  ['미등록 cd 후 ls', ...bash(`cd ${X} && ls`), 'deny'],
  ['미등록 절대 경로 cat', ...bash(`cat ${join(X, 'a.txt')}`), 'deny'],
  ['미등록 워크트리 grep', ...bash(`grep -r a ${XW}`), 'deny'],
  ['gh pr create -R 읽기 전용', ...bash('gh pr create --draft -R git.corp.test/org/read-repo --title t --body b'), 'deny'],
  ['gh pr view GH_HOST 읽기 전용', ...bash('GH_HOST=git.corp.test gh pr view 1 -R org/read-repo'), 'pass'],
  ['gh pr create cwd 읽기 전용', ...bash('gh pr create --draft --title t --body b', R), 'deny'],
  ['gh api GET 미등록', ...bash('gh api repos/org/unlisted/pulls --hostname git.corp.test'), 'deny'],
  ['gh api POST 읽기 전용', ...bash('gh api -X POST repos/org/read-repo/issues --hostname git.corp.test -f title=t'), 'deny'],
  ['gh api 필드 = POST 읽기 전용', ...bash('GH_HOST=git.corp.test gh api repos/org/read-repo/issues -f title=t'), 'deny'],
  ['gh api GET 읽기 전용', ...bash('gh api repos/org/read-repo/pulls --hostname git.corp.test'), 'pass'],
  ['gh repo clone 미등록', ...bash('GH_HOST=git.corp.test gh repo clone org/unlisted'), 'deny'],
  ['이슈 어댑터 -R 읽기 전용', ...bash('bash ~/x/gh-issue.sh create -R git.corp.test/org/read-repo --title t --body-file b --type feat --start'), 'deny'],
  ['리다이렉트 쓰기 읽기 전용', ...bash(`echo x > ${join(R, 'a.txt')}`), 'deny'],
  ['읽기 전용에서 복사해 나옴', ...bash(`cp ${join(R, 'a.txt')} /tmp/b`), 'pass'],
  ['읽기 전용으로 복사해 들어감', ...bash(`cp /tmp/b ${join(R, 'a.txt')}`), 'deny'],
  ['읽기 전용 sed -i', ...bash(`sed -i '' s/a/b/ ${join(R, 'a.txt')}`), 'deny'],
  ['읽기 전용 cwd 에서 바깥 sed -i', ...bash(`sed -i '' s/a/b/ /tmp/b`, R), 'pass'],
  ['읽기 전용 cwd stderr 버림', ...bash('ls 2>/dev/null', R), 'pass'],
  ['git 아닌 디렉토리 ls', ...bash('ls'), 'pass'],
  ['목록 파일 Edit', 'Edit', { file_path: '/x/repo-allowlist.local.json', old_string: 'a', new_string: 'b' }, PLAIN, 'deny'],
  ['목록 원천 Write', 'Write', { file_path: '/x/config/repo-allowlist.json', content: '{}' }, PLAIN, 'deny'],
  ['목록 파일 리다이렉트', ...bash('echo {} > ~/.claude/ops-agent/repo-allowlist.local.json'), 'deny'],
  ['목록 파일 읽기', ...bash('cat ~/.claude/ops-agent/repo-allowlist.local.json'), 'pass'],
  ['등록 스크립트 실행', ...bash('bash ~/x/scripts/repo-allowlist.sh add write git.corp.test/org/unlisted'), 'deny'],
  ['등록 스크립트 직접 실행', ...bash('cd /tmp && ~/x/repo-allowlist.sh remove git.corp.test/org/read-repo'), 'deny'],
  ['등록 스크립트 목록 파일 없어도 차단', ...bash('bash ~/x/repo-allowlist.sh add read git.corp.test/org/x'), 'deny', join(base, 'none.json')],
  ['등록 스크립트 조회', ...bash('bash ~/x/scripts/repo-allowlist.sh list'), 'pass'],
  ['목록 파일 없음 → 판정 안 함', 'Read', { file_path: join(X, 'a.txt') }, PLAIN, 'pass', MISSING],
  ['hosts 생략 → 모든 호스트 판정', 'Read', { file_path: join(P, 'a.txt') }, PLAIN, 'deny', LIST_ALL_HOSTS],
];

let fail = 0;
for (const [name, tool, input, cwd, want, list = LIST] of CASES) {
  const r = spawnSync('node', [hook], {
    input: JSON.stringify({ tool_name: tool, tool_input: input, cwd, session_id: 'selftest-repo-allowlist' }),
    encoding: 'utf8',
    env: { ...process.env, OPS_AGENT_REPO_ALLOWLIST: list },
  });
  let reason = '';
  try { reason = JSON.parse(r.stdout).hookSpecificOutput?.permissionDecisionReason || ''; } catch { reason = `출력 해석 실패: ${r.stdout}`; }
  const got = reason.includes(MARK) ? 'deny' : 'pass';
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} (기대 ${want}, 결과 ${got})${ok ? '' : `\n     ${reason.split('\n')[0] || r.stdout.slice(0, 200)}`}`);
}
rmSync(base, { recursive: true, force: true });
console.log(fail ? `\n실패 ${fail}/${CASES.length}` : `\n전부 통과 ${CASES.length}/${CASES.length}`);
process.exit(fail ? 1 : 0);
