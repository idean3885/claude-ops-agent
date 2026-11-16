#!/usr/bin/env node
/**
 * selftest-push-delegation.mjs — 대화창 위임(「푸시 권한 위임」) 자체 점검 (#1046).
 *
 * 실제 훅 두 개(사용자 입력 훅 · 도구 실행 전 훅)와 실제 git 레포로 돈다. 임시 HOME 을 써서
 * 사용자의 개방 마커 · 위임 기록을 건드리지 않고 네트워크도 쓰지 않는다.
 *
 * 사용: node scripts/selftest-push-delegation.mjs
 * 종료 코드: 실패 1, 전부 통과 0
 */
import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { delegationPath } from './push-delegation.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const preHook = join(here, 'pre-tool-use.mjs');
const promptHook = join(here, 'push-delegation-prompt.mjs');
const PHRASE = '푸시 권한 위임';
const SID = 'selftest-session';
let failed = 0;
let count = 0;

const ENV = home => ({
  ...process.env, HOME: home,
  OPS_AGENT_ACTION_GATE_ALLOW: '', OPS_AGENT_CLUSTER_WRITE_ALLOW: '', OPS_AGENT_ACTION_GATE_DISABLE: '',
  OPS_AGENT_FINAL_CHECK_DISABLE: '1', OPS_AGENT_FLOW_ENTRY_DISABLE: '1',
});

