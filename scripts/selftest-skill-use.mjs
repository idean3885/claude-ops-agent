#!/usr/bin/env node
/**
 * selftest-skill-use.mjs — 스킬 사용 지표 · 시범 지표 집계 · 자동 지표 없음 알림 자체 점검 (#1135).
 *
 * `pre-tool-use.mjs` 의 스킬 사용 기록이나 `session-start.mjs` 의 시범 지표 집계를 고쳤으면 이것을 돌린다.
 * 기록이 무너지면 사용 횟수가 조용히 틀리고, 집계가 무너지면 시범 판정 근거가 「기록 없음」으로 바뀐다.
 * 두 경우 모두 오류 없이 지나간다.
 *
 * 임시 HOME 에서 훅을 실제로 실행한다. 사용자의 지표 · 캐시 · 시범 파일을 건드리지 않는다.
 *
 * 사용: node scripts/selftest-skill-use.mjs
 * 종료 코드: 실패 1, 전부 통과 0
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const preHook = join(here, 'pre-tool-use.mjs');
const startHook = join(here, 'session-start.mjs');

let failed = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`ok   ${name}`); return; }
  failed++;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'skill-use-'));
  try { return fn(home); } finally { rmSync(home, { recursive: true, force: true }); }
}

function runPre(home, toolName, toolInput, sessionId = 's1', extraEnv = {}) {
  return spawnSync('node', [preHook], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput, session_id: sessionId, cwd: join(home, 'work', 'my-repo') }),
    encoding: 'utf8',
    env: {
      ...process.env, HOME: home,
      OPS_AGENT_CONFIDENTIAL_DISABLE: '', OPS_AGENT_WHAT_GUARD_DISABLE: '1', OPS_AGENT_ACTION_GATE_DISABLE: '1',
      OPS_AGENT_FINAL_CHECK_DISABLE: '1', OPS_AGENT_FLOW_ENTRY_DISABLE: '', OPS_AGENT_SKILL_USE_DISABLE: '',
      ...extraEnv,
    },
  });
}

function metricFiles(home) {
  const dir = join(home, '.claude', 'ops-agent', 'metrics');
  return existsSync(dir) ? readdirSync(dir).filter(f => f.startsWith('skill-use-')) : [];
}
function skillRecords(home) {
  return metricFiles(home).flatMap(f => readFileSync(join(home, '.claude', 'ops-agent', 'metrics', f), 'utf8')
    .trim().split('\n').filter(Boolean).map(l => JSON.parse(l)));
}

// ─── 기록 ───

// 다른 플러그인 스킬은 네임스페이스를 남긴다. 플러그인마다 같은 이름의 스킬이 있다 (실측: 실제 Skill 입력은 「플러그인:이름」)
withHome(home => {
  runPre(home, 'Skill', { skill: 'other-plugin:learn' });
  runPre(home, 'Skill', { skill: 'ops-agent:learn' });
  runPre(home, 'Read', { file_path: join(home, '.claude', 'plugins', 'cache', 'mkt', 'other-plugin', '1.0.0', 'skills', 'review', 'SKILL.md') });
  const names = skillRecords(home).map(r => r.skill).sort().join(',');
  check('다른 플러그인 스킬은 「플러그인:이름」, ops-agent 는 이름만 남긴다', names === 'learn,other-plugin:learn,other-plugin:review', names);
});
const install = home => join(home, '.claude', 'plugins', 'cache', 'mkt', 'ops-agent', '9.0.0', 'skills');

withHome(home => {
  const res = runPre(home, 'Skill', { skill: 'ops-agent:flow', args: 'SECRET-ARGS 이슈 1135' });
  const recs = skillRecords(home);
  check('Skill 호출은 스킬 이름(네임스페이스 없이)으로 한 줄 남긴다', recs.length === 1 && recs[0].skill === 'flow', JSON.stringify(recs));
  check('기록 필드는 ts · session · skill · repo 넷뿐이다',
    recs.length === 1 && Object.keys(recs[0]).sort().join(',') === 'repo,session,skill,ts', JSON.stringify(recs[0]));
  check('repo 는 작업 디렉토리 basename 이다', recs[0] && recs[0].repo === 'my-repo');
  const raw = metricFiles(home).map(f => readFileSync(join(home, '.claude', 'ops-agent', 'metrics', f), 'utf8')).join('');
  check('Skill 의 args 는 남기지 않는다', !raw.includes('SECRET-ARGS'));
  check('달별 파일에 쌓는다', metricFiles(home).length === 1 && /^skill-use-\d{4}-\d{2}\.jsonl$/.test(metricFiles(home)[0]), metricFiles(home).join());
  check('기록이 판정을 바꾸지 않는다(차단 없음)', !/deny/.test(res.stdout || ''), (res.stdout || '').slice(0, 120));
});

withHome(home => {
  runPre(home, 'Read', { file_path: join(install(home), 'learn', 'SKILL.md') });
  const recs = skillRecords(home);
  check('플러그인 설치본 SKILL.md Read 는 스킬 사용으로 센다', recs.length === 1 && recs[0].skill === 'learn', JSON.stringify(recs));
  const raw = metricFiles(home).map(f => readFileSync(join(home, '.claude', 'ops-agent', 'metrics', f), 'utf8')).join('');
  check('전체 경로는 남기지 않는다', !raw.includes('cache/mkt') && !raw.includes(home));
});

withHome(home => {
  runPre(home, 'Read', { file_path: join(home, '.claude', 'ops-agent', 'current', 'skills', 'flow', 'SKILL.md') });
  check('ops-agent/current 경로 Read 도 센다', skillRecords(home).length === 1 && skillRecords(home)[0].skill === 'flow');
});

withHome(home => {
  runPre(home, 'Read', { file_path: join(home, 'git-project', 'claude-ops-agent', 'skills', 'learn', 'SKILL.md') });
  runPre(home, 'Read', { file_path: join(home, 'git-project', 'claude-ops-agent-wip', 'skills', 'learn', 'SKILL.md') });
  check('레포 워킹 카피 Read 는 세지 않는다', skillRecords(home).length === 0);
});

withHome(home => {
  runPre(home, 'Read', { file_path: join(install(home), 'flow', 'guides', 'pr.md') });
  check('설치본이라도 SKILL.md 가 아닌 Read 는 세지 않는다', skillRecords(home).length === 0);
});

withHome(home => {
  runPre(home, 'Bash', { command: 'ls' });
  runPre(home, 'Edit', { file_path: join(install(home), 'flow', 'SKILL.md'), old_string: 'a', new_string: 'b' });
  check('다른 도구는 세지 않는다', skillRecords(home).length === 0);
  check('Skill · Read 가 아니면 지표 · 캐시 디렉토리를 만들지 않는다(IO 없음)',
    !existsSync(join(home, '.claude', 'ops-agent', 'metrics')) && !existsSync(join(home, '.claude', 'ops-agent', '.cache', 'skill-use')));
});

withHome(home => {
  runPre(home, 'Skill', { skill: 'learn' }, 's1');
  runPre(home, 'Read', { file_path: join(install(home), 'learn', 'SKILL.md') }, 's1');
  runPre(home, 'Skill', { skill: 'ops-agent:learn' }, 's1');
  check('같은 세션 · 같은 스킬은 첫 1회만 센다 (Skill · Read · 네임스페이스 무관)', skillRecords(home).length === 1, String(skillRecords(home).length));
  runPre(home, 'Skill', { skill: 'flow' }, 's1');
  check('같은 세션의 다른 스킬은 센다', skillRecords(home).length === 2);
  runPre(home, 'Skill', { skill: 'learn' }, 's2');
  check('다른 세션의 같은 스킬은 센다', skillRecords(home).length === 3);
});

withHome(home => {
  runPre(home, 'Skill', { skill: 'flow' }, 's1', { OPS_AGENT_SKILL_USE_DISABLE: '1' });
  check('OPS_AGENT_SKILL_USE_DISABLE=1 이면 기록하지 않는다', skillRecords(home).length === 0);
});

// ─── 집계 · 알림 (session-start) ───
function sessionStart(home, trials, files) {
  const base = join(home, '.claude', 'ops-agent');
  mkdirSync(join(base, 'metrics'), { recursive: true });
  for (const [name, body] of Object.entries(files || {})) writeFileSync(join(base, 'metrics', name), body);
  writeFileSync(join(base, 'trials.local.json'), JSON.stringify({ trials }));
  const res = spawnSync('node', [startHook], { input: JSON.stringify({ cwd: home }), encoding: 'utf8', env: { ...process.env, HOME: home } });
  try {
    const ctx = JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
    return ctx.slice(ctx.indexOf('[시범 적용 중'));
  } catch { return `(주입 없음) ${(res.stdout || '') + (res.stderr || '')}`.slice(0, 300); }
}
const rows = (skill, n, ts = '2026-03-01T00:00:00.000Z') => Array.from({ length: n }, () => JSON.stringify({ ts, session: 'x', skill, repo: 'r' }) + '\n').join('');
const metricOf = (source, extra = {}) => ({ name: '스킬', source, groupBy: 'skill', ...extra });

withHome(home => {
  const out = sessionStart(home,
    [{ name: 't', started: '2026-01-01', metrics: [metricOf('~/.claude/ops-agent/metrics/skill-use-*.jsonl')] }],
    { 'skill-use-2026-02.jsonl': rows('flow', 2) + rows('learn', 1), 'skill-use-2026-03.jsonl': rows('flow', 3), 'other.jsonl': rows('zzz', 9) });
  check('글롭 source 는 달별 파일을 합산한다', /지표: 스킬 flow 5 · learn 1/.test(out), out);
  check('글롭에 맞지 않는 파일은 합산하지 않는다', !/zzz/.test(out), out);
  check('합산 결과에 상한 표시가 붙지 않는다', !/MB/.test(out), out);
});

withHome(home => {
  const MB = 1024 * 1024;
  // 앞쪽 6MB 는 old, 끝쪽은 new. 상한(5MB)만큼만 끝에서 읽으면 old 의 일부가 남을 수 없게 앞을 충분히 채운다.
  const oldLine = JSON.stringify({ ts: '2026-03-01T00:00:00.000Z', session: 'x', skill: 'old', repo: 'r' }) + '\n';
  const head = oldLine.repeat(Math.ceil(6 * MB / oldLine.length));
  const out = sessionStart(home,
    [{ name: 't', started: '2026-01-01', metrics: [metricOf('~/.claude/ops-agent/metrics/big.jsonl')] }],
    { 'big.jsonl': head + rows('new', 7) });
  check('상한을 넘으면 「기록 없음」이 아니라 끝부분을 집계한다', /new 7/.test(out) && !/스킬 기록 없음/.test(out), out.slice(0, 300));
  check('상한을 넘었다는 사실을 표시한다', /끝 5MB 만 집계/.test(out), out.slice(0, 300));
  const oldN = Number((out.match(/old (\d+)/) || [])[1] || 0);
  check('끝 5MB 만 읽는다 (앞의 일부는 빠진다)', oldN > 0 && oldN < Math.ceil(6 * MB / oldLine.length), `old ${oldN}`);
});

withHome(home => {
  const MB = 1024 * 1024;
  // 읽기 시작 위치가 줄 중간이면 첫 줄은 깨진 JSON 이다. 버려야 하고 집계에 섞이지 않아야 한다.
  const line = JSON.stringify({ ts: '2026-03-01T00:00:00.000Z', session: 'x', skill: 'a', repo: 'r' }) + '\n';
  const n = Math.ceil(5 * MB / line.length) + 5;
  const out = sessionStart(home,
    [{ name: 't', started: '2026-01-01', metrics: [metricOf('~/.claude/ops-agent/metrics/cut.jsonl')] }],
    { 'cut.jsonl': line.repeat(n) });
  const got = Number((out.match(/a (\d+)/) || [])[1] || 0);
  const full = Math.floor(5 * MB / line.length);
  check('잘린 첫 줄은 버린다', got > 0 && got <= full, `집계 ${got}, 상한 안 줄 수 ${full}`);
});

withHome(home => {
  const out = sessionStart(home, [{ name: 't', started: '2026-01-01', metrics: [metricOf('~/.claude/ops-agent/metrics/none-*.jsonl')] }], {});
  check('글롭에 맞는 파일이 없으면 「기록 없음」', /지표: 스킬 기록 없음/.test(out), out);
});

const ALERT = /자동 지표 없음: metrics 또는 cause 를 붙인다/;
withHome(home => {
  const out = sessionStart(home, [{ name: 'bare', started: '2026-01-01' }], {});
  check('metrics 도 cause 도 없는 시범에 알림을 붙인다', ALERT.test(out), out);
  check('알림은 그 시범 블록 안에 있다', /- bare[^\n]*\n  자동 지표 없음/.test(out), out);
});
withHome(home => {
  const out = sessionStart(home, [{ name: 'm', started: '2026-01-01', metrics: [metricOf('~/.claude/ops-agent/metrics/x.jsonl')] }], {});
  check('metrics 가 있으면 알림이 없다', !ALERT.test(out), out);
});
withHome(home => {
  const out = sessionStart(home, [{ name: 'c', started: '2026-01-01', cause: 'level' }], {});
  check('cause 가 있으면 알림이 없다', !ALERT.test(out), out);
});
withHome(home => {
  const out = sessionStart(home, [{ name: 'e', started: '2026-01-01', ended: '2026-02-01' }], {});
  check('ended 시범은 주입 자체가 없다', !ALERT.test(out), out);
});
withHome(home => {
  const out = sessionStart(home, [{ name: 'bare', started: '2026-01-01', criteria: ['a'], reviewAt: '2020-01-01' }], {});
  const block = out.split('\n').filter(l => l.startsWith('  ') && !l.startsWith('  규칙') && !l.startsWith('  검토') && !l.startsWith('  산출물'));
  check('지표 · 기준 · 판정일 · 도래 안내 줄이 4줄을 넘지 않는다', block.length <= 4 && ALERT.test(out), block.join(' | '));
});

console.log(failed ? `\n실패 ${failed}건` : '\n전부 통과');
process.exit(failed ? 1 : 0);
