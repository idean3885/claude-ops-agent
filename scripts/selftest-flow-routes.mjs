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

process.exit(failed ? 1 : 0);
