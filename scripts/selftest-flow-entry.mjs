#!/usr/bin/env node
/**
 * selftest-flow-entry.mjs — 플로우 진입 지표 자체 점검 (#769 · #1114 · #1116).
 *
 * `pre-tool-use.mjs` 를 고쳤으면 이것을 돌린다. 커밋 · push 는 한 줄만 남기므로 판정이 무너져도
 * 아무 신호가 없다. PR 생성 차단(#773)도 같은 판정에 기대므로 함께 본다. 특히 트리거 표의 가이드 경로를 읽음으로 오판하면
 * 모든 세션이 loaded 로 남아 시범 판정이 조용히 틀린다.
 *
 * 임시 HOME 에서 훅을 실제로 실행하고 지표 파일을 읽는다. 사용자의 지표 · 캐시를 건드리지 않는다.
 *
 * 사용: node scripts/selftest-flow-entry.mjs
 * 종료 코드: 실패 1, 전부 통과 0
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, existsSync, readFileSync } from 'fs';
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
const READ_PR_GUIDE = JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/w/claude-ops-agent-fix-1/skills/flow/guides/pr.md', limit: 80 } }] },
});
// 아래는 가이드 경로가 문자열로만 나오는 줄이다 (#1116). 어느 것도 가이드 내용을 컨텍스트에 넣지 않는다.
const GREP_GUIDE = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'grep -n "초안" ~/.claude/ops-agent/current/skills/flow/guides/pr.md | head -3' } }] },
});
// 테스트 픽스처를 고치는 명령: Read 호출 모양의 문자열이 인자로 들어 있다.
const FIXTURE_EDIT = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `python3 - <<'X'\nfix = '{"type":"tool_use","name":"Read","input":{"file_path":"/p/skills/flow/guides/pr.md"}}'\nX` } }] },
});
const EDIT_GUIDE = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/w/skills/flow/guides/pr.md', old_string: 'a', new_string: 'b' } }] },
});
const TEXT_PATH = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'text', text: '가이드는 ~/.claude/ops-agent/current/skills/flow/guides/pr.md 에 있습니다' }] },
});
const DELEGATION_PROMPT = JSON.stringify({
  type: 'user',
  message: { role: 'user', content: '마지막에 ~/.claude/ops-agent/current/skills/flow/guides/pr.md 대로 PR 을 만듭니다' },
});
// 도구 결과에 다른 기록의 Read 줄이 그대로 찍혀 나온 경우.
const RESULT_ECHO = JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/p/skills/flow/guides/pr.md' } }] } }) }] },
});
const SKILL_FLOW = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'ops-agent:flow' } }] },
});
const OTHER = JSON.stringify({ type: 'user', message: { content: '이 이슈는 어디 세션에서 관리되나요' } });

let failed = 0;
let seq = 0;

function runHook(home, transcript, command, sessionId, agentId) {
  const input = { tool_name: 'Bash', tool_input: { command }, session_id: sessionId, cwd: home };
  if (transcript) input.transcript_path = transcript;
  if (agentId) { input.agent_id = agentId; input.agent_type = 'general-purpose'; }
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
scenario('셸 명령으로 가이드를 출력해도 읽음이 아니다', [SESSION_START, BASH_GUIDE], 'git push -q origin feat/1',
  { flow: 'missed', actions: ['push'] });
scenario('워크트리 가이드를 Read 로 일부 읽으면 읽음', [SESSION_START, READ_PR_GUIDE], 'git push -q origin feat/1',
  { flow: 'loaded', actions: ['push'] });
scenario('flow 스킬 호출은 읽음', [SKILL_FLOW], 'gh pr create --draft --base main --title x --body-file b.md',
  { flow: 'loaded', actions: ['pr'] });
scenario('cd 뒤 git -C 커밋과 push 를 함께 센다', [OTHER], 'cd /tmp && git -C /tmp/r commit -m x && git push',
  { flow: 'missed', actions: ['commit', 'push'] });
scenario('대상 밖 명령은 기록하지 않는다', [OTHER], 'git status && git log --oneline -3', null);
scenario('따옴표 안 문구는 명령이 아니다', [OTHER], "echo 'git commit -m x'", null);

// PR 생성 차단 (#773). 가이드를 읽지 않은 세션의 PR 생성만 막는다. 커밋 · push 와 읽은 세션은 통과한다.
function denyCase(name, lines, command, wantDeny) {
  const home = mkdtempSync(join(tmpdir(), 'flow-entry-'));
  try {
    const transcript = join(home, 'transcript.jsonl');
    writeFileSync(transcript, lines.map(l => l + '\n').join(''));
    const res = runHook(home, transcript, command, `d${++seq}`);
    const denied = /"permissionDecision":"deny"/.test(res.stdout || '') && /플로우 진입 · 차단/.test(res.stdout || '');
    check(name, denied === wantDeny, (res.stdout || '').slice(0, 160));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
const PR = 'gh pr create --base main --title x --body-file b.md';
denyCase('가이드를 읽지 않은 PR 생성은 막는다', [SESSION_START, OTHER], PR, true);
denyCase('푸시와 함께 온 PR 생성도 막는다', [OTHER], 'git push -u origin feat/1 && ' + PR, true);
denyCase('가이드를 읽은 세션의 PR 생성은 통과', [SESSION_START, READ_GUIDE], PR, false);
denyCase('읽지 않아도 커밋 · push 는 막지 않는다', [OTHER], 'git commit -m x && git push', false);

// 가이드 경로가 문자열로만 나오는 줄은 읽음이 아니다 (#1116).
denyCase('셸 인자(grep 대상)의 가이드 경로는 읽음이 아니다', [OTHER, GREP_GUIDE], PR, true);
denyCase('테스트 픽스처 문자열의 Read 모양은 읽음이 아니다', [OTHER, FIXTURE_EDIT], PR, true);
denyCase('가이드 파일 편집은 읽음이 아니다', [OTHER, EDIT_GUIDE], PR, true);
denyCase('일반 텍스트의 가이드 경로는 읽음이 아니다', [OTHER, TEXT_PATH], PR, true);
denyCase('위임 문구의 가이드 경로는 읽음이 아니다', [DELEGATION_PROMPT, OTHER], PR, true);
denyCase('도구 결과에 찍힌 Read 줄은 읽음이 아니다', [OTHER, RESULT_ECHO], PR, true);
denyCase('경로 문자열 줄 뒤에 Read 가 오면 읽음', [GREP_GUIDE, READ_PR_GUIDE], PR, false);

// 압축 경계 (#891). 압축은 읽은 가이드를 요약으로 대체하므로 경계 앞의 읽음은 경계 뒤 절차의 근거가 아니다.
const COMPACT = JSON.stringify({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' });
denyCase('압축 전에만 읽은 세션의 PR 생성은 막는다', [READ_GUIDE, COMPACT, OTHER], PR, true);
denyCase('압축 뒤 다시 읽으면 통과', [READ_GUIDE, COMPACT, READ_PR_GUIDE], PR, false);
denyCase('압축 뒤 처음 읽어도 통과', [OTHER, COMPACT, READ_GUIDE], PR, false);

// 실제 세션은 읽음 판정을 캐시에 둔다. 캐시가 loaded 인 뒤에 압축이 와도 판정이 풀려야 한다.
{
  const home = mkdtempSync(join(tmpdir(), 'flow-entry-'));
  try {
    const transcript = join(home, 'transcript.jsonl');
    writeFileSync(transcript, [READ_GUIDE, OTHER].map(l => l + '\n').join(''));
    const first = runHook(home, transcript, PR, 'cache-compact');
    check('캐시: 압축 전 PR 생성은 통과', !/플로우 진입 · 차단/.test(first.stdout || ''), (first.stdout || '').slice(0, 160));
    appendFileSync(transcript, COMPACT + '\n' + OTHER + '\n');
    const second = runHook(home, transcript, PR, 'cache-compact');
    check('캐시: loaded 뒤 압축이 오면 PR 생성을 막는다', /플로우 진입 · 차단/.test(second.stdout || ''), (second.stdout || '').slice(0, 160));
    appendFileSync(transcript, SKILL_FLOW + '\n');
    const third = runHook(home, transcript, PR, 'cache-compact');
    check('캐시: 압축 뒤 다시 읽으면 통과', !/플로우 진입 · 차단/.test(third.stdout || ''), (third.stdout || '').slice(0, 160));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// 서브에이전트 (#1114). 하네스는 서브에이전트의 호출에도 상위 세션의 기록 경로를 넘기고 agent_id 를 더한다.
// 서브에이전트 자신의 기록은 <상위 기록 디렉토리>/<세션>/subagents/[하위/]agent-<id>.jsonl 이다.
// 상위가 읽은 가이드는 서브에이전트 컨텍스트에 없으므로 인정하지 않는다.
const PROMPT_WITH_PATH = JSON.stringify({
  type: 'user', isSidechain: true,
  message: { content: '마지막에 ~/.claude/ops-agent/current/skills/flow/guides/pr.md 대로 PR 을 만듭니다' },
});
function subagentCase(name, { parent, agent, agentDir = '', agentId = 'a1b2c3', sessionId = 'sub-sess', runParentFirst = false }, wantDeny) {
  const home = mkdtempSync(join(tmpdir(), 'flow-entry-'));
  try {
    const projDir = join(home, 'projects', 'p');
    mkdirSync(projDir, { recursive: true });
    const parentFile = join(projDir, `${sessionId}.jsonl`);
    writeFileSync(parentFile, parent.map(l => l + '\n').join(''));
    if (agent) {
      const dir = join(projDir, sessionId, 'subagents', agentDir);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `agent-${agentId}.jsonl`), agent.map(l => l + '\n').join(''));
    }
    if (runParentFirst) {
      const p = runHook(home, parentFile, PR, sessionId);
      check(`${name}: 상위 세션은 통과`, !/플로우 진입 · 차단/.test(p.stdout || ''), (p.stdout || '').slice(0, 160));
    }
    const res = runHook(home, parentFile, PR, sessionId, agentId);
    const denied = /"permissionDecision":"deny"/.test(res.stdout || '') && /플로우 진입 · 차단/.test(res.stdout || '');
    check(name, denied === wantDeny, (res.stdout || '').slice(0, 160));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
subagentCase('서브에이전트가 가이드를 읽으면 PR 생성 통과', { parent: [OTHER], agent: [PROMPT_WITH_PATH, READ_PR_GUIDE] }, false);
subagentCase('셸 명령으로만 가이드를 연 서브에이전트는 막는다 (#1116)', { parent: [OTHER], agent: [PROMPT_WITH_PATH, BASH_GUIDE, FIXTURE_EDIT] }, true);
subagentCase('워크플로 하위 디렉토리의 서브에이전트도 자기 기록으로 통과',
  { parent: [OTHER], agent: [READ_GUIDE], agentDir: join('workflows', 'wf_1') }, false);
subagentCase('가이드를 읽지 않은 서브에이전트의 PR 생성은 막는다', { parent: [OTHER], agent: [OTHER] }, true);
subagentCase('위임 문구에 가이드 경로만 있는 서브에이전트는 막는다', { parent: [OTHER], agent: [PROMPT_WITH_PATH, OTHER] }, true);
// 서브에이전트 기록이 상위보다 길면, 캐시를 같이 쓸 때 상위의 읽은 위치 · 판정이 서브에이전트 판정으로 넘어간다.
subagentCase('상위만 읽은 서브에이전트는 막는다 (같은 세션 캐시와 섞이지 않는다)',
  { parent: [READ_GUIDE], agent: [OTHER, OTHER, OTHER, OTHER, OTHER], runParentFirst: true }, true);
subagentCase('압축 전에만 읽은 서브에이전트는 막는다', { parent: [OTHER], agent: [READ_GUIDE, COMPACT, OTHER] }, true);
subagentCase('서브에이전트 기록을 찾지 못하면 상위 기록으로 본다: 상위 미독은 차단', { parent: [OTHER] }, true);
subagentCase('서브에이전트 기록을 찾지 못하면 상위 기록으로 본다: 상위 읽음은 통과', { parent: [READ_GUIDE] }, false);
subagentCase('경로 조각이 든 식별자는 쓰지 않고 상위 기록으로 본다',
  { parent: [OTHER], agent: [READ_GUIDE], agentId: '..' }, true);

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
