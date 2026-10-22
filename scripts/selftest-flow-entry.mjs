#!/usr/bin/env node
/**
 * selftest-flow-entry.mjs — 플로우 진입 지표 자체 점검 (#769).
 *
 * `pre-tool-use.mjs` 를 고쳤으면 이것을 돌린다. 지표는 막지 않고 한 줄만 남기므로,
 * 판정이 무너져도 아무 신호가 없다. 특히 트리거 표의 가이드 경로를 읽음으로 오판하면
 * 모든 세션이 loaded 로 남아 시범 판정이 조용히 틀린다.
 *
 * 임시 HOME 에서 훅을 실제로 실행하고 지표 파일을 읽는다. 사용자의 지표 · 캐시를 건드리지 않는다.
 *
 * 사용: node scripts/selftest-flow-entry.mjs
 * 종료 코드: 실패 1, 전부 통과 0
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const hook = join(here, 'pre-tool-use.mjs');

// 세션 시작 주입: 트리거 표에 가이드 경로가 문자열로 들어 있다. 이것만으로는 읽음이 아니다.
const SESSION_START = JSON.stringify({
  type: 'attachment',
  content: '| "커밋", "PR" | /p/ops-agent/9.0.0/skills/flow/SKILL.md |',
});
const READ_GUIDE = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/p/ops-agent/9.0.0/skills/flow/SKILL.md' } }] },
});
const BASH_GUIDE = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'cd "/p" && sed -n 1,20p "/p/skills/flow/guides/pr.md"' } }] },
});
const SKILL_FLOW = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'ops-agent:flow' } }] },
});
const OTHER = JSON.stringify({ type: 'user', message: { content: '이 이슈는 어디 세션에서 관리되나요' } });

let failed = 0;
let seq = 0;

function runHook(home, transcript, command, sessionId) {
  const input = { tool_name: 'Bash', tool_input: { command }, session_id: sessionId, cwd: home };
  if (transcript) input.transcript_path = transcript;
  return spawnSync('node', [hook], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      // 대외비 가드 비활성은 훅 본문 전체를 건너뛴다. 임시 HOME 에는 키워드 설정이 없어 켜 두어도 통과한다.
      OPS_AGENT_CONFIDENTIAL_DISABLE: '',
      OPS_AGENT_WHAT_GUARD_DISABLE: '1',
      OPS_AGENT_ACTION_GATE_DISABLE: '1',
      OPS_AGENT_FINAL_CHECK_DISABLE: '1',
      OPS_AGENT_FLOW_ENTRY_DISABLE: '',
    },
  });
}

function records(home) {
  const file = join(home, '.claude', 'ops-agent', 'metrics', 'flow-entry.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function check(name, cond, detail) {
  if (cond) { console.log(`ok   ${name}`); return; }
  failed++;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

// 한 케이스 = 새 HOME · 새 세션. lines 를 대화 기록으로 쓰고 command 를 실행한 뒤 마지막 기록을 본다.
function scenario(name, lines, command, want) {
  const home = mkdtempSync(join(tmpdir(), 'flow-entry-'));
  try {
    const transcript = join(home, 'transcript.jsonl');
    writeFileSync(transcript, lines.map(l => l + '\n').join(''));
    const res = runHook(home, transcript, command, `s${++seq}`);
    // 집계 코드가 던지면 가드 전체가 내부 오류로 판정 없이 통과한다. 상수를 훅 본문 아래에 두었을 때 실제로 났다.
    check(`${name}: 가드 내부 오류 없음`, !/가드 내부 오류/.test(res.stdout || ''), (res.stdout || '').slice(0, 160));
    const recs = records(home);
    if (want === null) {
      check(name, recs.length === 0, `기록 ${recs.length}건`);
      return;
    }
    const last = recs[recs.length - 1];
    check(name, last && last.flow === want.flow && JSON.stringify(last.actions) === JSON.stringify(want.actions),
      `받은 값 ${JSON.stringify(last)}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const COMMIT = "git commit -q -F - <<'EOF'\ndocs: x\nEOF";

scenario('트리거 표만 있으면 누락', [SESSION_START, OTHER], COMMIT, { flow: 'missed', actions: ['commit'] });
scenario('가이드 파일 읽기는 읽음', [SESSION_START, READ_GUIDE], COMMIT, { flow: 'loaded', actions: ['commit'] });
scenario('따옴표가 든 셸 명령으로 가이드를 열어도 읽음', [SESSION_START, BASH_GUIDE], 'git push -q origin feat/1',
  { flow: 'loaded', actions: ['push'] });
scenario('flow 스킬 호출은 읽음', [SKILL_FLOW], 'gh pr create --draft --base main --title x --body-file b.md',
  { flow: 'loaded', actions: ['pr'] });
scenario('cd 뒤 git -C 커밋과 push 를 함께 센다', [OTHER], 'cd /tmp && git -C /tmp/r commit -m x && git push',
  { flow: 'missed', actions: ['commit', 'push'] });
scenario('대상 밖 명령은 기록하지 않는다', [OTHER], 'git status && git log --oneline -3', null);
scenario('따옴표 안 문구는 명령이 아니다', [OTHER], "echo 'git commit -m x'", null);

// 대화 기록이 없는 호출은 세지 않는다. 다른 자체 점검이 사용자 지표에 기록을 남기지 않게 하는 조건이다.
{
  const home = mkdtempSync(join(tmpdir(), 'flow-entry-'));
  try {
    runHook(home, null, COMMIT, 'nt');
    check('대화 기록 경로가 없으면 기록하지 않는다', records(home).length === 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// 이어 읽기: 첫 호출에서 누락, 그 뒤 가이드를 읽고 다시 커밋하면 읽음. 캐시된 위치 뒤에 붙은 줄을 읽어야 한다.
{
  const home = mkdtempSync(join(tmpdir(), 'flow-entry-'));
  try {
    const transcript = join(home, 'transcript.jsonl');
    writeFileSync(transcript, [SESSION_START, OTHER].map(l => l + '\n').join(''));
    runHook(home, transcript, COMMIT, 'inc');
    appendFileSync(transcript, READ_GUIDE + '\n');
    runHook(home, transcript, COMMIT, 'inc');
    const flows = records(home).map(r => r.flow);
    check('이어 읽기: 누락 뒤 가이드를 읽으면 읽음', JSON.stringify(flows) === '["missed","loaded"]', `받은 값 ${JSON.stringify(flows)}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

if (failed) {
  console.log(`\n${failed}건 실패`);
  process.exit(1);
}
console.log('\n전부 통과');
