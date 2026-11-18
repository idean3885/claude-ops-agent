#!/usr/bin/env node
/**
 * 한자 섞임 검사 — 보낼 한국어 글에 한글 음절과 붙은 한자가 있으면 보내지 않는다 (#1090).
 *
 * 생성 중 한 글자가 한자로 바뀌는 일이 있었다 (「외부」 → 「외部」). 다음 수정이 그 줄을 찾지 못해
 * 「이미 지워졌다」는 잘못된 보고로 이어졌고, 사람이 화면에서 본 뒤에야 드러났다.
 * 원문 없이 판정할 수 있게 「한글 음절 바로 앞뒤의 한자」만 본다. 띄어 쓴 한자 낱말은 통과한다.
 *
 * 이 모듈이 판정의 단일 출처다. `scripts/gh-issue.sh` 가 이슈 생성 전에 부르고, 다른 트래커 어댑터도
 * 같은 모듈을 불러 쓴다 (`issue-body-rules.mjs` 와 같은 꼴). 판정이 호출부마다 복제되면 같은 글이
 * 경로에 따라 통과 · 차단으로 달라진다.
 *
 * 사용:
 *   import { findIntrusions } from './han-intrusion.mjs';
 *   node scripts/han-intrusion.mjs [--text <값>]... [<파일>]...   (.json 은 문자열 값만 본다)
 * 종료 코드: 0 섞임 없음, 1 파일을 읽지 못함, 6 섞임 있음. 사유는 stderr JSON 한 줄
 * 비활성: OPS_AGENT_HAN_GUARD_DISABLE=1 (한자가 붙어야 하는 글만. 사람이 세션 환경변수로)
 */
import { readFileSync, realpathSync } from 'fs';
import { fileURLToPath } from 'url';

const HAN = '\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF';
const HANGUL = '\\uAC00-\\uD7A3';
const MIXED = new RegExp(`[${HANGUL}][${HAN}]+|[${HAN}]+[${HANGUL}]`, 'gu');

export function findIntrusions(text) {
  const hits = [];
  for (const m of String(text || '').matchAll(MIXED)) {
    const from = Math.max(0, m.index - 6);
    hits.push(text.slice(from, m.index + m[0].length + 6).replace(/\n/g, ' '));
  }
  return hits;
}

// JSON 페이로드는 문자열 값과 키만 모은다. `\uXXXX` 로 이스케이프된 섞임도 풀어서 본다
function jsonStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(v => jsonStrings(v, out));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => { out.push(k); jsonStrings(v, out); });
  return out;
}

export function fileText(path) {
  const raw = readFileSync(path, 'utf8');
  if (!path.endsWith('.json')) return raw;
  try { return jsonStrings(JSON.parse(raw)).join('\n'); } catch { return raw; }
}

// 설치본은 링크 경로(~/.claude/ops-agent/current)로 불려 argv 와 import.meta.url 이 다르다.
// 실제 경로로 비교하지 않으면 검사 없이 0 으로 통과한다 (#1109)
const isEntry = (() => {
  try { return realpathSync(process.argv[1] || '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isEntry) {
  if (process.env.OPS_AGENT_HAN_GUARD_DISABLE === '1') process.exit(0);
  const args = process.argv.slice(2);
  let text = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--text') { text += '\n' + (args[++i] ?? ''); continue; }
    try { text += '\n' + fileText(args[i]); }
    catch {
      process.stderr.write(JSON.stringify({ status: 'error', step: 'han-intrusion', message: `읽지 못해 검사할 수 없다: ${args[i]}` }) + '\n');
      process.exit(1);
    }
  }
  const hits = findIntrusions(text);
  if (hits.length) {
    process.stderr.write(JSON.stringify({
      status: 'error', step: 'han-intrusion',
      message: '보낼 글에 한글과 붙은 한자가 있어 보내지 않았다. 생성 중 바뀐 글자일 수 있다. 그 자리를 한글로 고치고 다시 실행한다',
      hits,
    }) + '\n');
    process.exit(6);
  }
}
