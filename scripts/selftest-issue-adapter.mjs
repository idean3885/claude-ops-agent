#!/usr/bin/env node
/**
 * selftest-issue-adapter.mjs — 이슈 생성 · 시작 어댑터 자체 점검 (#696).
 *
 * 둘을 본다.
 *   1. `issue-body-rules.mjs` 가 본문 구조(ISS1 · ISS5 · ISS6 · ISS7)를 결정적으로 가르는가
 *   2. `gh-issue.sh create|start` 가 계약(필수 판단 · 종료 코드 · 출력 · 시작 체인)을 지키는가
 *      — 가짜 `gh` · `git` 을 PATH 앞에 두고 호출 기록으로 판정한다. 네트워크를 쓰지 않는다.
 *
 * 사용: node scripts/selftest-issue-adapter.mjs
 * 종료 코드: 실패 1, 전부 통과 0
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { checkIssueBody } from './issue-body-rules.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const adapter = join(here, 'gh-issue.sh');
let failed = 0;
let count = 0;
function report(ok, group, name, detail = '') {
  count++;
  if (!ok) failed++;
  console.log(`${ok ? '  OK' : '  XX'}  ${group}: ${name}${detail ? ` · ${detail}` : ''}`);
}

// ─── 1. 본문 구조 ───
const ISS5_OK = '## What\n한 줄\n\n## Why\n- 사실 1\n- 사실 2\n- 기존 기록: 없음 · docs/adr\n';
const BODY_CASES = [
  ['ISS5 정상', 'iss5', ISS5_OK, []],
  ['ISS5 What 2줄', 'iss5', ISS5_OK.replace('한 줄\n', '한 줄\n둘째 줄\n'), ['what-one-line']],
  ['ISS5 Why 1개', 'iss5', '## What\n한 줄\n\n## Why\n- 사실 1\n- 기존 기록: 없음 · docs\n', ['why-count']],
  ['ISS5 Why 6개', 'iss5', '## What\n한 줄\n\n## Why\n- 1\n- 2\n- 3\n- 4\n- 5\n- 6\n- 기존 기록: 없음 · docs\n', ['why-count']],
  ['ISS5 기존 기록 줄 없음', 'iss5', '## What\n한 줄\n\n## Why\n- 사실 1\n- 사실 2\n', ['record-line']],
  ['ISS5 기존 기록 줄은 계수에서 뺀다 (사실 5 + 기록 1)', 'iss5', '## What\n한 줄\n\n## Why\n- 1\n- 2\n- 3\n- 4\n- 5\n- 기존 기록: 이전 A · 지금 B · 바뀐 점 C\n', []],
  ['ISS5 금지 절', 'iss5', ISS5_OK + '\n## 구현 방안\n- x\n', ['forbidden-section']],
  ['ISS5 줄글', 'iss5', ISS5_OK + '\n배경이 있다. 그래서 바꾼다.\n', ['prose']],
  ['ISS5 불릿 두 문장 (L7)', 'iss5', ISS5_OK.replace('- 사실 1\n', '- 사실이 있다. 그래서 바꾼다.\n'), ['bullet-two-sentences']],
  ['ISS5 코드 블록 안 문장은 제외', 'iss5', ISS5_OK + '\n```\n첫 문장이다. 둘째 문장이다.\n```\n', []],
  ['ISS5 표 줄은 제외', 'iss5', ISS5_OK + '\n| a | b |\n|---|---|\n| 한다. | 된다. |\n', []],
  ['ISS5 What 없음', 'iss5', '## Why\n- 1\n- 2\n- 기존 기록: 없음 · x\n', ['section']],
  ['ISS1 정상 (레포 템플릿 접미)', 'iss1', '## 재현 절차 (ISS1, ISS4)\n1. x\n\n## 기대 동작 (ISS1)\ny\n\n## 실제 동작 (ISS1)\nz\n\n## 환경 (ISS1)\nw\n\n## 영향 범위 (ISS1)\nv\n', []],
  ['ISS1 절 누락', 'iss1', '## 재현 절차\n1. x\n\n## 기대 동작\ny\n', ['section', 'section', 'section']],
  ['ISS1 은 줄글 · 기존 기록을 보지 않는다', 'iss1', '## 재현 절차\n첫 문장이다. 둘째 문장이다.\n\n## 기대 동작\ny\n\n## 실제 동작\nz\n\n## 환경\nw\n\n## 영향 범위\nv\n', []],
  ['ISS6 정상 + 산문 허용', 'iss6', '## 측정 조건\n조건이다. 규모다.\n\n## 합격 기준\nx\n\n## 결과\ny\n\n## 발견 사항\nz\n', []],
  ['ISS6 절 누락', 'iss6', '## 측정 조건\nx\n\n## 결과\ny\n', ['section', 'section']],
  ['ISS7 정상 + 산문 허용', 'iss7', '## 판정\n한 문장이다. 둘이다.\n\n## 확정된 외부 조건\nx\n\n## 달라지는 것\ny\n\n## 설계 기준\nz\n\n## 남은 논의\nw\n', []],
  ['ISS7 절 누락', 'iss7', '## 판정\nx\n', ['section', 'section', 'section', 'section']],
  ['모르는 구조', 'iss9', ISS5_OK, ['structure']],
];
for (const [name, structure, body, wantChecks] of BODY_CASES) {
  const r = checkIssueBody(body, structure);
  const got = r.failures.map(f => f.check).sort();
  const want = [...wantChecks].sort();
  const ok = r.ok === (want.length === 0) && JSON.stringify(got) === JSON.stringify(want);
  report(ok, '본문 구조', name, ok ? '' : `want [${want}] got [${got}]`);
}

// ─── 2. 어댑터 ───
// 가짜 gh · git: 호출을 LOG 에 한 줄씩 적고 최소 응답만 낸다. 실패 주입은 환경 변수로.
const sandbox = mkdtempSync(join(tmpdir(), 'issue-adapter-selftest-'));
const bin = join(sandbox, 'bin');
mkdirSync(bin);
const LOG = join(sandbox, 'calls.log');
writeFileSync(join(bin, 'gh'), `#!/bin/bash
echo "gh $*" >> "$FAKE_LOG"
case "$1 $2" in
  "label list") printf '%s\\n' $FAKE_LABELS_REPO;;
  "label create") exit 0;;
  "issue create") [ "$FAKE_GH_FAIL" = create ] && exit 1; echo "https://github.com/o/r/issues/42";;
  "issue view") printf '%s\\n' $FAKE_ISSUE_LABELS;;
  "issue edit") [ "$FAKE_GH_FAIL" = edit ] && exit 1; exit 0;;
  "issue comment") [ "$FAKE_GH_FAIL" = comment ] && exit 1; exit 0;;
  *) exit 0;;
esac
`);
writeFileSync(join(bin, 'git'), `#!/bin/bash
echo "git $*" >> "$FAKE_LOG"
case "$1" in
  rev-parse) echo "$FAKE_TOPLEVEL";;
  fetch) exit 0;;
  worktree|checkout) [ "$FAKE_GIT_FAIL" = 1 ] && exit 1; exit 0;;
  *) exit 0;;
esac
`);
chmodSync(join(bin, 'gh'), 0o755);
chmodSync(join(bin, 'git'), 0o755);
const okBody = join(sandbox, 'ok.md');
writeFileSync(okBody, ISS5_OK);
const badBody = join(sandbox, 'bad.md');
writeFileSync(badBody, '## What\n한 줄\n\n## Why\n- 사실 1\n');
const fixBody = join(sandbox, 'fix.md');
writeFileSync(fixBody, '## 재현 절차\n1. x\n\n## 기대 동작\ny\n\n## 실제 동작\nz\n\n## 환경\nw\n\n## 영향 범위\nv\n');

function run(args, env = {}) {
  if (existsSync(LOG)) rmSync(LOG);
  const res = spawnSync('bash', [adapter, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: LOG, FAKE_TOPLEVEL: join(sandbox, 'proj'),
      FAKE_LABELS_REPO: 'feat fix', FAKE_ISSUE_LABELS: '', FAKE_GH_FAIL: '', FAKE_GIT_FAIL: '', ...env,
    },
  });
  const log = existsSync(LOG) ? readFileSync(LOG, 'utf8') : '';
  let json = null;
  for (const line of [res.stdout, res.stderr]) {
    try { json = JSON.parse((line || '').trim().split('\n').pop()); break; } catch { /* 다음 */ }
  }
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '', log, json };
}
function adapterCase(name, args, want, { env = {}, logHas = [], logNot = [], json = {} } = {}) {
  const r = run(args, env);
  const problems = [];
  if (r.code !== want) problems.push(`종료 ${want} 기대, ${r.code}`);
  for (const s of logHas) if (!r.log.includes(s)) problems.push(`호출 없음: ${s}`);
  for (const s of logNot) if (r.log.includes(s)) problems.push(`호출 있음: ${s}`);
  for (const [k, v] of Object.entries(json)) if (!r.json || String(r.json[k]) !== String(v)) problems.push(`${k}=${r.json ? r.json[k] : '(JSON 없음)'} (기대 ${v})`);
  report(problems.length === 0, '어댑터', name, problems.join(' · '));
}

