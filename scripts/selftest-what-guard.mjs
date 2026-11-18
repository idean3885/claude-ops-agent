#!/usr/bin/env node
/**
 * selftest-what-guard.mjs — 도메인 What 추상화 가드 자체 점검 (#1122).
 *
 * `what-guard-rules.mjs` 나 `pre-tool-use.mjs` 의 What 가드 블록을 고쳤으면 돌린다.
 * 실제 훅을 실행한다. 본문 파일을 만들고 `gh issue comment --body-file` 호출로 넘긴다.
 *
 * 사용: node scripts/selftest-what-guard.mjs
 * 종료 코드: 실패 1, 전부 통과 0
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const hook = join(here, 'pre-tool-use.mjs');
const MARK = '[ops-agent What 추상화 가드';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'ops-what-guard-')));

const CASES = [
  // 외부 제품이 공개한 리소스 종류는 이 변경의 구현 세부가 아니다
  ['외부 리소스 종류 VirtualService', '게이트웨이의 VirtualService 로 차단 페이지에 보낸다.', 'pass'],
  // 이 레포 · 소비 프로젝트의 클래스명은 계속 막는다
  ['헥사고날 클래스명', 'WorkloadSnapshotUserService 를 고쳤다.', 'deny'],
  ['접미사만 같은 다른 이름', 'MyVirtualService 를 추가했다.', 'deny'],
  ['외부 이름과 클래스명이 함께', 'VirtualService 와 QuotaPortAdapter 를 본다.', 'deny'],
];

let fail = 0;
CASES.forEach(([name, body, want], i) => {
  const file = join(base, `body-${i}.md`);
  writeFileSync(file, body + '\n');
  const r = spawnSync('node', [hook], {
    input: JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: `gh issue comment 1 --body-file ${file}` },
      cwd: base,
      session_id: 'selftest-what-guard',
    }),
    encoding: 'utf8',
  });
  let reason = '';
  try { reason = JSON.parse(r.stdout).hookSpecificOutput?.permissionDecisionReason || ''; } catch { reason = r.stdout ? `출력 해석 실패: ${r.stdout}` : ''; }
  const got = reason.includes(MARK) ? 'deny' : 'pass';
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} (기대 ${want}, 결과 ${got})${ok ? '' : `\n     ${reason.split('\n')[0] || r.stdout.slice(0, 200)}`}`);
});
rmSync(base, { recursive: true, force: true });
console.log(fail ? `\n실패 ${fail}/${CASES.length}` : `\n전부 통과 ${CASES.length}/${CASES.length}`);
process.exit(fail ? 1 : 0);
