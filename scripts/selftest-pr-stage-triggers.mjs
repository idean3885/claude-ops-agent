#!/usr/bin/env node
/**
 * selftest-pr-stage-triggers.mjs — PR 단계 이름의 트리거 자체 점검 (#1069).
 *
 * 어시스턴트가 하는 PR 단계는 「리뷰 준비」 · 「머지 준비」이고, 「리뷰 요청」은 작성자가
 * 준비 완료로 전환하며 보내는 행위다. 트리거 표에 「리뷰 요청」이 남으면 사람이 할 행위를
 * 어시스턴트가 받아 진행한다. 실제 진입점인 세션 시작 훅을 실행해 트리거 표를 본다.
 *
 * 사용: node scripts/selftest-pr-stage-triggers.mjs [플러그인 루트]
 * 종료 코드: 실패 1, 전부 통과 0
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const root = process.argv[2] ?? join(here, '..');
const home = mkdtempSync(join(tmpdir(), 'pr-stage-triggers-'));

let out;
try {
  out = execFileSync('node', [join(root, 'scripts', 'session-start.mjs')], {
    input: '{}',
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, HOME: home },
    encoding: 'utf8',
  });
} finally {
  rmSync(home, { recursive: true, force: true });
}

const context = JSON.parse(out).hookSpecificOutput?.additionalContext ?? '';
const rows = context.split('\n').filter((l) => l.startsWith('| "'));
const flowRow = rows.find((r) => r.includes('/skills/flow/SKILL.md'));

const checks = [
  ['트리거 표가 있다', rows.length > 0],
  ['flow 행에 「리뷰 준비」가 있다', !!flowRow && flowRow.includes('"리뷰 준비"')],
  ['flow 행에 「머지 준비」가 있다', !!flowRow && flowRow.includes('"머지 준비"')],
  // 「이슈 정리」는 flow 의 「이슈」와 겹친다. 전용 행이 표에 있고 flow 행은 그 말을 갖지 않는다 (#1134)
  ['이슈 정리 행이 표에 있다', rows.some((r) => r.includes('/skills/backlog-refinement/SKILL.md') && r.includes('"이슈 정리"'))],
  ['flow 행에 「이슈 정리」가 없다', !!flowRow && !flowRow.includes('"이슈 정리"')],
  ['어느 행에도 「리뷰 요청」 · 「review request」가 없다', rows.every((r) => !r.includes('"리뷰 요청"') && !r.includes('"review request"'))],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) failed++;
}
console.log(failed ? `\n실패 ${failed}건` : '\n전부 통과');
process.exit(failed ? 1 : 0);