const CREATE = ['create', '--title', 't', '--body-file', okBody, '--type', 'feat'];
adapterCase('필수 판단 누락은 거부', CREATE, 1, { logNot: ['gh issue create'], json: { status: 'error' } });
adapterCase('--start 와 --no-start 동시는 거부', [...CREATE, '--start', '--no-start', 'x'], 1, { logNot: ['gh issue create'] });
adapterCase('--type 누락은 거부', ['create', '--title', 't', '--body-file', okBody, '--start'], 1, { logNot: ['gh issue create'] });
adapterCase('본문 검사 실패는 생성하지 않는다', ['create', '--title', 't', '--body-file', badBody, '--type', 'feat', '--start'], 1, { logNot: ['gh issue create'], json: { step: 'body-check' } });
adapterCase('fix 는 ISS1 기본 (ISS5 본문은 거부)', ['create', '--title', 't', '--body-file', okBody, '--type', 'fix', '--start'], 1, { logNot: ['gh issue create'] });
adapterCase('fix + ISS1 본문 통과', ['create', '--title', 't', '--body-file', fixBody, '--type', 'fix', '--no-start', 'x'], 0, { logHas: ['gh issue create'] });
adapterCase('--structure 가 기본값을 덮는다', ['create', '--title', 't', '--body-file', okBody, '--type', 'fix', '--structure', 'iss5', '--no-start', 'x'], 0, { logHas: ['gh issue create'] });
adapterCase('--no-start 는 생성만 하고 사유를 낸다', [...CREATE, '--no-start', '후속'], 0, { logHas: ['gh issue create', '--label feat'], logNot: ['issue edit', 'issue comment'], json: { status: 'ok', number: '42', start: 'skipped', reason: '후속' } });
adapterCase('라벨이 없으면 만든다', [...CREATE, '--no-start', 'x'], 0, { env: { FAKE_LABELS_REPO: 'fix' }, logHas: ['gh label create feat'] });
adapterCase('라벨이 있으면 만들지 않는다', [...CREATE, '--no-start', 'x'], 0, { logNot: ['gh label create'] });
adapterCase('-R 이 라벨 · 생성 명령에 전달된다', [...CREATE, '-R', 'o/r', '--no-start', 'x'], 0, { logHas: ['gh label list -R o/r', 'gh issue create -R o/r'] });
adapterCase('--start 는 담당자 · 시작 코멘트', [...CREATE, '--start'], 0, { logHas: ['gh issue edit 42 --add-assignee @me', 'gh issue comment 42 --body 작업 시작: '], logNot: ['git '], json: { start: 'started', number: '42', type: 'feat' } });
adapterCase('생성 실패는 종료 2', [...CREATE, '--start'], 2, { env: { FAKE_GH_FAIL: 'create' }, json: { status: 'error' } });
adapterCase('생성 뒤 시작 실패는 종료 3 + 번호', [...CREATE, '--start'], 3, { env: { FAKE_GH_FAIL: 'comment' }, json: { status: 'error', number: '42', start: 'failed', step: 'start' } });
adapterCase('--worktree 는 fetch 뒤 워크트리 분기', [...CREATE, '--start', '--worktree'], 0, { logHas: ['git fetch origin', 'git worktree add ../proj-feat-42 -b feat/42 origin/main'], json: { branch: 'feat/42', worktree: '../proj-feat-42' } });
adapterCase('--checkout 은 직접 체크아웃', [...CREATE, '--start', '--checkout', '--base', 'develop'], 0, { logHas: ['git fetch origin', 'git checkout -b feat/42 origin/develop'], logNot: ['worktree add'], json: { branch: 'feat/42' } });
adapterCase('--branch 가 기본 이름을 덮는다', [...CREATE, '--start', '--worktree', '--branch', 'feature/42'], 0, { logHas: ['-b feature/42 origin/main'] });
adapterCase('fetch 순서: worktree add 앞', [...CREATE, '--start', '--worktree'], 0);
{
  const r = run([...CREATE, '--start', '--worktree']);
  const ok = r.log.indexOf('git fetch origin') >= 0 && r.log.indexOf('git fetch origin') < r.log.indexOf('git worktree add');
  report(ok, '어댑터', 'fetch 가 worktree add 앞에 온다');
}
adapterCase('git 실패는 종료 3 (생성 뒤)', [...CREATE, '--start', '--worktree'], 3, { env: { FAKE_GIT_FAIL: '1' }, json: { start: 'failed' } });
adapterCase('--worktree 는 --start 와 함께만', [...CREATE, '--no-start', 'x', '--worktree'], 1, { logNot: ['gh issue create'] });
// start 단독
adapterCase('start: 타입 라벨에서 읽는다', ['start', '42', '--worktree'], 0, { env: { FAKE_ISSUE_LABELS: 'fix priority/high' }, logHas: ['-b fix/42 origin/main'], json: { type: 'fix' } });
adapterCase('start: 타입 라벨 둘 이상은 거부', ['start', '42'], 1, { env: { FAKE_ISSUE_LABELS: 'fix feat' }, logNot: ['issue edit'] });
adapterCase('start: 타입 라벨 없음은 거부', ['start', '42'], 1, { env: { FAKE_ISSUE_LABELS: 'priority/high' }, logNot: ['issue edit'] });
adapterCase('start: --type 명시는 라벨을 읽지 않는다', ['start', '42', '--type', 'docs'], 0, { logNot: ['issue view'], json: { type: 'docs' } });
adapterCase('start: 번호 없음은 거부', ['start', '--type', 'docs'], 1);
adapterCase('start: -R 전달', ['start', '42', '--type', 'docs', '-R', 'o/r'], 0, { logHas: ['gh issue edit 42 -R o/r', 'gh issue comment 42 -R o/r'] });
adapterCase('start: 브랜치 없이도 성공', ['start', '42', '--type', 'docs'], 0, { logNot: ['git '] });
adapterCase('start: gh 실패는 종료 2', ['start', '42', '--type', 'docs'], 2, { env: { FAKE_GH_FAIL: 'edit' }, json: { status: 'error', number: '42' } });
adapterCase('모르는 서브커맨드', ['close', '42'], 1);

rmSync(sandbox, { recursive: true, force: true });
console.log(failed ? `\n실패 ${failed}건` : `\n${count}건 전부 통과`);
process.exit(failed ? 1 : 0);
