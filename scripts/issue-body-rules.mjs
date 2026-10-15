#!/usr/bin/env node
/**
 * 이슈 본문 구조 룰 — 생성 전에 본문이 작성 규칙(`config/style-rules/extensions/issue.md`)의 구조를
 * 갖췄는지 결정적으로 판정한다.
 *
 * 이 모듈이 룰의 단일 출처다. `scripts/gh-issue.sh` 가 생성 전에 부르고, 다른 트래커 어댑터도
 * 같은 모듈을 불러 쓴다 (`what-guard-rules.mjs` 와 같은 꼴). 룰이 호출부마다 복제되면 같은 본문이
 * 경로에 따라 통과·차단으로 갈린다.
 *
 * 분담: 이 모듈은 구조(절 제목 · 불릿 수 · 기존 기록 줄 · 줄글)만 본다. 어휘(대외비 · 구현 세부)는
 * 훅의 대외비 가드 · What 가드가, 나머지(ISS2 제목 등)는 lint 가 본다.
 *
 * 사용:
 *   import { checkIssueBody } from './issue-body-rules.mjs';
 *   const { ok, failures } = checkIssueBody(body, 'iss5');
 *   node scripts/issue-body-rules.mjs --structure iss5 < body.md   # JSON 한 줄, 실패면 종료 1
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

// 문장 종결. config/style-rules/metrics/readability_count.py 의 SENT 와 같은 식이다.
// final-check.sh 가 쓰는 카운터와 정의가 갈리면 같은 본문이 어댑터 통과 · 카운터 검출로 나뉜다.
export const SENT = /(?:다|요)\.(?=\s|$)|[.!?](?=\s|$)/g;

const BULLET = /^\s*(?:[-*]|\d+\.)\s+/;
const TOP_BULLET = /^(?:[-*]|\d+\.)\s+/;
const HEADING = /^#{1,6}\s+/;
const TABLE = /^\s*\|/;
const RECORD_LINE = /^(?:[-*]|\d+\.)\s+(?:\*\*)?기존 기록(?:\*\*)?\s*[:：]/;

export const STRUCTURES = {
  // 절 제목이 요소명으로 시작하면 존재로 본다. 레포 템플릿은 `## 재현 절차 (ISS1, ISS4)` 처럼 접미가 붙는다.
  iss1: { sections: ['재현', '환경', '기대', '실제', '영향'] },
  iss5: { sections: ['What', 'Why'], forbidden: ['변경 범위', '구현 방안', '검증 절차'] },
  iss6: { sections: ['측정 조건', '합격 기준', '결과', '발견 사항'] },
  iss7: { sections: ['판정', '확정된 외부 조건', '달라지는 것', '설계 기준', '남은 논의'] },
};

export const WHY_MIN = 2;
export const WHY_MAX = 5;

function countSentences(line) {
  return (line.match(SENT) || []).length;
}

// 코드 블록 안은 검사하지 않는다. 명령 · 재현 절차는 문장 규칙의 대상이 아니다.
function stripCodeBlocks(body) {
  return String(body || '').replace(/```[\s\S]*?```/g, '```\n```');
}

function parseSections(lines) {
  const sections = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(/^(#{2,3})\s+(.+?)\s*$/);
    if (m) {
      current = { level: m[1].length, title: m[2], lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return sections;
}

function hasSection(sections, prefix) {
  return sections.some(s => s.title.startsWith(prefix));
}

/**
 * @param {string} body
 * @param {'iss1'|'iss5'|'iss6'|'iss7'} structure
 * @returns {{ok: boolean, structure: string, failures: Array<{check: string, message: string}>}}
 */
export function checkIssueBody(body, structure) {
  const spec = STRUCTURES[structure];
  if (!spec) {
    return { ok: false, structure, failures: [{ check: 'structure', message: `모르는 구조: ${structure}. iss1 · iss5 · iss6 · iss7 중 하나` }] };
  }
  const failures = [];
  const lines = stripCodeBlocks(body).split('\n');
  const sections = parseSections(lines);

  for (const name of spec.sections) {
    if (!hasSection(sections, name)) {
      failures.push({ check: 'section', message: `절 「${name}」 이 없다 (${structure.toUpperCase()} 필수 구조)` });
    }
  }
  for (const name of spec.forbidden || []) {
    if (sections.some(s => s.title.includes(name))) {
      failures.push({ check: 'forbidden-section', message: `절 「${name}」 은 이슈에 두지 않는다 (ISS5 합격선). PR 본문으로` });
    }
  }

  if (structure === 'iss5') {
    const what = sections.find(s => s.title.startsWith('What'));
    if (what) {
      const nonEmpty = what.lines.filter(l => l.trim() !== '');
      if (nonEmpty.length !== 1) {
        failures.push({ check: 'what-one-line', message: `## What 은 비어 있지 않은 줄 1개 (지금 ${nonEmpty.length}개)` });
      }
    }
    const why = sections.find(s => s.title.startsWith('Why'));
    if (why) {
      const top = why.lines.filter(l => TOP_BULLET.test(l));
      const records = top.filter(l => RECORD_LINE.test(l));
      const facts = top.length - records.length;
      if (facts < WHY_MIN || facts > WHY_MAX) {
        failures.push({ check: 'why-count', message: `## Why 배경 사실 불릿은 ${WHY_MIN}~${WHY_MAX}개 (지금 ${facts}개, 기존 기록 줄 제외)` });
      }
      if (records.length !== 1) {
        failures.push({
          check: 'record-line',
          message: records.length === 0
            ? '## Why 에 「- 기존 기록: {이전 · 지금 · 바뀐 점 | 없음 · 찾은 자리}」 불릿이 없다 (ADR-0027 대조 줄)'
            : `## Why 의 기존 기록 불릿은 1개 (지금 ${records.length}개)`,
        });
      }
    }

    // 줄글: 불릿 · 제목 · 표가 아닌 줄에 문장 종결 2개 이상. ISS5 「What 1줄」의 기계 해석이다.
    // L7: 불릿 한 줄에 문장 종결 2개 이상. 두 문장이 필요하면 판단이 둘이라는 신호다.
    let inCode = false;
    lines.forEach((line, i) => {
      if (/^\s*```/.test(line)) { inCode = !inCode; return; }
      if (inCode || line.trim() === '' || HEADING.test(line) || TABLE.test(line)) return;
      const n = countSentences(line);
      if (n < 2) return;
      if (BULLET.test(line)) {
        failures.push({ check: 'bullet-two-sentences', message: `${i + 1}행: 불릿 한 줄에 문장 ${n}개 (L7). 불릿을 나눈다` });
      } else {
        failures.push({ check: 'prose', message: `${i + 1}행: 줄글 (문장 ${n}개). 불릿으로 나눈다` });
      }
    });
  }

  return { ok: failures.length === 0, structure, failures };
}

// CLI 진입점: stdin 본문 + --structure → JSON 한 줄. bash 어댑터가 부른다.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const idx = process.argv.indexOf('--structure');
  const structure = idx >= 0 ? process.argv[idx + 1] : 'iss5';
  const body = readFileSync(0, 'utf8');
  const result = checkIssueBody(body, structure);
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(result.ok ? 0 : 1);
}
