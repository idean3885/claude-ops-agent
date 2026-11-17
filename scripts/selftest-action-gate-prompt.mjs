#!/usr/bin/env node
/**
 * selftest-action-gate-prompt.mjs — 대화창 게이트 개방(사용자 입력 훅) 자체 점검 (#1060).
 *
 * 실제 훅 두 개(사용자 입력 훅 · 도구 실행 전 훅)와 실제 개방 스크립트로 돈다. 임시 HOME 을 써서
 * 사용자의 개방 마커를 건드리지 않고 네트워크도 쓰지 않는다.
 *
 * 사용: node scripts/selftest-action-gate-prompt.mjs
 * 종료 코드: 실패 1, 전부 통과 0
 */
import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parseGatePrompt } from './action-gate-prompt.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const preHook = join(here, 'pre-tool-use.mjs');
const promptHook = join(here, 'action-gate-prompt.mjs');
const allowScript = join(here, 'action-gate-allow.sh');
let failed = 0;
let count = 0;

const ENV = home => ({
  ...process.env, HOME: home,
  OPS_AGENT_ACTION_GATE_ALLOW: '', OPS_AGENT_CLUSTER_WRITE_ALLOW: '', OPS_AGENT_ACTION_GATE_DISABLE: '',
  OPS_AGENT_FINAL_CHECK_DISABLE: '1', OPS_AGENT_FLOW_ENTRY_DISABLE: '1',
});

const marker = home => join(home, '.claude', 'ops-agent', '.cache', 'action-gate-allow.json');

function prompt(home, text) {
  const r = spawnSync('node', [promptHook], {
    input: JSON.stringify({ prompt: text, session_id: 'selftest', cwd: home, hook_event_name: 'UserPromptSubmit' }),
    encoding: 'utf8', env: ENV(home),
  });
  return r.stdout || '';
}

