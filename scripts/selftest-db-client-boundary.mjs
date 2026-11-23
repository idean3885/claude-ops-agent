#!/usr/bin/env node
/**
 * selftest-db-client-boundary.mjs — DB 클라이언트 경계 알림 자체 점검.
 *
 * `db-client-boundary.mjs` 나 `pre-tool-use.mjs` 의 해당 분기를 고쳤으면 돌린다.
 * 알림은 발동할 때만 존재가 드러나므로 조용히 무력화되면 신호가 없다.
 * 훅 전체를 실제로 실행해, 다른 가드를 거친 뒤에도 알림이 남는지 본다.
 *
 * 사용: node scripts/selftest-db-client-boundary.mjs
 * 종료 코드: 실패 1, 전부 통과 0
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const hook = join(here, 'pre-tool-use.mjs');

const work = mkdtempSync(join(tmpdir(), 'ops-db-client-'));
const notes = join(work, 'client.md');
writeFileSync(notes, '# 접속 자산\n');
const missing = join(work, 'missing.md');

const MARK = 'DB 클라이언트 경계';

// want: 'notice' = 알려야 한다, 'quiet' = 조용해야 한다
const CASES = [
  ['클라이언트 직접 실행', 'Bash', { command: 'mysql -h 10.0.0.1 -u app -e "select 1"' }, notes, 'notice'],
  ['경로째 실행', 'Bash', { command: '/opt/homebrew/opt/mysql-client@8.0/bin/mysql --version' }, notes, 'notice'],
  ['환경 변수 대입 뒤 실행', 'Bash', { command: 'MYSQL_PWD=x mysql -h h -e "show tables"' }, notes, 'notice'],
  ['파이프 뒤 실행', 'Bash', { command: 'cat a.sql | mysql -h h db' }, notes, 'notice'],
  ['덤프 도구', 'Bash', { command: 'mysqldump -h h db > out.sql' }, notes, 'notice'],
  ['클라이언트 경로를 변수에 담는 스크립트 (Write)', 'Write', {
    file_path: join(work, 'ddl.sh'),
    content: '#!/bin/bash\nM=/opt/homebrew/bin/mysql\n"$M" -h h -e "select 1"\n',
  }, notes, 'notice'],
  ['shebang 있는 확장자 없는 스크립트 (Write)', 'Write', {
    file_path: join(work, 'run'), content: '#!/bin/zsh\nmysql -h h -e "select 1"\n',
  }, notes, 'notice'],
  ['스크립트에 실행 줄 추가 (Edit)', 'Edit', {
    file_path: join(work, 'ddl.sh'), old_string: 'echo', new_string: 'mysql -h h < a.sql',
  }, notes, 'notice'],
  ['여러 편집 중 하나가 실행 줄 (MultiEdit)', 'MultiEdit', {
    file_path: join(work, 'ddl.sh'), edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'echo', new_string: 'mysql -h h -e "select 1"' }],
  }, notes, 'notice'],
  ['따옴표 밖 구분자 뒤 실행', 'Bash', { command: 'echo x; mysql -e 1' }, notes, 'notice'],
  ['인자 자리의 낱말', 'Bash', { command: 'grep -n mysql README.md' }, notes, 'quiet'],
  ['드라이버 이름', 'Bash', { command: 'npm ls mysql2' }, notes, 'quiet'],
  ['클라이언트 설치', 'Bash', { command: 'brew install mysql-client@8.0' }, notes, 'quiet'],
  ['따옴표 안의 낱말', 'Bash', { command: 'echo "use mysql; then"' }, notes, 'quiet'],
  ['따옴표 안 구분자 뒤 낱말', 'Bash', { command: 'echo "x; mysql -e 1"' }, notes, 'quiet'],
  ['클라이언트가 아닌 경로 대입 스크립트 (Write)', 'Write', {
    file_path: join(work, 'other.sh'), content: '#!/bin/bash\nM=/usr/bin/psql\n"$M" -c 1\n',
  }, notes, 'quiet'],
  ['shebang 없는 비스크립트 파일 (Write)', 'Write', {
    file_path: join(work, 'notes.txt'), content: 'mysql -h h -e "select 1"\n',
  }, notes, 'quiet'],
  ['문서 산문 (Write)', 'Write', {
    file_path: join(work, 'notes.md'), content: 'mysql 9 클라이언트는 인증 플러그인이 없다\n',
  }, notes, 'quiet'],
  ['자리가 비어 있음', 'Bash', { command: 'mysql -h h -e "select 1"' }, missing, 'quiet'],
];

let failed = 0;

// 이슈 생성 알림과 함께 나와도 둘 다 남는다 (앞선 안내를 덮어쓰지 않는다).
{
  const res = spawnSync('node', [hook], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'mysql -h h -e 1; bash ~/x/gh-issue.sh create --title t --body-file b.md --type feat --no-start r' }, cwd: work, session_id: 'selftest' }),
    env: { ...process.env, OPS_AGENT_DB_CLIENT_NOTICE_DISABLE: '', OPS_AGENT_DB_CLIENT_NOTES: notes },
    encoding: 'utf8',
  });
  let ctx = '';
  try { ctx = (JSON.parse(res.stdout || '{}').hookSpecificOutput || {}).additionalContext || ''; } catch { ctx = ''; }
  const ok = ctx.includes(MARK) && ctx.includes('이슈 생성 · 알림');
  if (!ok) failed++;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  이슈 생성 알림과 함께 (둘 다 남는다)\n`);
}
// 비활성 변수면 조용하다.
{
  const res = spawnSync('node', [hook], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'mysql -h h -e 1' }, cwd: work, session_id: 'selftest' }),
    env: { ...process.env, OPS_AGENT_DB_CLIENT_NOTICE_DISABLE: '1', OPS_AGENT_DB_CLIENT_NOTES: notes },
    encoding: 'utf8',
  });
  const ok = !(res.stdout || '').includes(MARK);
  if (!ok) failed++;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  비활성 변수 (조용)\n`);
}
for (const [name, toolName, toolInput, notesPath, want] of CASES) {
  const res = spawnSync('node', [hook], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd: work, session_id: 'selftest' }),
    env: { ...process.env, OPS_AGENT_DB_CLIENT_NOTICE_DISABLE: '', OPS_AGENT_DB_CLIENT_NOTES: notesPath },
    encoding: 'utf8',
  });
  let ctx = '';
  try {
    const out = JSON.parse(res.stdout || '{}');
    ctx = (out.hookSpecificOutput && out.hookSpecificOutput.additionalContext) || '';
  } catch { ctx = ''; }
  const got = ctx.includes(MARK) ? 'notice' : 'quiet';
  const ok = got === want && (got === 'quiet' || ctx.includes(notesPath));
  if (!ok) failed++;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name} (want ${want}, got ${got})\n`);
}

rmSync(work, { recursive: true, force: true });
process.stdout.write(failed ? `\n${failed}건 실패\n` : '\n전부 통과\n');
process.exit(failed ? 1 : 0);
