#!/usr/bin/env node
/**
 * selftest-flow-routes.mjs — 플로우 상태 표의 가이드 참조 자체 점검 (#774).
 *
 * `skills/flow/SKILL.md` 의 상태 표는 단계를 `guides/<가이드>.md` (<절>) 로 보낸다.
 * 가리킨 절이 없어도 아무 신호가 없다. 리뷰 대응 라우팅은 없는 절을 7개월간 가리켰다.
 * 괄호 안 이름이 그 가이드의 제목 어딘가에 들어 있는지 본다.
 *
 * 사용: node scripts/selftest-flow-routes.mjs [SKILL.md 경로]
 * 종료 코드: 실패 1, 전부 통과 0
 */
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const skill = process.argv[2] ?? join(here, '..', 'skills', 'flow', 'SKILL.md');
const guidesDir = join(dirname(skill), 'guides');

const text = readFileSync(skill, 'utf8');
const refs = [...text.matchAll(/`guides\/([\w-]+)\.md`\s*\(([^)]+)\)/g)];
let failed = 0;

if (refs.length === 0) {
  console.log(`FAIL 참조 0건: ${skill} 에서 상태 표의 가이드 참조를 찾지 못했다`);
  process.exit(1);
}

for (const [, guide, label] of refs) {
  const path = join(guidesDir, `${guide}.md`);
  if (!existsSync(path)) {
    console.log(`FAIL guides/${guide}.md 없음 (${label})`);
    failed++;
    continue;
  }
  const headings = readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('#'))
    .map((l) => l.replace(/^#+\s*/, ''));
  if (headings.some((h) => h.includes(label))) {
    console.log(`ok   guides/${guide}.md (${label})`);
  } else {
    console.log(`FAIL guides/${guide}.md 에 「${label}」 절 없음`);
    failed++;
  }
}

// 글 작성 경로 안내 (#1154, ADR-0043): PR 본문 · 이슈 본문 · 코멘트를 쓰는 자리가 글 작성 스킬의 전문가 호출 형식을 가리키는지 본다.
// 안내가 빠지면 플로우가 본문을 쓰는 자리에서 전문가 경로가 보이지 않아도 신호가 없다.
const WRITE_LINK = '../../write/SKILL.md#전문가-호출-형식';
const writeSkill = join(dirname(skill), '..', 'write', 'SKILL.md');
const anchorOk = existsSync(writeSkill) && /^#+ 전문가 호출 형식\s*$/m.test(readFileSync(writeSkill, 'utf8'));
console.log(`${anchorOk ? 'ok  ' : 'FAIL'} write/SKILL.md 「전문가 호출 형식」 절`);
if (!anchorOk) failed++;
const sectionOf = (file, heading) => {
  const t = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const i = t.indexOf(`\n## ${heading}\n`);
  if (i < 0) return '';
  const j = t.indexOf('\n## ', i + 1);
  return t.slice(i, j < 0 ? undefined : j);
};
const prStep = (existsSync(join(guidesDir, 'pr.md')) ? readFileSync(join(guidesDir, 'pr.md'), 'utf8') : '')
  .split('\n').find(l => /^5\. PR 본문 작성/.test(l)) || '';
for (const [name, text] of [
  ['guides/pr.md 워크플로우 「5. PR 본문 작성」', prStep],
  ['guides/issue.md 「보내기 전 글 판정」', sectionOf(join(guidesDir, 'issue.md'), '보내기 전 글 판정')],
]) {
  if (text.includes(WRITE_LINK)) console.log(`ok   ${name} → 글 작성 경로`);
  else { console.log(`FAIL ${name} 에 글 작성 「전문가 호출 형식」 링크 없음`); failed++; }
}

process.exit(failed ? 1 : 0);