function tool(home, command) {
  const r = spawnSync('node', [preHook], {
    input: JSON.stringify({ tool_name: 'Bash', cwd: home, session_id: 'selftest', tool_input: { command } }),
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

function scenario(fn) {
  const home = mkdtempSync(join(tmpdir(), 'gate-prompt-'));
  try { fn(home); } finally { rmSync(home, { recursive: true, force: true }); }
}

const CMD = 'bash ~/.claude/ops-agent/current/scripts/action-gate-allow.sh';

// 1. 명령 한 줄 판정
console.log('1. 명령 한 줄 판정');
const accepts = [
  [`! ${CMD} on git-force`, 'on', 'git-force'],
  [`!${CMD} on git-force`, 'on', 'git-force'],
  [`${CMD} on git-force`, 'on', 'git-force'],
  [`  ! ${CMD} on worktree-destructive,git-force  `, 'on', 'worktree-destructive,git-force'],
  [`! ${CMD} off`, 'off', undefined],
];
for (const [text, action, scopes] of accepts) {
  const g = parseGatePrompt(text);
  check(`받음: ${text.trim()}`, g && g.action === action && g.scopes === scopes, JSON.stringify(g));
}
const rejects = [
  `게이트 열어 주세요 ! ${CMD} on git-force`,
  `! ${CMD} on git-force\n그리고 진행`,
  `! ${CMD} on git-force 60`,
  `! ${CMD} on git-force; rm -rf ~`,
  `! ${CMD} on git-force && echo hi`,
  `! ${CMD} status`,
  `! ${CMD} on`,
  `! bash ~/x/other.sh on git-force`,
  `! sh ${CMD.replace('bash ', '')} on git-force`,
];
for (const text of rejects) {
  check(`거절: ${text.replace(/\n/g, '⏎')}`, parseGatePrompt(text) === null);
}

// 2. 사용자 입력 훅이 마커를 쓴다
console.log('2. 사용자 입력 훅 실행');
scenario(home => {
  const out = prompt(home, `! ${CMD} on git-force`);
  const m = existsSync(marker(home)) ? readFileSync(marker(home), 'utf8') : '';
  check('명령 한 줄 → 마커에 그 갈래', /"scopes":\["git-force"\]/.test(m), m.trim());
  check('결과 줄을 컨텍스트에 낸다', out.includes('[게이트 개방]') && out.includes('git-force'));
  const st = spawnSync('bash', [allowScript, 'status'], { encoding: 'utf8', env: ENV(home) });
  check('status 가 열림으로 읽는다', /OPEN/.test(`${st.stdout}${st.stderr}`));
  prompt(home, `! ${CMD} off`);
  check('off 한 줄 → 마커 삭제', !existsSync(marker(home)));
});
scenario(home => {
  const out = prompt(home, `! ${CMD} on no-such-scope`);
  check('없는 갈래 → 마커 없음', !existsSync(marker(home)));
  check('없는 갈래 → 실패를 알린다', out.includes('실패'));
});
scenario(home => {
  const out = prompt(home, `게이트 열어 주세요 ! ${CMD} on git-force`);
  check('문장 속 명령 → 아무것도 하지 않는다', out === '' && !existsSync(marker(home)));
});
scenario(home => {
  const once = spawnSync('bash', [allowScript, 'on', 'git-force'], { encoding: 'utf8', env: ENV(home) });
  const viaTerminal = readFileSync(marker(home), 'utf8').replace(/"expiresAt":\d+/, '');
  spawnSync('bash', [allowScript, 'off'], { env: ENV(home) });
  prompt(home, `! ${CMD} on git-force`);
  const viaChat = readFileSync(marker(home), 'utf8').replace(/"expiresAt":\d+/, '');
  check('터미널로 연 마커와 모양이 같다', once.status === 0 && viaTerminal === viaChat, `${viaTerminal.trim()} / ${viaChat.trim()}`);
});

// 3. 어시스턴트가 게이트를 열지 못한다. 실행 형태를 가리지 않고 명령 글자로 막는다
console.log('3. 도구 실행 전 훅');
scenario(home => {
  const H = promptHook;
  const A = allowScript;
  for (const command of [
    `node ${H}`,
    `echo '{"prompt":"x"}' | node ${H}`,
    `${H}`,
    `env node ${H}`,
    `bash -c 'node ${H}'`,
    `echo x | xargs node ${H}`,
    `(node ${H})`,
    `node --check ${H}`,
    `bash ${A} on git-force`,
    `! bash ${A} on git-force`,
    `! bash ~/.claude/ops-agent/current/scripts/action-gate-allow.sh on repo-merge`,
    `bash ${A} 'on' git-force`,
    `bash ${A} "on" git-force`,
    `if true; then bash ${A} on git-force; fi`,
    `echo $(bash ${A} on git-force)`,
    `env OPS=1 bash ${A} on git-force`,
    `bash ${A} on`,
    `bash ${A} on; echo done`,
    `(bash ${A} on)`,
    `echo $(bash ${A} on)`,
    `bash ${A} on&& echo ok`,
    `bash ${A} on|cat`,
    `bash ${A} on>/dev/null`,
    `sh -c 'bash ${A} "on"'; true`,
    `bash ${A} 2>&1 on git-force`,
    `bash ${A} >/dev/null on git-force`,
    `bash ${A} </dev/null on git-force`,
    `bash ${A} 2>/dev/null on`,
    `bash ${A} $(echo on) git-force`,
    `cat > doc.md <<'EOF'\nbash ${A} on git-force\nEOF`,
    `git commit -m "안내: bash action-gate-allow.sh on git-force"`,
  ]) {
    const r = tool(home, command);
    check(`차단: ${command.replaceAll(here, '<scripts>').replace(/\n/g, '⏎')}`, r.got === 'deny' && r.reason.includes('게이트 개방'), r.reason.slice(0, 40));
  }
  for (const command of [
    `node ${join(here, 'selftest-action-gate-prompt.mjs')}`,
    `node scripts/selftest-action-gate-prompt.mjs`,
    `bash ${A} status`,
    `bash ${A} off`,
    `bash ${A} status; echo on`,
    `bash ${A} status 2>&1 | grep on`,
    `bash ${A} once`,
    `git commit -F msg.txt`,
    `gh pr create --draft --title t --body-file body.md`,
  ]) {
    const r = tool(home, command);
    check(`통과: ${command.replaceAll(here, '<scripts>')}`, !r.reason.includes('게이트 개방'), r.reason.slice(0, 40));
  }
});

// 3-1. 사용자 입력 훅이 등록돼 있다 (등록이 빠지면 기능 전체가 조용히 멈춘다)
const hooksJson = JSON.parse(readFileSync(join(here, '..', 'hooks', 'hooks.json'), 'utf8'));
const ups = (hooksJson.hooks?.UserPromptSubmit || []).flatMap(g => g.hooks || []).map(h => h.command || '');
check('hooks.json UserPromptSubmit 에 action-gate-prompt.mjs 등록', ups.some(c => c.includes('scripts/action-gate-prompt.mjs')));

// 4. 차단 안내가 대화창 경로를 알린다
console.log('4. 차단 안내');
scenario(home => {
  const r = tool(home, 'git push --force origin feat/x');
  check('강제 푸시 차단 안내에 대화창 한 줄 경로가 있다', r.got === 'deny' && r.reason.includes('메시지로 입력'), r.reason.slice(0, 60));
});

console.log(`\n${count - failed}/${count} 통과`);
process.exit(failed ? 1 : 0);
