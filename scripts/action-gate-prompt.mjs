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
 * 브라우저 허용 목록 추가 줄(devtools-allow.py)도 같은 판정으로 받는다 (#1123). 대화창은 셸을 거치지 않아
 * 따옴표 · 글로빙이 일어나지 않으므로 인자를 셸 없이 그대로 넘긴다. 받는 인자는 패턴 · --server · --project ·
 * --user · --dry-run 뿐이다.
 * 입력: stdin 의 hook JSON (`prompt`). 출력: 컨텍스트에 더할 결과 줄.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `!` 유무 · 앞뒤 공백 무관. 경로는 action-gate-allow.sh 로 끝나야 하고, 인자는 on <갈래 목록> | off 뿐이다.
// 갈래 목록은 쉼표로만 잇는다. TTL · 세션 인자는 받지 않는다 (차단 안내가 주는 명령에 없다).
const GATE_PROMPT_RE = /^!?\s*bash\s+\S*action-gate-allow\.sh\s+(?:(on)\s+([a-z][a-z-]*(?:,[a-z][a-z-]*)*)|(off))$/;

// 허용 목록 줄: `[!] [python3] <경로>devtools-allow.py <인자>…`. 인자 낱말은 작은따옴표로 감싼 것(안에 작은따옴표 없음)
// 또는 셸 특수문자 없는 것뿐이다. 패턴 끝 `*` 는 따옴표 없이 써도 이 훅이 셸을 거치지 않아 지워지지 않는다.
const ALLOW_WORD = String.raw`(?:'[^'\n]*'|[^\s'"` + '`' + String.raw`$;&|<>(){}\\!#~]+)`;
const ALLOW_PROMPT_RE = new RegExp(String.raw`^!?\s*(?:python3?\s+)?\S*devtools-allow\.py((?:\s+${ALLOW_WORD})*)$`);
const ALLOW_WORD_RE = new RegExp(ALLOW_WORD, 'g');
const ALLOW_PATTERN_RE = /^[A-Za-z][A-Za-z0-9.+-]*:\/\/\S+$/;

function parseAllowArgs(rest) {
  const words = [...rest.matchAll(ALLOW_WORD_RE)].map(w => (w[0].startsWith("'") ? w[0].slice(1, -1) : w[0]));
  const args = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === '--user' || w === '--dry-run') args.push(w);
    else if (w === '--server' || w === '--project') {
      const v = words[++i];
      if (!v || v.startsWith('-') || (w === '--server' && !/^[A-Za-z0-9._-]+$/.test(v))) return null;
      args.push(w, v);
    } else if (ALLOW_PATTERN_RE.test(w)) args.push(w);
    else return null;
  }
  return args;
}

export function parseGatePrompt(prompt) {
  if (typeof prompt !== 'string') return null;
  const text = prompt.trim();
  if (text.includes('\n')) return null;
  const a = ALLOW_PROMPT_RE.exec(text);
  if (a) {
    const args = parseAllowArgs(a[1]);
    return args ? { action: 'devtools-allow', args } : null;
  }
  const m = GATE_PROMPT_RE.exec(text);
  if (!m) return null;
  return m[3] ? { action: 'off' } : { action: 'on', scopes: m[2] };
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(scriptDir, 'action-gate-allow.sh');
const allowPath = join(scriptDir, 'devtools-allow.py');

function runAllow(gate) {
  const r = spawnSync('python3', [allowPath, ...gate.args], { encoding: 'utf8', timeout: 25000 });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

function run(gate) {
  if (gate.action === 'devtools-allow') return runAllow(gate);
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
    if (gate.action === 'devtools-allow') {
      const head = ok ? '[허용 목록] 사람이 대화창에 친 명령을 실행했다' : '[허용 목록] 사람이 친 명령을 실행했으나 실패했다';
      process.stdout.write(`${head}: devtools-allow.py ${gate.args.join(' ')}.\n${out}\n결과를 한 줄로 알리고, 등록을 바꿨으면 /mcp → chrome-devtools → Reconnect 를 사람에게 안내한다.\n`);
      process.exit(0);
    }
    const head = ok
      ? `[게이트 개방] 사람이 대화창에 친 명령을 실행했다: action-gate-allow.sh ${gate.action}${gate.scopes ? ` ${gate.scopes}` : ''}.`
      : `[게이트 개방] 사람이 친 명령을 실행했으나 실패했다: action-gate-allow.sh ${gate.action}${gate.scopes ? ` ${gate.scopes}` : ''}.`;
    process.stdout.write(`${head}\n${out}\n착수 전에 status 로 열린 갈래를 확인하고, 사람에게 결과를 한 줄로 알린다.\n`);
    process.exit(0);
  });
}
