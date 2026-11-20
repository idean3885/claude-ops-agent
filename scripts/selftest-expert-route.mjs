#!/usr/bin/env node
/**
 * selftest-expert-route.mjs — 전문가 경유 지표 자체 점검 (#1154, ADR-0043 결정 2).
 *
 * `pre-tool-use.mjs` 를 고쳤으면 이것을 돌린다. 경유 지표는 기록만 하고 막지 않아 판정이 무너져도 신호가 없다.
 * 특히 메인 세션이 스스로 쓴 판정 표식이나 전문가 파일을 직접 읽은 것을 「경유」로 세면, 고치려던 원인(메인 단독 판정)이
 * 남은 채로 통과 기준 「누락 0건」이 채워진다.
 *
 * 임시 HOME 에서 훅을 실제로 실행하고 지표 파일을 읽는다. 사용자의 지표 · 캐시를 건드리지 않는다.
 *
 * 사용: node scripts/selftest-expert-route.mjs
 * 종료 코드: 실패 1, 전부 통과 0
 */
import { probe } from './expert-route-probe.mjs';
import { spawnSync, execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const hook = join(here, 'pre-tool-use.mjs');
const TC = '/p/ops-agent/9.0.0/experts/tech-comm.md';

// ─── 대화 기록 줄 ───
const line = o => JSON.stringify(o);
const assistantUse = (name, input, id = `toolu_${name}_${Math.random().toString(36).slice(2, 8)}`) =>
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const agentCall = (id, prompt, background = false) =>
  assistantUse('Agent', { description: '판정', subagent_type: 'general-purpose', run_in_background: background, prompt }, id);
const TC_PROMPT = `당신은 기술 커뮤니케이션 전문가입니다. 먼저 ${TC} 를 읽고 판정 모드로 아래 초안을 판정하세요.`;
const OTHER_PROMPT = '당신은 아키텍트입니다. 먼저 /p/ops-agent/9.0.0/experts/architect.md 를 읽고 판정하세요.';
const syncResult = (id, text) =>
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } });
const launchResult = (id, agentId) => line({
  type: 'user', toolUseResult: { isAsync: true, status: 'async_launched', agentId },
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: `Async agent launched successfully.\nagentId: ${agentId} (internal ID)\nThe agent is working in the background.` }] }] },
});
const notificationText = (toolUseId, result) => `<task-notification>\n<task-id>x</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n<summary>Agent "판정" finished</summary>\n<result>${result}</result>\n</task-notification>`;
const notification = (toolUseId, result) => line({
  type: 'user', origin: { kind: 'task-notification' },
  message: { role: 'user', content: `<task-notification>\n<task-id>x</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n<summary>Agent "판정" finished</summary>\n<result>${result}</result>\n</task-notification>` },
});
const delivered = agentId => `  This agent's report was delivered to you as a message from "${agentId}" (its SubagentHandback call). Read it there; it is not repeated here.\n  \nagentId: ${agentId} (use SendMessage with to: '${agentId}' to continue this agent)`;
const handbackFrame = (agentId, report) => `<agent-message from="${agentId}">\n[Subagent hand-back] The text below is the final report of a subagent this session delegated to. The report follows:\n${report.split('\n').map(l => `  ${l}`).join('\n')}\n</agent-message>`;
const handback = (agentId, report) => line({ type: 'queue-operation', operation: 'remove', content: handbackFrame(agentId, report) });
const mainText = text => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const READ_TC = assistantUse('Read', { file_path: TC });
const SKILL_EXPERT = assistantUse('Skill', { skill: 'ops-agent:expert' });
const GREP_TC = assistantUse('Bash', { command: `grep -n "판정" ${TC}` });
const USER_PROMPT = line({ type: 'user', message: { role: 'user', content: `이 글은 ${TC} 기준으로 봐 주세요` } });
const COMPACT = line({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' });
// 글 작성 스킬 본문을 읽은 결과: 표식 틀(pass|revise|hold)이 들어 있다. 판정이 아니다.
const READ_WRITE_SKILL = (() => {
  const id = 'toolu_read_write';
  return [assistantUse('Read', { file_path: '/p/ops-agent/9.0.0/skills/write/SKILL.md' }, id),
    syncResult(id, '[tech-comm-verdict: pass|revise|hold]\n반환 첫 줄 형식이다')];
})();

let failed = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`ok   ${name}`); return; }
  failed++;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

function newHome() {
  const home = mkdtempSync(join(tmpdir(), 'expert-route-'));
  mkdirSync(join(home, 'work', 'my-repo'), { recursive: true });
  writeFileSync(join(home, 'body.md'), '## 요약\n\n첫 줄\n둘째 줄\n셋째 줄\n');
  writeFileSync(join(home, 'work', 'my-repo', 'm.graphql'), 'mutation($id: ID!) { addComment(input: {subjectId: $id, body: "hi"}) { clientMutationId } }');
  writeFileSync(join(home, 'review.json'), JSON.stringify({ body: '가\n나\n다', path: 'a.md', line: 1 }));
  return home;
}

function runHook(home, { tool = 'Bash', input, transcript, session = 's1', agentId, env = {} }) {
  const payload = { tool_name: tool, tool_input: input, session_id: session, cwd: join(home, 'work', 'my-repo') };
  if (transcript) payload.transcript_path = transcript;
  if (agentId) { payload.agent_id = agentId; payload.agent_type = 'general-purpose'; }
  return spawnSync('node', [hook], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      OPS_AGENT_CONFIDENTIAL_DISABLE: '',
      OPS_AGENT_WHAT_GUARD_DISABLE: '1',
      OPS_AGENT_ACTION_GATE_DISABLE: '1',
      OPS_AGENT_FINAL_CHECK_DISABLE: '1',
      OPS_AGENT_FLOW_ENTRY_DISABLE: '1',
      OPS_AGENT_EXPERT_ROUTE_DISABLE: '',
      ...env,
    },
  });
}

const metricsDir = home => join(home, '.claude', 'ops-agent', 'metrics');
function records(home) {
  const dir = metricsDir(home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => /^expert-route-\d{4}-\d{2}\.jsonl$/.test(f))
    .flatMap(f => readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)));
}

const PR_CREATE = 'gh pr create --draft --base main --title "문서 구조 변경" --body-file body.md';

