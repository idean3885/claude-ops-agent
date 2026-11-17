#!/usr/bin/env node
/**
 * action-gate-prompt.mjs — UserPromptSubmit 훅: 대화창에 친 게이트 개방 명령을 받아 마커를 쓴다 (#1060).
 *
 * `!` 셸 실행은 터미널 CLI 의 대화형 기능이다. Agent SDK 위에서 도는 대화창은 `!` 줄을 실행하지 않고
 * 메시지로 넘겨, 차단 안내의 개방 명령이 마커를 만들지 못한다. 사용자 입력 훅은 사람이 친 글만 받으므로
 * 그 글이 개방 명령 한 줄이면 훅이 같은 스크립트를 실행한다 (「푸시 권한 위임」 #1046 과 같은 흐름).
 *
 * 메시지 전체가 명령 한 줄일 때만 동작한다. 실행하는 스크립트는 사람이 친 경로가 아니라 이 플러그인의 것이다.
 * 갈래 검증 · 마커 형식은 action-gate-allow.sh 가 그대로 맡는다. 결과는 사람이 터미널에서 친 것과 같다.
 * 입력: stdin 의 hook JSON (`prompt`). 출력: 컨텍스트에 더할 결과 줄.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `!` 유무 · 앞뒤 공백 무관. 경로는 action-gate-allow.sh 로 끝나야 하고, 인자는 on <갈래 목록> | off 뿐이다.
// 갈래 목록은 쉼표로만 잇는다. TTL · 세션 인자는 받지 않는다 (차단 안내가 주는 명령에 없다).
const GATE_PROMPT_RE = /^!?\s*bash\s+\S*action-gate-allow\.sh\s+(?:(on)\s+([a-z][a-z-]*(?:,[a-z][a-z-]*)*)|(off))$/;

export function parseGatePrompt(prompt) {
  if (typeof prompt !== 'string') return null;
  const text = prompt.trim();
  if (text.includes('\n')) return null;
  const m = GATE_PROMPT_RE.exec(text);
  if (!m) return null;
  return m[3] ? { action: 'off' } : { action: 'on', scopes: m[2] };
}

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'action-gate-allow.sh');

function run(gate) {
  const args = gate.action === 'on' ? ['on', gate.scopes] : ['off'];
  const r = spawnSync('bash', [scriptPath, ...args], { encoding: 'utf8', timeout: 2500 });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return { ok: r.status === 0, out };
}

const isEntry = (() => {
  try { return realpathSync(process.argv[1] || '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();

if (isEntry) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { input += c; });
  process.stdin.on('end', () => {
    let h;
    try { h = JSON.parse(input); } catch { process.exit(0); }
    const gate = parseGatePrompt(h.prompt);
    if (!gate) process.exit(0);
    const { ok, out } = run(gate);
    const head = ok
      ? `[게이트 개방] 사람이 대화창에 친 명령을 실행했다: action-gate-allow.sh ${gate.action}${gate.scopes ? ` ${gate.scopes}` : ''}.`
      : `[게이트 개방] 사람이 친 명령을 실행했으나 실패했다: action-gate-allow.sh ${gate.action}${gate.scopes ? ` ${gate.scopes}` : ''}.`;
    process.stdout.write(`${head}\n${out}\n착수 전에 status 로 열린 갈래를 확인하고, 사람에게 결과를 한 줄로 알린다.\n`);
    process.exit(0);
  });
}