// 기본 브랜치가 main 인 임시 레포. decl 이 null 이면 선언 없음
function makeRepo(home, name, decl) {
  const repo = join(home, name);
  mkdirSync(repo, { recursive: true });
  spawnSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
  spawnSync('git', ['-C', repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  if (decl !== null) {
    mkdirSync(join(repo, '.ops-agent'));
    writeFileSync(join(repo, '.ops-agent', 'repo-type.json'), decl);
  }
  return repo;
}

function prompt(home, repo, text, sid = SID) {
  const r = spawnSync('node', [promptHook], {
    input: JSON.stringify({ prompt: text, session_id: sid, cwd: repo, hook_event_name: 'UserPromptSubmit' }),
    encoding: 'utf8', env: ENV(home),
  });
  return r.stdout || '';
}

function tool(home, repo, toolName, toolInput, sid = SID) {
  const r = spawnSync('node', [preHook], {
    input: JSON.stringify({ tool_name: toolName, cwd: repo, session_id: sid, tool_input: toolInput }),
    encoding: 'utf8', env: ENV(home),
  });
  try {
    const hs = JSON.parse((r.stdout || '').trim()).hookSpecificOutput;
    if (hs && hs.permissionDecision === 'deny') return { got: 'deny', reason: hs.permissionDecisionReason || '' };
  } catch { /* 출력 없음 = 통과 */ }
  return { got: 'pass', reason: '' };
}

function check(name, ok, detail = '') {
  count++;
  if (!ok) failed++;
  console.log(`${ok ? '  OK' : '  XX'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const DECL = '{"type": "work", "allow": ["git-default-push"]}';
const PUSH = { command: 'git push origin main' };

// 각 케이스는 새 HOME 에서 돈다. setup 이 위임을 열고, run 이 판정을 본다.
function scenario(name, fn) {
  const home = mkdtempSync(join(tmpdir(), 'push-deleg-'));
  try { fn(home); } finally { rmSync(home, { recursive: true, force: true }); }
}

// 1. 여는 조건
scenario('선언 + 문장', home => {
  const repo = makeRepo(home, 'a', DECL);
  const out = prompt(home, repo, PHRASE);
  check('선언 + 문장 → 열림 안내', out.includes('열림'), out.trim().split('\n')[0]);
  check('선언 + 문장 → 기본 브랜치 push 통과', tool(home, repo, 'Bash', PUSH).got === 'pass');
  check('앞뒤 공백 · 줄바꿈은 같은 문장', (() => { prompt(home, repo, `  ${PHRASE}\n`); return existsSync(delegationPath(SID, home)); })());
});
scenario('문장 없이', home => {
  const repo = makeRepo(home, 'a', DECL);
  check('선언만 있고 문장 없음 → push 차단', tool(home, repo, 'Bash', PUSH).got === 'deny');
  const r = tool(home, repo, 'Bash', PUSH);
  check('차단 안내에 호출 문장을 싣는다', r.reason.includes(PHRASE));
});
scenario('문장이 메시지의 일부', home => {
  const repo = makeRepo(home, 'a', DECL);
  prompt(home, repo, `${PHRASE} 해 주세요`);
  prompt(home, repo, `로그:\n${PHRASE}\n끝`);
  prompt(home, repo, '푸시권한위임');
  check('문장 중간 · 붙여 넣은 글 속 · 띄어쓰기 다름 → 열지 않음', !existsSync(delegationPath(SID, home)));
  check('→ push 차단 유지', tool(home, repo, 'Bash', PUSH).got === 'deny');
});
scenario('선언 없는 레포', home => {
  const repo = makeRepo(home, 'a', null);
  const out = prompt(home, repo, PHRASE);
  check('선언 없음 → 열지 않음 안내', out.includes('열지 않음'));
  check('선언 없음 → 기록 없음', !existsSync(delegationPath(SID, home)));
  check('선언 없음 → 차단 안내에 문장을 싣지 않는다', !tool(home, repo, 'Bash', PUSH).reason.includes(PHRASE));
});
scenario('선언에 다른 갈래', home => {
  const repo = makeRepo(home, 'a', '{"type": "storage", "allow": ["all", "git-force"]}');
  prompt(home, repo, PHRASE);
  check('all · git-force 선언은 무시 → 기록 없음', !existsSync(delegationPath(SID, home)));
  check('→ force push 차단', tool(home, repo, 'Bash', { command: 'git push --force origin main' }).got === 'deny');
});

// 2. 열린 범위
scenario('범위', home => {
  const repo = makeRepo(home, 'a', DECL);
  const other = makeRepo(home, 'b', DECL);
  prompt(home, repo, PHRASE);
  check('force push 는 계속 차단', tool(home, repo, 'Bash', { command: 'git push --force origin main' }).got === 'deny');
  check('원격 브랜치 삭제는 계속 차단', tool(home, repo, 'Bash', { command: 'git push origin --delete feat/1' }).got === 'deny');
  check('reset --hard 는 계속 차단', tool(home, repo, 'Bash', { command: 'git reset --hard HEAD~1' }).got === 'deny');
  check('다른 세션은 차단', tool(home, repo, 'Bash', PUSH, 'other-session').got === 'deny');
  check('같은 세션 · 선언한 다른 레포는 차단', tool(home, other, 'Bash', PUSH).got === 'deny');
  check('cd 로 다른 레포에 들어가 push 는 차단', tool(home, repo, 'Bash', { command: `cd ${other} && git push origin main` }).got === 'deny');
  check('동거: 조회 뒤 push 는 차단', tool(home, repo, 'Bash', { command: 'git log -1\ngit push origin main' }).got === 'deny');
});

// 3. 닫힘
scenario('만료', home => {
  const repo = makeRepo(home, 'a', DECL);
  prompt(home, repo, PHRASE);
  const p = delegationPath(SID, home);
  const rec = JSON.parse(readFileSync(p, 'utf8'));
  check('기록 만료는 8시간 뒤', Math.abs(rec.expiresAt - Date.now() - 8 * 3600 * 1000) < 60000);
  writeFileSync(p, JSON.stringify({ ...rec, expiresAt: Date.now() - 1 }));
  check('만료 뒤 push 차단', tool(home, repo, 'Bash', PUSH).got === 'deny');
});
scenario('선언 철회', home => {
  const repo = makeRepo(home, 'a', DECL);
  prompt(home, repo, PHRASE);
  writeFileSync(join(repo, '.ops-agent', 'repo-type.json'), '{"type": "work"}');
  check('선언을 지우면 위임도 닫힘', tool(home, repo, 'Bash', PUSH).got === 'deny');
});

// 4. 어시스턴트는 기록을 쓰지 못한다
scenario('기록 편집 차단', home => {
  const repo = makeRepo(home, 'a', DECL);
  const p = delegationPath(SID, home);
  check('Write 차단', tool(home, repo, 'Write', { file_path: p, content: '{}' }).got === 'deny');
  check('Edit 차단', tool(home, repo, 'Edit', { file_path: p, old_string: 'a', new_string: 'b' }).got === 'deny');
  check('Bash 리다이렉트 차단', tool(home, repo, 'Bash', { command: `echo '{}' > ${p}` }).got === 'deny');
  check('Bash tee 차단', tool(home, repo, 'Bash', { command: `echo '{}' | tee ${p}` }).got === 'deny');
  check('읽기는 통과', tool(home, repo, 'Bash', { command: `cat ${p}` }).got === 'pass');
});

// 5. 자율 위임 알림 훅은 위임 문장에 반응하지 않는다 (#1048)
const autonomyHook = join(here, '..', 'hooks', 'autonomy-prompt.sh');
const autonomy = text => {
  const home = mkdtempSync(join(tmpdir(), 'push-deleg-auto-'));
  const r = spawnSync('bash', [autonomyHook], { input: JSON.stringify({ prompt: text }), encoding: 'utf8', env: ENV(home) });
  rmSync(home, { recursive: true, force: true });
  return (r.stdout || '').includes('자율 위임 감지');
};
check('자율 위임 알림: 위임 문장 단독은 조용', !autonomy(PHRASE) && !autonomy(`  ${PHRASE}\n`));
check('자율 위임 알림: 기존 위임 문구는 그대로 알림', autonomy('자율 진행합니다') && autonomy('위임합니다') && autonomy(`${PHRASE} 하고 진행`));

console.log(failed ? `\n실패 ${failed}건` : `\n${count}건 전부 통과`);
process.exit(failed ? 1 : 0);