// 한 케이스 = 새 HOME · 새 세션. lines 를 대화 기록으로 쓰고 PR 생성을 실행한 뒤 마지막 기록을 본다.
function scenario(name, lines, want, opts = {}) {
  const home = newHome();
  try {
    const transcript = join(home, 'transcript.jsonl');
    writeFileSync(transcript, lines.map(l => l + '\n').join(''));
    const res = runHook(home, { input: { command: opts.command || PR_CREATE }, transcript, ...opts });
    check(`${name}: 가드 내부 오류 없음`, !/가드 내부 오류/.test(res.stdout || ''), (res.stdout || '').slice(0, 200));
    const recs = records(home);
    if (want === null) { check(name, recs.length === 0, `기록 ${JSON.stringify(recs)}`); return; }
    const last = recs[recs.length - 1] || {};
    const diff = Object.entries(want).filter(([k, v]) => last[k] !== v);
    check(name, recs.length === 1 && diff.length === 0, `받은 값 ${JSON.stringify(last)}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// ─── 경유 판정 ───
scenario('흔적이 없으면 누락', [USER_PROMPT.replace(TC, '문서')],
  { verdict: 'missed', trace: 'none', surface: 'pr-create', stale: false, scope: 'self' });
scenario('전문가 호출 결과 첫 줄이 판정 표식이면 경유 (동기 결과)',
  [agentCall('t1', TC_PROMPT), syncResult('t1', '[tech-comm-verdict: pass]\n결론: 보내도 됩니다')],
  { verdict: 'via', trace: 'agent', stale: false });
scenario('보류 · 수정 판정도 경유다',
  [agentCall('t1', TC_PROMPT), syncResult('t1', '[tech-comm-verdict: hold]\n근거 부족')],
  { verdict: 'via', trace: 'agent' });
scenario('백그라운드 호출은 완료 알림의 결과 첫 줄로 본다',
  [agentCall('t1', TC_PROMPT, true), launchResult('t1', 'agA'), notification('t1', '[tech-comm-verdict: revise]\n세 곳을 고친다')],
  { verdict: 'via', trace: 'agent' });
scenario('결과를 넘김(SubagentHandback)으로 받으면 넘긴 보고의 첫 줄로 본다',
  [agentCall('t1', TC_PROMPT), syncResult('t1', delivered('agB')), handback('agB', '[tech-comm-verdict: pass]\n결론')],
  { verdict: 'via', trace: 'agent' });
scenario('백그라운드 호출 + 넘김 보고도 경유',
  [agentCall('t1', TC_PROMPT, true), launchResult('t1', 'agC'), notification('t1', delivered('agC').trim()), handback('agC', '[tech-comm-verdict: pass]')],
  { verdict: 'via', trace: 'agent' });
scenario('전문가 호출이 표식 없이 끝나면 누락 (흔적은 agent)',
  [agentCall('t1', TC_PROMPT), syncResult('t1', '결론: 좋습니다\n[tech-comm-verdict: pass]')],
  { verdict: 'missed', trace: 'agent' });
scenario('표식 값이 셋 밖이면 판정이 아니다',
  [agentCall('t1', TC_PROMPT), syncResult('t1', '[tech-comm-verdict: maybe]')],
  { verdict: 'missed', trace: 'agent' });
scenario('메인 텍스트의 표식은 세지 않는다 (호출 결과에 표식 없음)',
  [agentCall('t1', TC_PROMPT), syncResult('t1', '결론만'), mainText('[tech-comm-verdict: pass]\n전문가 판정을 옮깁니다')],
  { verdict: 'missed', trace: 'agent' });
scenario('메인 텍스트에만 표식이 있으면 경유가 아니다',
  [mainText('[tech-comm-verdict: pass]')],
  { verdict: 'missed', trace: 'none' });
scenario('다른 전문가 호출의 결과 표식은 세지 않는다',
  [agentCall('t1', OTHER_PROMPT), syncResult('t1', '[tech-comm-verdict: pass]')],
  { verdict: 'missed', trace: 'none' });
// 후보 줄 필터(경로 · 표식 글자)를 통과하는 프롬프트여도 전문가 파일을 가리키지 않으면 전문가 호출이 아니다
const MARKER_PROMPT = '당신은 리뷰어입니다. 반환 첫 줄에 [tech-comm-verdict: pass] 형식으로 판정을 쓰세요.';
scenario('표식 형식을 프롬프트에 적은 다른 에이전트 결과는 세지 않는다',
  [agentCall('t1', MARKER_PROMPT), syncResult('t1', '[tech-comm-verdict: pass]')],
  { verdict: 'missed', trace: 'none' });
scenario('표식 형식을 프롬프트에 적은 다른 에이전트의 백그라운드 결과도 세지 않는다',
  [agentCall('t1', MARKER_PROMPT, true), launchResult('t1', 'agE'), notification('t1', '[tech-comm-verdict: pass]')],
  { verdict: 'missed', trace: 'none' });
scenario('다른 에이전트의 넘김 보고 표식은 세지 않는다',
  [agentCall('t1', OTHER_PROMPT), syncResult('t1', delivered('agD')), handback('agD', '[tech-comm-verdict: pass]')],
  { verdict: 'missed', trace: 'none' });
scenario('전문가 파일을 직접 읽기만 하면 판정 불가 (인라인)',
  [READ_TC, mainText('판정: 통과')],
  { verdict: 'unknown', trace: 'read', reason: 'inline' });
scenario('전문가 스킬만 부르면 판정 불가 (어느 전문가인지 모름)',
  [SKILL_EXPERT],
  { verdict: 'unknown', trace: 'skill', reason: 'expert-unspecified' });
scenario('사용자 발화 · grep 으로만 경로가 나오면 흔적이 아니다',
  [USER_PROMPT, GREP_TC],
  { verdict: 'missed', trace: 'none' });
scenario('글 작성 스킬의 표식 틀(pass|revise|hold)은 판정이 아니다',
  READ_WRITE_SKILL,
  { verdict: 'missed', trace: 'none' });
scenario('경유 뒤 압축이 있었으면 afterCompact',
  [agentCall('t1', TC_PROMPT), syncResult('t1', '[tech-comm-verdict: pass]'), COMPACT],
  { verdict: 'via', afterCompact: true });
scenario('대화 기록이 없으면 판정 불가', [], { verdict: 'unknown', reason: 'no-transcript', trace: 'none' },
  { transcript: '/nonexistent/transcript.jsonl' });
scenario('대화 기록 경로가 없는 호출(자체 점검 · 수동 실행)은 세지 않는다', [], null, { transcript: '' });
scenario('예산이 모자라면 판정 불가', [agentCall('t1', TC_PROMPT), syncResult('t1', '[tech-comm-verdict: pass]')],
  { verdict: 'unknown', reason: 'budget' }, { env: { OPS_AGENT_HOOK_BUDGET_MS: '200' } });

// ─── 직전 쓰기보다 앞선 흔적 ───
{
  const home = newHome();
  try {
    const transcript = join(home, 'transcript.jsonl');
    writeFileSync(transcript, [agentCall('t1', TC_PROMPT), syncResult('t1', '[tech-comm-verdict: pass]')].map(l => l + '\n').join(''));
    runHook(home, { input: { command: PR_CREATE }, transcript });
    appendFileSync(transcript, mainText('PR 을 만들었습니다') + '\n');
    runHook(home, { input: { command: 'gh pr edit 12 --body-file body.md' }, transcript });
    let recs = records(home);
    check('첫 쓰기는 경유', recs[0] && recs[0].verdict === 'via' && recs[0].stale === false, JSON.stringify(recs[0]));
    check('직전 쓰기보다 앞선 흔적만 있으면 누락 · stale', recs[1] && recs[1].verdict === 'missed' && recs[1].stale === true
      && recs[1].trace === 'agent' && recs[1].surface === 'pr-edit', JSON.stringify(recs[1]));
    appendFileSync(transcript, [agentCall('t2', TC_PROMPT), syncResult('t2', '[tech-comm-verdict: revise]')].map(l => l + '\n').join(''));
    runHook(home, { input: { command: 'gh pr edit 12 --body-file body.md' }, transcript });
    recs = records(home);
    check('새 판정 뒤 쓰기는 다시 경유', recs[2] && recs[2].verdict === 'via' && recs[2].stale === false, JSON.stringify(recs[2]));
    // 막힌 쓰기는 흔적을 소비하지 않는다
    appendFileSync(transcript, [agentCall('t3', TC_PROMPT), syncResult('t3', '[tech-comm-verdict: pass]')].map(l => l + '\n').join(''));
    const denied = runHook(home, { input: { command: 'gh pr create --base main --title x --body-file body.md' }, transcript });
    check('뒤 가드(초안 PR)에 막힌 쓰기는 기록하지 않는다', /deny/.test(denied.stdout || '') && records(home).length === 3, `${records(home).length}건`);
    runHook(home, { input: { command: PR_CREATE }, transcript });
    recs = records(home);
    check('막힌 쓰기는 흔적을 소비하지 않는다 (다시 만들면 경유)', recs[3] && recs[3].verdict === 'via' && recs[3].stale === false, JSON.stringify(recs[3]));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// ─── 서브에이전트 ───
function subagentCase(name, parentLines, ownLines, want) {
  const home = newHome();
  try {
    const transcript = join(home, 'proj', 'sess.jsonl');
    mkdirSync(join(home, 'proj', 'sess', 'subagents'), { recursive: true });
    writeFileSync(transcript, parentLines.map(l => l + '\n').join(''));
    if (ownLines) writeFileSync(join(home, 'proj', 'sess', 'subagents', 'agent-op1.jsonl'), ownLines.map(l => l + '\n').join(''));
    runHook(home, { input: { command: PR_CREATE }, transcript, session: 'sess', agentId: 'op1' });
    const last = records(home).slice(-1)[0] || {};
    const diff = Object.entries(want).filter(([k, v]) => last[k] !== v);
    check(name, diff.length === 0, `받은 값 ${JSON.stringify(last)}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
const VIA = [agentCall('t1', TC_PROMPT), syncResult('t1', '[tech-comm-verdict: pass]')];
subagentCase('서브에이전트는 자기 기록의 흔적을 먼저 본다', [], VIA, { verdict: 'via', scope: 'self', agent: 'op1' });
subagentCase('자기 기록에 흔적이 없으면 상위 기록을 본다', VIA, [mainText('PR 을 씁니다')], { verdict: 'via', scope: 'parent', agent: 'op1' });
subagentCase('둘 다 없으면 자기 기록 기준 누락', [], [mainText('PR 을 씁니다')], { verdict: 'missed', scope: 'self', trace: 'none' });
subagentCase('자기 기록을 못 찾으면 상위 기록으로 본다', VIA, null, { verdict: 'via', scope: 'parent' });
subagentCase('자기 기록의 흔적(직접 읽기)이 상위 기록의 경유보다 먼저다', VIA, [READ_TC], { verdict: 'unknown', scope: 'self', trace: 'read', reason: 'inline' });
// 상위 기록이 예산 안에 다 읽히지 않으면 누락이 아니라 판정 불가다. 흔적 후보 줄로 채운 큰 상위 기록으로 읽기를 늦춘다
{
  const home = newHome();
  try {
    const transcript = join(home, 'proj', 'sess.jsonl');
    mkdirSync(join(home, 'proj', 'sess', 'subagents'), { recursive: true });
    const slow = line({ type: 'user', message: { role: 'user', content: 'agentId: x' } }) + '\n';
    writeFileSync(transcript, VIA.map(l => l + '\n').join('') + slow.repeat(1200000));
    writeFileSync(join(home, 'proj', 'sess', 'subagents', 'agent-op1.jsonl'), mainText('PR 을 씁니다') + '\n');
    runHook(home, { input: { command: PR_CREATE }, transcript, session: 'sess', agentId: 'op1', env: { OPS_AGENT_HOOK_BUDGET_MS: '600' } });
    const last = records(home).slice(-1)[0] || {};
    check('상위 기록을 예산 안에 다 읽지 못하면 판정 불가(budget)', last.verdict === 'unknown' && last.reason === 'budget', JSON.stringify(last));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// ─── 표면 판별 ───
scenario('본문 줄 수를 남긴다', [], { surface: 'pr-create', bodyLines: 5 });
scenario('이슈 생성 어댑터는 issue-create', [],
  { surface: 'issue-create', bodyLines: 5 },
  { command: 'bash ~/.claude/ops-agent/current/scripts/gh-issue.sh create --title "x" --body-file body.md --type docs --no-start "백로그"' });
scenario('이슈 본문 편집은 issue-edit', [], { surface: 'issue-edit', bodyLines: 5 }, { command: 'gh issue edit 3 -R o/r -F body.md' });
scenario('PR 본문 편집은 pr-edit (본문 인자)', [], { surface: 'pr-edit', bodyLines: 2 }, { command: 'gh pr edit 3 --body "한 줄\n두 줄"' });
scenario('PR 제목만 편집은 기록하지 않는다', [], null, { command: 'gh pr edit 3 --title "새 제목"' });
scenario('이슈 제목만 편집은 기록하지 않는다', [], null, { command: 'gh issue edit 3 --title "새 제목"' });
// 댓글 · 리뷰도 기술 글이다 (ADR-0043 결정 1 · 2, 전문가 파일 「범위」 표 「이슈 · PR 본문과 댓글(리뷰 포함)」)
scenario('PR 댓글은 pr-comment', [], { surface: 'pr-comment', bodyLines: 5 }, { command: 'gh pr comment 3 --body-file body.md' });
scenario('이슈 댓글은 issue-comment', [], { surface: 'issue-comment', bodyLines: 2 }, { command: 'gh issue comment 3 -R o/r -b "한 줄\n두 줄"' });
scenario('댓글 고치기(마지막 댓글 편집)도 issue-comment', [], { surface: 'issue-comment' }, { command: 'gh issue comment 3 --edit-last --body "고친 댓글"' });
scenario('PR 리뷰 본문은 pr-review', [], { surface: 'pr-review', bodyLines: 5 }, { command: 'gh pr review 3 --comment --body-file body.md' });
scenario('PR 리뷰 본문 단축 인자(-b)도 pr-review', [], { surface: 'pr-review', bodyLines: 1 }, { command: 'gh pr review 3 --request-changes -b "고칠 곳"' });
scenario('본문 없는 리뷰(승인만)는 기록하지 않는다', [], null, { command: 'gh pr review 3 --approve' });
scenario('본문 없는 댓글 명령(마지막 댓글 삭제)은 기록하지 않는다', [], null, { command: 'gh pr comment 3 --delete-last --yes' });
scenario('gh api 이슈 · PR 댓글 작성은 api-comment', [], { surface: 'api-comment', bodyLines: 5 },
  { command: 'gh api repos/o/r/issues/3/comments -F body=@body.md' });
scenario('gh api 댓글 고치기(PATCH)는 api-comment', [], { surface: 'api-comment', bodyLines: 2 },
  { command: 'gh api -X PATCH repos/o/r/issues/comments/99 -f body="첫 줄\n둘째 줄"' });
scenario('gh api 리뷰 작성은 api-review', [], { surface: 'api-review', bodyLines: 1 },
  { command: 'gh api repos/o/r/pulls/3/reviews -f event=COMMENT -f body="리뷰 본문"' });
scenario('gh api 리뷰 댓글 작성(--input 본문)은 api-review', [], { surface: 'api-review', bodyLines: 3 },
  { command: 'gh api --method POST repos/o/r/pulls/3/comments --input review.json' });
scenario('gh api 리뷰 댓글 답글은 api-review', [], { surface: 'api-review' },
  { command: 'gh api repos/o/r/pulls/3/comments/7/replies -f body=네' });
scenario('gh api GraphQL 댓글 mutation 은 api-comment', [], { surface: 'api-comment' },
  { command: `gh api graphql -f query='mutation { addComment(input: {subjectId: "x", body: "y"}) { clientMutationId } }'` });
scenario('gh api GraphQL 리뷰 mutation 은 api-review', [], { surface: 'api-review' },
  { command: `gh api graphql -f query='mutation { addPullRequestReview(input: {pullRequestId: "x", body: "y"}) { clientMutationId } }'` });
scenario('gh api 댓글 읽기(GET)는 기록하지 않는다', [], null, { command: 'gh api repos/o/r/issues/3/comments' });
scenario('gh api 리뷰 읽기(-X GET)는 기록하지 않는다', [], null, { command: 'gh api -X GET repos/o/r/pulls/3/reviews -f per_page=100' });
scenario('gh api GraphQL 조회는 기록하지 않는다', [], null,
  { command: `gh api graphql -f query='query { repository(owner: "o", name: "r") { issue(number: 3) { comments(first: 5) { nodes { body } } } } }'` });
scenario('공유 표면이 아닌 명령은 기록하지 않는다', [], null, { command: 'gh pr view 3 --json body' });

// ─── 레포 문서: 범위 안 md 를 담은 커밋 (commit-md) ───
// 레포 문서는 초고 쓰기(Write · Edit)가 판정보다 먼저 온다. 그래서 「판정 뒤 보낸다」를 커밋 시점에 본다 (ADR-0043 결정 2).
// 변경 기록(CHANGELOG.md)은 커밋 메시지와 같은 장르라 범위 표 밖이다 (전문가 파일 「범위」 「다루지 않는다」).
function gitRepo(home) {
  const repo = join(home, 'work', 'my-repo');
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] });
  git('init', '-q');
  git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  writeFileSync(join(repo, 'seed.txt'), 'seed\n'); git('add', '.'); git('commit', '-q', '-m', 'seed');
  return { repo, git, stage: (rel, text) => { mkdirSync(dirname(join(repo, rel)), { recursive: true }); writeFileSync(join(repo, rel), text); git('add', rel); },
    commit: () => git('commit', '-q', '-m', 'x') };
}
function commitCase(name, fn) {
  const home = newHome();
  try {
    const transcript = join(home, 'transcript.jsonl');
    writeFileSync(transcript, '');
    fn({ home, transcript, r: gitRepo(home), add: lines => appendFileSync(transcript, lines.map(l => l + '\n').join('')) });
  } catch (e) {
    failed++; console.log(`FAIL ${name} — ${e.message}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
commitCase('md + 코드 커밋', ({ home, transcript, r, add }) => {
  add(VIA);
  r.stage('docs/guide.md', '# 안내\n\n첫 줄\n둘째 줄\n');
  r.stage('src/a.mjs', 'export {};\n');
  runHook(home, { input: { command: 'git commit -m "docs: 안내"' }, transcript });
  const recs = records(home);
  check('범위 안 md 가 든 커밋은 commit-md 로 기록하고 경유를 판정한다', recs.length === 1 && recs[0].surface === 'commit-md' && recs[0].verdict === 'via', JSON.stringify(recs));
  check('commit-md 의 bodyLines 는 md 의 추가 · 변경 줄 합(코드 줄은 세지 않는다)', recs[0] && recs[0].bodyLines === 4, JSON.stringify(recs[0]));
  check('commit-md 는 파일 경로를 남기지 않는다', recs[0] && !JSON.stringify(recs[0]).includes('guide'), JSON.stringify(recs[0]));
});
commitCase('변경 기록 변형 파일만 커밋', ({ home, transcript, r }) => {
  for (const f of ['changelog.md', 'CHANGELOG.ko.md', 'CHANGELOG.zh-Hant-TW.md', 'docs/CHANGELOG-v2.md', 'CHANGELOG.1.2.md', 'CHANGELOG.old.md', 'CHANGELOG-archive.md', 'changelog/1.2.0.md', 'changelogs/a.md', '.changeset/a.md', 'CHANGES.md', 'HISTORY.md', 'NEWS.md', 'RELEASES.md', 'RELEASE_NOTES.md']) r.stage(f, '* 항목\n');
  runHook(home, { input: { command: 'git commit -m "chore: 변경 기록"' }, transcript });
  check('언어 · 판 접미와 다른 이름의 변경 기록만 든 커밋은 기록하지 않는다', records(home).length === 0, JSON.stringify(records(home)));
  r.commit();
  r.stage('docs/changelog-guide.md', '# 변경 기록 쓰는 법\n');
  r.stage('docs/history.md', '# 설계 내력\n');
  r.stage('history-of.md', '# 내력\n');
  r.stage('changes-by-team.md', '# 팀별 변경\n');
  runHook(home, { input: { command: 'git commit -m "docs: 안내"' }, transcript });
  const recs = records(home);
  check('이름에 changelog 가 들어간 안내 문서 · 소문자 history · changes 문서는 레포 문서로 센다', recs.length === 1 && recs[0].bodyLines === 4, JSON.stringify(recs));
});
commitCase('셸로 읽지 못한 커밋', ({ home, transcript, r }) => {
  r.stage('docs/guide.md', '# 안내\n');
  runHook(home, { input: { command: 'git commit -m "unclosed' }, transcript });
  const recs = records(home);
  check('셸로 읽지 못한 커밋은 넉넉한 범위로 보아 스테이징된 md 를 센다', recs.length === 1 && recs[0].surface === 'commit-md', JSON.stringify(recs));
});
commitCase('판별 도구', ({ home, r }) => {
  r.stage('docs/guide.md', '# 안내\n\n첫 줄\n');
  const md = probe('git commit -m "docs: 안내"', r.repo, { HOME: home });
  check('판별 도구는 범위 안 md 커밋을 commit-md 와 본문 줄 수로 보인다', md.length === 1 && md[0].surface === 'commit-md' && md[0].bodyLines === 3, JSON.stringify(md));
  r.commit();
  r.stage('src/a.mjs', 'export {};\n');
  const code = probe('git commit -m "feat: x"', r.repo, { HOME: home });
  check('판별 도구는 코드만 든 커밋을 기록 없음으로 보인다', code.length === 0, JSON.stringify(code));
  const pr = probe('gh pr comment 1 --body "한 줄"', r.repo, { HOME: home });
  check('판별 도구는 gh 쓰기의 표면을 보인다', pr.length === 1 && pr[0].surface === 'pr-comment', JSON.stringify(pr));
});
commitCase('코드 · 변경 기록만 커밋', ({ home, transcript, r }) => {
  r.stage('CHANGELOG.md', '## [Unreleased]\n* 항목\n');
  r.stage('src/a.mjs', 'export {};\n');
  runHook(home, { input: { command: 'git commit -m "feat: x"' }, transcript });
  check('코드와 CHANGELOG.md 만 든 커밋은 기록하지 않는다', records(home).length === 0, JSON.stringify(records(home)));
  r.commit();
  r.stage('src/b.mjs', 'export {};\n');
  runHook(home, { input: { command: 'git commit -m "feat: y"' }, transcript });
  check('코드만 든 커밋은 기록하지 않는다', records(home).length === 0, JSON.stringify(records(home)));
});
commitCase('같은 판정 뒤 두 번째 md 커밋', ({ home, transcript, r, add }) => {
  add(VIA);
  r.stage('a.md', '가\n');
  runHook(home, { input: { command: 'git commit -m "docs: a"' }, transcript });
  r.commit();
  add([mainText('커밋했습니다')]);
  r.stage('b.md', '나\n다\n');
  runHook(home, { input: { command: 'cd ' + r.repo + ' && git commit -m "docs: b"' }, transcript });
  const recs = records(home);
  check('판정 뒤 첫 md 커밋은 경유', recs[0] && recs[0].verdict === 'via', JSON.stringify(recs[0]));
  check('같은 판정 뒤 두 번째 md 커밋은 누락 · stale', recs[1] && recs[1].surface === 'commit-md' && recs[1].verdict === 'missed' && recs[1].stale === true, JSON.stringify(recs[1]));
});
commitCase('커밋이 흔적을 소비한 뒤 PR 생성', ({ home, transcript, r, add }) => {
  add(VIA);
  r.stage('a.md', '가\n');
  runHook(home, { input: { command: 'git commit -m "docs: a"' }, transcript });
  r.commit();
  add([mainText('PR 을 만듭니다')]);
  runHook(home, { input: { command: PR_CREATE }, transcript });
  const recs = records(home);
  check('커밋이 흔적을 소비하면 PR 본문은 따로 판정받아야 경유 (없으면 누락 · stale)', recs[1] && recs[1].surface === 'pr-create' && recs[1].verdict === 'missed' && recs[1].stale === true, JSON.stringify(recs));
});
commitCase('-a 커밋', ({ home, transcript, r, add }) => {
  r.stage('a.md', '가\n'); r.commit();
  writeFileSync(join(r.repo, 'a.md'), '가\n나\n');
  add(VIA);
  runHook(home, { input: { command: 'git commit -am "docs: a"' }, transcript });
  const recs = records(home);
  check('-a 커밋은 스테이징 안 한 추적 md 변경도 본다', recs.length === 1 && recs[0].surface === 'commit-md' && recs[0].bodyLines === 1, JSON.stringify(recs));
});
commitCase('막힌 커밋', ({ home, transcript, r, add }) => {
  mkdirSync(join(home, '.claude', 'ops-agent'), { recursive: true });
  writeFileSync(join(home, '.claude', 'ops-agent', 'confidential-keywords.local.json'), JSON.stringify({ keywords: ['SELFTEST_SECRET_WORD'] }));
  add(VIA);
  r.stage('a.md', '가\n');
  const res = runHook(home, { input: { command: 'git commit -m "docs: SELFTEST_SECRET_WORD"' }, transcript });
  check('뒤 가드(대외비)에 막힌 커밋은 기록하지 않는다', /deny/.test(res.stdout || '') && records(home).length === 0, `${(res.stdout || '').slice(0, 120)} / ${records(home).length}건`);
  runHook(home, { input: { command: 'git commit -m "docs: a"' }, transcript });
  const recs = records(home);
  check('막힌 커밋은 흔적을 소비하지 않는다 (다시 커밋하면 경유)', recs.length === 1 && recs[0].verdict === 'via', JSON.stringify(recs));
});
commitCase('md Write · Edit', ({ home, transcript, r, add }) => {
  add(VIA);
  runHook(home, { tool: 'Write', input: { file_path: join(r.repo, 'doc.md'), content: '# 초고\n' }, transcript });
  runHook(home, { tool: 'Edit', input: { file_path: join(r.repo, 'doc.md'), old_string: '초고', new_string: '퇴고' }, transcript });
  check('레포 안 md 를 쓰는 Write · Edit 는 기록하지 않는다 (커밋 시점에 본다)', records(home).length === 0, JSON.stringify(records(home)));
  r.stage('doc.md', '# 퇴고\n');
  runHook(home, { input: { command: 'git commit -m "docs: doc"' }, transcript });
  const commitRec = records(home).filter(x => x.surface === 'commit-md');
  check('Write · Edit 는 흔적을 소비하지 않는다 (커밋이 경유)', commitRec.length === 1 && commitRec[0].verdict === 'via' && commitRec[0].stale === false, JSON.stringify(records(home)));
});

// ─── 한 호출의 여러 표면 (주장 검증 1회 차단 1) ───
// 표면마다 한 줄씩 남기고, 흔적은 앞 표면부터 소비한다. 첫 표면만 남기면 「커밋 && PR 생성」의 PR 본문 누락이 지표에서 사라진다.
commitCase('커밋 && PR 생성 한 호출', ({ home, transcript, r, add }) => {
  add(VIA);
  r.stage('d.md', 'x\n');
  runHook(home, { input: { command: 'git commit -m x && ' + PR_CREATE }, transcript });
  const recs = records(home);
  check('한 호출의 표면마다 한 줄: 커밋은 경유, 뒤의 PR 생성은 앞 표면이 소비해 누락 · stale',
    recs.length === 2 && recs[0].surface === 'commit-md' && recs[0].verdict === 'via'
    && recs[1].surface === 'pr-create' && recs[1].verdict === 'missed' && recs[1].stale === true, JSON.stringify(recs));
});
{
  const home = newHome();
  try {
    const transcript = join(home, 'transcript.jsonl');
    writeFileSync(transcript, VIA.map(l => l + '\n').join(''));
    runHook(home, { input: { command: 'gh pr comment 3 -b "가" && gh issue comment 4 -b "나\n다"' }, transcript });
    const recs = records(home);
    check('댓글 둘 한 호출: 표면마다 한 줄, 본문 줄 수도 표면마다', recs.length === 2 && recs[0].surface === 'pr-comment' && recs[0].bodyLines === 1
      && recs[1].surface === 'issue-comment' && recs[1].bodyLines === 2 && recs[1].verdict === 'missed' && recs[1].stale === true, JSON.stringify(recs));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// ─── 커밋에 담길 범위 (주장 검증 1회 권장 2) ───
commitCase('경로 지정 커밋', ({ home, transcript, r, add }) => {
  add(VIA);
  r.stage('a.md', '0\n'); r.commit();
  writeFileSync(join(r.repo, 'a.md'), '0\n1\n');
  runHook(home, { input: { command: 'git commit -m x a.md' }, transcript });
  const recs = records(home);
  check('경로 지정 커밋은 스테이징 안 한 그 경로의 md 를 본다', recs.length === 1 && recs[0].surface === 'commit-md' && recs[0].bodyLines === 1, JSON.stringify(recs));
});
commitCase('경로 지정 커밋(코드만)', ({ home, transcript, r, add }) => {
  add(VIA);
  r.stage('a.md', '0\n1\n'); r.stage('b.mjs', 'x\n');
  runHook(home, { input: { command: 'git commit -m x -- b.mjs' }, transcript });
  check('경로 지정 커밋이 코드만 담으면 스테이징된 md 가 있어도 기록하지 않는다', records(home).length === 0, JSON.stringify(records(home)));
});
commitCase('메시지 안의 -a', ({ home, transcript, r, add }) => {
  add(VIA);
  r.stage('a.md', '0\n'); r.commit();
  writeFileSync(join(r.repo, 'a.md'), '0\n1\n');
  r.stage('b.mjs', 'x\n');
  runHook(home, { input: { command: 'git commit -m "fix -a flag"' }, transcript });
  check('메시지 인자 안의 「 -a」는 -a 옵션이 아니다', records(home).length === 0, JSON.stringify(records(home)));
});
commitCase('git -c 설정 커밋', ({ home, transcript, r, add }) => {
  add(VIA);
  r.stage('d.md', 'x\n');
  runHook(home, { input: { command: 'git -c core.hooksPath=/dev/null commit -m x' }, transcript });
  const recs = records(home);
  check('git -c 설정이 붙은 커밋도 commit-md', recs.length === 1 && recs[0].surface === 'commit-md', JSON.stringify(recs));
});

// ─── 커밋 명령 모양 (주장 검증 2회 차단 3) ───
// 리다이렉션 · 파이프 · 히어닥 · 명령 대체 · 붙여 쓴 값을 경로 지정으로 읽으면 스테이징된 md 가 빠진다
for (const command of [
  'git commit -m x 2>&1',
  'git commit -m x 2>&1 | tail -3',
  'git commit -m x > /dev/null',
  'git commit -m x &>/dev/null',
  "git commit -q -F - <<'EOF'\ndocs: x\nEOF",
  "git commit -m \"$(cat <<'EOF'\ndocs: the \"quoted\" word\nEOF\n)\"",
  "git commit -m $'a b'",
  'git commit -m "$(printf \'%s\' "a b")"',
  'git commit --message="docs two words"',
  'git commit -m"docs two words"',
  "git commit -m x --author=\"A B <a@example.com>\"",
  '(cd . && git commit -m x)',
  'git -C . commit -m x',
]) {
  commitCase(`커밋 모양 ${JSON.stringify(command)}`, ({ home, transcript, r, add }) => {
    add(VIA);
    r.stage('d.md', 'x\n');
    runHook(home, { input: { command }, transcript });
    const recs = records(home);
    check(`스테이징된 md 를 담는 커밋은 모양과 무관하게 commit-md: ${JSON.stringify(command)}`,
      recs.length === 1 && recs[0].surface === 'commit-md' && recs[0].bodyLines === 1 && recs[0].verdict === 'via', JSON.stringify(recs));
  });
}
commitCase('커밋 둘 한 호출', ({ home, transcript, r, add }) => {
  r.stage('b.md', '0\n'); r.commit();
  add(VIA);
  r.stage('a.md', '가\n');
  writeFileSync(join(r.repo, 'b.md'), '0\n1\n');
  runHook(home, { input: { command: 'git commit -m x && git commit -a -m y' }, transcript });
  const recs = records(home);
  check('커밋 둘 한 호출(앞은 스테이징된 md, 뒤는 -a 로 추적 md): 커밋마다 한 줄, 뒤 커밋은 stale', recs.length === 2 && recs.every(x => x.surface === 'commit-md')
    && recs[0].verdict === 'via' && recs[1].verdict === 'missed' && recs[1].stale === true, JSON.stringify(recs));
});
commitCase('앞선 git add', ({ home, transcript, r, add }) => {
  add(VIA);
  writeFileSync(join(r.repo, 'new.md'), '가\n나\n');
  runHook(home, { input: { command: 'git add -A && git commit -m x' }, transcript });
  const recs = records(home);
  check('같은 명령 앞의 git add 가 담을 새 md 도 commit-md', recs.length === 1 && recs[0].surface === 'commit-md' && recs[0].bodyLines === 2, JSON.stringify(recs));
});
commitCase('대외비 가드 끔', ({ home, transcript, r, add }) => {
  add(VIA);
  r.stage('d.md', 'x\n');
  runHook(home, { input: { command: 'git commit -m x' }, transcript, env: { OPS_AGENT_CONFIDENTIAL_DISABLE: '1' } });
  check('대외비 가드를 끈 세션에서도 경유 지표는 기록한다', records(home).length === 1, JSON.stringify(records(home)));
});

// ─── 서브에이전트 한 호출의 둘째 표면 (주장 검증 2회 권장 4) ───
{
  const home = newHome();
  try {
    const transcript = join(home, 'proj', 'sess.jsonl');
    mkdirSync(join(home, 'proj', 'sess', 'subagents'), { recursive: true });
    writeFileSync(transcript, VIA.map(l => l + '\n').join(''));
    writeFileSync(join(home, 'proj', 'sess', 'subagents', 'agent-op1.jsonl'), mainText('댓글을 씁니다') + '\n');
    runHook(home, { input: { command: 'gh pr comment 3 -b x && gh issue comment 4 -b y' }, transcript, session: 'sess', agentId: 'op1' });
    const recs = records(home);
    check('서브에이전트: 상위 흔적을 앞 표면이 소비하면 둘째 표면은 상위 기준 누락 · stale',
      recs.length === 2 && recs[0].verdict === 'via' && recs[0].scope === 'parent'
      && recs[1].verdict === 'missed' && recs[1].trace === 'agent' && recs[1].stale === true && recs[1].scope === 'parent', JSON.stringify(recs));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// ─── 결과 없는 알림 · 보고 없는 넘김 틀 (주장 검증 2회 사소 10) ───
scenario('결과 없는 알림 뒤의 전문가 알림을 본다',
  [agentCall('o1', OTHER_PROMPT, true), agentCall('t1', TC_PROMPT, true),
    line({ type: 'user', message: { role: 'user', content: '<task-notification>\n<tool-use-id>o1</tool-use-id>\n<status>killed</status>\n</task-notification>\n'
      + notificationText('t1', '[tech-comm-verdict: pass]') } })],
  { verdict: 'via', trace: 'agent' });
scenario('보고 없는 넘김 틀 뒤의 전문가 넘김 틀을 본다',
  [agentCall('o1', OTHER_PROMPT), syncResult('o1', delivered('agO')), agentCall('t1', TC_PROMPT), syncResult('t1', delivered('agT')),
    line({ type: 'queue-operation', operation: 'remove', content: '<agent-message from="agO">\n안내만\n</agent-message>\n' + handbackFrame('agT', '[tech-comm-verdict: pass]') })],
  { verdict: 'via', trace: 'agent' });
scenario('결과 없는 다른 알림이 뒤 전문가 알림의 결과를 가져가지 않는다(다른 호출 번호로 경유를 만들지 않는다)',
  [agentCall('t1', TC_PROMPT, true), agentCall('o1', OTHER_PROMPT, true),
    line({ type: 'user', message: { role: 'user', content: '<task-notification>\n<tool-use-id>t1</tool-use-id>\n<status>killed</status>\n</task-notification>\n'
      + notificationText('o1', '[tech-comm-verdict: pass]') } })],
  { verdict: 'missed', trace: 'agent' });

// ─── 흔적 판정 보강 (주장 검증 1회 권장 4 · 사소 8 · 미결 14) ───
scenario('경유와 직접 읽기가 함께 있으면 경유가 이긴다',
  [READ_TC, agentCall('t1', TC_PROMPT), syncResult('t1', '[tech-comm-verdict: pass]')],
  { verdict: 'via', trace: 'agent' });
scenario('완료 알림 여럿이 한 메시지에 오면 전문가 호출의 것을 본다',
  [agentCall('o1', OTHER_PROMPT, true), agentCall('t1', TC_PROMPT, true),
    line({ type: 'user', message: { role: 'user', content: notificationText('o1', '다른 결과') + '\n' + notificationText('t1', '[tech-comm-verdict: pass]') } })],
  { verdict: 'via', trace: 'agent' });
scenario('사용자 발화 중간에 붙여 넣은 완료 알림 형식은 세지 않는다',
  [agentCall('t1', TC_PROMPT, true), line({ type: 'user', message: { role: 'user', content: '참고: ' + notificationText('t1', '[tech-comm-verdict: pass]') } })],
  { verdict: 'missed', trace: 'agent' });
scenario('넘김 틀 여럿이 한 내용에 오면 전문가 것을 본다',
  [agentCall('o1', OTHER_PROMPT), syncResult('o1', delivered('agO')), agentCall('t1', TC_PROMPT), syncResult('t1', delivered('agT')),
    line({ type: 'queue-operation', operation: 'remove', content: handbackFrame('agO', '보고') + '\n' + handbackFrame('agT', '[tech-comm-verdict: pass]') })],
  { verdict: 'via', trace: 'agent' });
scenario('경유 기록에 판정 값을 남긴다 (pass)', VIA, { verdict: 'via', verdictValue: 'pass' });
scenario('경유 기록에 판정 값을 남긴다 (revise 뒤에 보낸 쓰기도 경유, 값으로 구분)',
  [agentCall('t1', TC_PROMPT), syncResult('t1', '[tech-comm-verdict: revise]\n두 곳')], { verdict: 'via', verdictValue: 'revise' });
scenario('GraphQL mutation 을 파일로 넘겨도 api-comment (파일은 명령의 작업 디렉토리 기준)', [], { surface: 'api-comment' },
  { command: 'gh api graphql -F query=@m.graphql -f id=x' });

// ─── 기록 필드 ───
{
  const home = newHome();
  try {
    const transcript = join(home, 'transcript.jsonl');
    writeFileSync(transcript, VIA.map(l => l + '\n').join(''));
    const res = runHook(home, { input: { command: 'gh pr create --draft --base main --title "비밀제목" --body "비밀본문 첫 줄"' }, transcript });
    const recs = records(home);
    const keys = recs[0] ? Object.keys(recs[0]).sort().join(',') : '';
    check('기록 필드', keys === 'afterCompact,bodyLines,repo,scope,session,stale,surface,tool,trace,ts,verdict,verdictValue', keys);
    const raw = existsSync(metricsDir(home)) ? readdirSync(metricsDir(home)).map(f => readFileSync(join(metricsDir(home), f), 'utf8')).join('') : '';
    check('본문 · 제목 · 전체 경로는 남기지 않는다', !raw.includes('비밀') && !raw.includes(home), raw.slice(0, 200));
    check('repo 는 작업 디렉토리 basename', recs[0] && recs[0].repo === 'my-repo', JSON.stringify(recs[0]));
    check('달별 파일에 쌓는다', readdirSync(metricsDir(home)).some(f => /^expert-route-\d{4}-\d{2}\.jsonl$/.test(f)));
    check('기록이 판정을 바꾸지 않는다(차단 없음)', !/deny/.test(res.stdout || ''), (res.stdout || '').slice(0, 160));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// ─── 오버레이 ───
function withOverlay(body, fn) {
  const home = newHome();
  try {
    mkdirSync(join(home, '.claude', 'ops-agent'), { recursive: true });
    writeFileSync(join(home, '.claude', 'ops-agent', 'route-surfaces.local.json'), body);
    writeFileSync(join(home, 'transcript.jsonl'), '');
    return fn(home, join(home, 'transcript.jsonl'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
const OVERLAY = JSON.stringify({ surfaces: [
  { name: 'doc-page', tool: '^mcp__docs__update_page$', pattern: '"body"', body: 'body' },
  { name: 'doc-cli', tool: '^Bash$', pattern: '^doc-cli\\s+publish\\b' },
] });
withOverlay(OVERLAY, (home, transcript) => {
  runHook(home, { tool: 'mcp__docs__update_page', input: { page_id: '1', body: '가\n나\n다' }, transcript });
  runHook(home, { input: { command: 'doc-cli publish page.md' }, transcript });
  runHook(home, { tool: 'mcp__docs__get_page', input: { page_id: '1' }, transcript });
  runHook(home, { tool: 'mcp__docs__update_page', input: { page_id: '1', title: '제목만' }, transcript });
  const recs = records(home);
  check('오버레이 mcp 표면은 그 이름으로 남긴다', recs[0] && recs[0].surface === 'doc-page' && recs[0].tool === 'mcp__docs__update_page' && recs[0].bodyLines === 3, JSON.stringify(recs[0]));
  check('오버레이 Bash 표면은 그 이름으로 남긴다', recs[1] && recs[1].surface === 'doc-cli' && recs[1].verdict === 'missed', JSON.stringify(recs[1]));
  check('오버레이 패턴에 맞지 않는 호출은 기록하지 않는다', recs.length === 2, `${recs.length}건`);
});
withOverlay('{ "surfaces": [ 깨짐', (home, transcript) => {
  const res = runHook(home, { input: { command: PR_CREATE }, transcript });
  const recs = records(home);
  check('깨진 오버레이: 알림 한 줄', /전문가 경유 지표/.test(res.stdout || '') && /route-surfaces\.local\.json/.test(res.stdout || ''), (res.stdout || '').slice(0, 200));
  check('깨진 오버레이: 내장 표면은 그대로 기록', recs.length === 1 && recs[0].surface === 'pr-create', JSON.stringify(recs));
  const res2 = runHook(home, { tool: 'Read', input: { file_path: '/x' }, transcript });
  check('깨진 오버레이: Bash · mcp 가 아니면 읽지 않는다(알림 없음)', !/전문가 경유 지표/.test(res2.stdout || ''), (res2.stdout || '').slice(0, 200));
});
withOverlay(JSON.stringify({ surfaces: [{ name: 'bad', tool: '^mcp__', pattern: '(' }] }), (home, transcript) => {
  const res = runHook(home, { tool: 'mcp__docs__update_page', input: { body: 'x' }, transcript });
  check('정규식이 틀린 오버레이도 깨진 것으로 알린다', /전문가 경유 지표/.test(res.stdout || '') && records(home).length === 0, (res.stdout || '').slice(0, 200));
});

// ─── 판별 도구: 실제 세션과 같은 설정을 보는가 · CLI ───
// 도구는 HOME 을 바꾸지 않고 경유 지표 자리(OPS_AGENT_EXPERT_ROUTE_DIR)만 돌린다. HOME 을 바꾸면 명령 · git 설정의 `~` 와
// includeIf 조건이 다른 곳으로 풀려 훅과 다른 답을 내고, HOME 을 링크로 비추면 같은 이름의 사용자 파일을 덮어쓴다(#1155 주장 검증 7 · 8회차).
{
  const fakeHome = mkdtempSync(join(tmpdir(), 'probe-real-home-'));
  const env = { HOME: fakeHome };
  const snapshot = dir => {
    const out = [];
    const walk = d => { for (const n of readdirSync(d).sort()) { const f = join(d, n); try { if (statSync(f).isDirectory()) walk(f); else out.push(`${f.slice(fakeHome.length)}:${readFileSync(f, 'utf8')}`); } catch { out.push(`${f}:?`); } } };
    walk(dir);
    return out.join('\n');
  };
  try {
    const repo = join(fakeHome, 'work', 'probe-repo');
    mkdirSync(repo, { recursive: true });
    const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, HOME: fakeHome } });
    git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
    writeFileSync(join(repo, 'seed.txt'), 'seed\n'); git('add', '.'); git('commit', '-q', '-m', 'seed');
    writeFileSync(join(fakeHome, 'transcript.jsonl'), '사용자 파일\n');
    // 전역 gitignore(core.excludesFile, ~ 경로)가 가린 새 md
    writeFileSync(join(fakeHome, '.gitconfig'), '[core]\n\texcludesFile = ~/.gitignore_global\n');
    writeFileSync(join(fakeHome, '.gitignore_global'), 'scratch-*.md\n');
    writeFileSync(join(repo, 'scratch-note.md'), '# 메모\n');
    const hidden = probe('git add . && git commit -m x', repo, env);
    check('판별 도구는 사용자 전역 gitignore 를 따른다(가린 새 md 는 세지 않는다)', hidden.length === 0, JSON.stringify(hidden));
    // includeIf "gitdir:~/…" 조건도 사용자 HOME 기준으로 풀린다
    writeFileSync(join(fakeHome, '.gitconfig'), '[includeIf "gitdir:~/work/"]\n\tpath = ~/.gitconfig-work\n');
    writeFileSync(join(fakeHome, '.gitconfig-work'), '[core]\n\texcludesFile = ~/.gitignore_global\n');
    const cond = probe('git add . && git commit -m x', repo, env);
    check('판별 도구는 includeIf "gitdir:~/…" 조건을 사용자 HOME 기준으로 푼다', cond.length === 0, JSON.stringify(cond));
    rmSync(join(fakeHome, '.gitconfig'));
    const shown = probe('git add . && git commit -m x', repo, env);
    check('전역 gitignore 가 없으면 같은 새 md 를 센다(앞 검사의 대조)', shown.length === 1 && shown[0].surface === 'commit-md', JSON.stringify(shown));
    // 명령의 ~ 경로
    const tilde = probe('cd ~/work/probe-repo && git add . && git commit -m x', fakeHome, env);
    check('판별 도구는 명령의 ~ 를 사용자 HOME 으로 푼다', tilde.length === 1 && tilde[0].surface === 'commit-md', JSON.stringify(tilde));
    // 표면 오버레이
    mkdirSync(join(fakeHome, '.claude', 'ops-agent'), { recursive: true });
    writeFileSync(join(fakeHome, '.claude', 'ops-agent', 'route-surfaces.local.json'), OVERLAY);
    const ov = probe('doc-cli publish page.md', repo, env);
    check('판별 도구는 사용자 표면 오버레이를 따른다', ov.length === 1 && ov[0].surface === 'doc-cli', JSON.stringify(ov));
    // 사용자 HOME 무변경
    const before = snapshot(fakeHome);
    probe('gh pr comment 1 --body "한 줄"', repo, env);
    probe('git commit -m x', repo, env);
    check('판별 도구는 사용자 HOME 의 어떤 파일도 바꾸지 않는다(같은 이름의 transcript.jsonl 포함)', snapshot(fakeHome) === before);
    // 훅 실행 실패
    let threw = false;
    try { probe('gh pr comment 1 --body hi', repo, { ...env, NODE_OPTIONS: '--no-such-node-flag' }); } catch { threw = true; }
    check('훅을 실행하지 못하면 기록 없음이 아니라 실패로 알린다', threw);
    // CLI 종료 코드 · --repo
    const cli = (...a) => spawnSync('node', [join(dirname(hook), 'expert-route-probe.mjs'), ...a], { encoding: 'utf8', env: { ...process.env, HOME: fakeHome } });
    const c0 = cli('--repo', repo, '--', 'gh pr comment 1 --body "한 줄"');
    check('CLI: 기록 있음은 종료 0 과 표면 · 본문 줄 수', c0.status === 0 && /pr-comment/.test(c0.stdout) && /본문 1줄/.test(c0.stdout), `${c0.status} ${c0.stdout}`);
    const c1 = cli('--repo', repo, '--', 'ls');
    check('CLI: 기록 없음은 종료 1', c1.status === 1 && /기록 없음/.test(c1.stdout), `${c1.status} ${c1.stdout}`);
    const c2 = cli('--repo', join(fakeHome, 'no-such-repo'), '--', 'gh pr comment 1 --body hi');
    check('CLI: 없는 레포 경로는 종료 2', c2.status === 2, `${c2.status} ${c2.stderr}`);
    const c3 = cli('--repo', repo);
    check('CLI: 명령이 없으면 종료 2', c3.status === 2, `${c3.status}`);
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'only-here.md'), '# 여기만\n'); git('add', 'docs/only-here.md');
    const c4 = cli('--repo', repo, '--json', '--', 'git commit -m x');
    check('CLI: --repo 의 레포 상태로 센다', c4.status === 0 && JSON.parse(c4.stdout)[0]?.surface === 'commit-md', `${c4.status} ${c4.stdout}`);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
}

// ─── 비활성 · 무관 호출 ───
{
  const home = newHome();
  try {
    const transcript = join(home, 'transcript.jsonl');
    writeFileSync(transcript, '');
    runHook(home, { input: { command: PR_CREATE }, transcript, env: { OPS_AGENT_EXPERT_ROUTE_DISABLE: '1' } });
    check('OPS_AGENT_EXPERT_ROUTE_DISABLE=1 이면 기록하지 않는다', records(home).length === 0);
    runHook(home, { input: { command: 'ls' }, transcript });
    runHook(home, { tool: 'Read', input: { file_path: TC }, transcript });
    runHook(home, { tool: 'Write', input: { file_path: join(home, 'work', 'my-repo', 'tool.mjs'), content: 'export {};\n' }, transcript });
    runHook(home, { tool: 'Edit', input: { file_path: join(home, 'work', 'my-repo', 'tool.mjs'), old_string: 'export', new_string: 'export const a = 1;' }, transcript });
    runHook(home, { tool: 'mcp__docs__update_page', input: { body: 'x' }, transcript });
    check('무관 호출(셸 · 읽기 · 코드 파일 쓰기 · 오버레이 없는 mcp)은 지표 · 캐시 디렉토리를 만들지 않는다',
      !existsSync(metricsDir(home)) && !existsSync(join(home, '.claude', 'ops-agent', '.cache', 'expert-route')));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

console.log(failed ? `\n실패 ${failed}건` : '\n전부 통과');
process.exit(failed ? 1 : 0);
