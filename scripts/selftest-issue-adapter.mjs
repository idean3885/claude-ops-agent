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
  // #1067: 팀 템플릿 절 이름(Why? · What?) · 중첩 불릿 · 점검 기록 · 버전 표기
  ['ISS5 팀 템플릿 절 이름 (Why? · What?)', 'iss5', '# Spec Review\n\n## Why?\n* 사실 1\n* 사실 2\n* 기존 기록: 없음 · x\n\n## What?\n한 줄\n\n## Todo\n- [ ] 할 일\n', []],
  ['ISS5 Why 하위 불릿', 'iss5', ISS5_OK.replace('- 사실 2\n', '- 사실 2\n    - 하위\n'), ['why-nested']],
  ['ISS5 점검 기록 (날짜 + 실측)', 'iss5', ISS5_OK.replace('- 사실 2\n', '- 알파 실측 (2026-11-17) 결과 3초 지연\n'), ['inspection-record']],
  ['ISS5 날짜만 있는 사실은 통과', 'iss5', ISS5_OK.replace('- 사실 2\n', '- 2026-10-02 정리에서 가드가 지워졌다\n'), []],
  ['ISS5 Why 버전 표기', 'iss5', ISS5_OK.replace('- 사실 2\n', '- 에이전트 2.29.0 을 쓴다\n'), ['version']],
  ['ISS5 기존 기록 줄의 버전은 통과', 'iss5', ISS5_OK.replace('없음 · docs/adr', '9.58.0 에서 문서만 고쳤다'), []],
  ['ISS5 IP 주소는 버전이 아니다', 'iss5', ISS5_OK.replace('- 사실 2\n', '- 10.0.0.1 로 접속한다\n'), []],
  ['ISS5 Todo 의 버전은 통과', 'iss5', ISS5_OK + '\n## Todo\n- [ ] 2.29.0 지원 범위 확인\n', []],
  // 주장 검증 반례 (#1067)
  ['ISS5 점 표기 날짜는 버전이 아니다', 'iss5', ISS5_OK.replace('- 사실 2\n', '- 2026.11.17 회의에서 정했다\n'), []],
  ['ISS5 링크 주소 안의 버전은 통과', 'iss5', ISS5_OK.replace('- 사실 2\n', '- 원천: [릴리스](https://github.com/o/r/releases/tag/v9.58.0)\n'), []],
  ['ISS5 문장 끝 마침표가 붙은 버전', 'iss5', ISS5_OK.replace('- 사실 2\n', '- 에이전트는 2.29.0.\n'), ['version']],
  ['ISS5 v 를 붙인 두 자리 버전', 'iss5', ISS5_OK.replace('- 사실 2\n', '- 에이전트 v2.29 를 쓴다\n'), ['version']],
  ['ISS5 Why 아래 ### 하위 절의 버전', 'iss5', ISS5_OK + '\n### 세부\n- 2.29.0 을 쓴다\n', ['version']],
  ['ISS5 Todo 의 날짜 붙은 점검은 통과', 'iss5', ISS5_OK + '\n## Todo\n- [ ] 2026-12-01 정기 점검 전에 반영\n', []],
  ['ISS5 명사로 쓴 점검과 날짜는 통과', 'iss5', ISS5_OK.replace('- 사실 2\n', '- 자체 점검이 2026-10-02 정리 이후 비었다\n'), []],
  ['ISS5 점 표기 날짜의 점검 기록', 'iss5', ISS5_OK.replace('- 사실 2\n', '- 알파 실측 (2026.11.17) 3초 지연\n'), ['inspection-record']],
  // 2회차 반례
  ['ISS5 다른 ## 절 머리의 점검 기록', 'iss5', ISS5_OK + '\n## 알파 실측 (2026-11-17)\n- 3초 지연\n\n## Todo\n- [ ] x\n', ['inspection-record']],
  ['ISS5 점검 낱말과 날짜가 떨어진 점검 기록', 'iss5', ISS5_OK.replace('- 사실 2\n', '- 점검 일시: 2026-11-17, 3초 지연\n'), ['inspection-record']],
  ['ISS5 날짜가 앞에 온 점검 기록', 'iss5', ISS5_OK.replace('- 사실 2\n', '- 2026-11-17 알파 실측에서 3초 지연\n'), ['inspection-record']],
  ['ISS5 절 번호는 버전이 아니다', 'iss5', ISS5_OK.replace('- 사실 2\n', '- RFC 9110 15.5.1 절이 근거다\n'), []],
  ['ISS5 영문자에 붙인 버전', 'iss5', ISS5_OK.replace('- 사실 2\n', '- node22.1.0 을 쓴다\n'), ['version']],
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
  "issue view") case "$*" in *title,url*) printf '%s\\t%s\\n' "$FAKE_ISSUE_URL" "$FAKE_ISSUE_TITLE";; *) printf '%s\\n' $FAKE_ISSUE_LABELS;; esac;;
  "issue edit") [ "$FAKE_GH_FAIL" = edit ] && exit 1; exit 0;;
  "issue comment") [ "$FAKE_GH_FAIL" = comment ] && exit 1; exit 0;;
  "issue develop") [ "$FAKE_GH_FAIL" = develop ] && exit 1; exit 0;;
  *) exit 0;;
esac
`);
writeFileSync(join(bin, 'git'), `#!/bin/bash
echo "git $*" >> "$FAKE_LOG"
case "$1" in
  rev-parse) echo "$FAKE_TOPLEVEL";;
  fetch) exit 0;;
  ls-remote) case "$FAKE_REMOTE_BRANCH" in 1) exit 0;; 128) exit 128;; *) exit 2;; esac;;
  show-ref) [ "$FAKE_LOCAL_BRANCH" = 0 ] && exit 1; exit 0;;
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
      FAKE_LABELS_REPO: 'feat fix', FAKE_ISSUE_LABELS: '', FAKE_GH_FAIL: '', FAKE_GIT_FAIL: '',
      // 세션 인덱스를 실제 홈에 쓰지 않는다. 세션 번호는 인덱스 사례만 넣는다
      HOME: sandbox, CLAUDE_CODE_SESSION_ID: '', ...env,
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
{
  // #1090: 한글과 붙은 한자가 든 제목 · 본문은 구조 검사보다 먼저 멈춘다
  const hanBody = join(sandbox, 'han.md');
  writeFileSync(hanBody, ISS5_OK.replace('- 사실 1\n', '- 남은 일은 외部 대기\n'));
  adapterCase('본문의 한자 섞임은 생성하지 않는다 (HI-4)', ['create', '--title', 't', '--body-file', hanBody, '--type', 'feat', '--no-start', 'x'], 1, { logNot: ['gh issue create', 'gh label'], json: { step: 'han-intrusion' } });
  adapterCase('제목의 한자 섞임은 생성하지 않는다 (HI-4)', ['create', '--title', '외部 연동', '--body-file', okBody, '--type', 'feat', '--no-start', 'x'], 1, { logNot: ['gh issue create'], json: { step: 'han-intrusion' } });
}
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
adapterCase('--worktree 는 이슈 연결 브랜치를 만들고 그 브랜치로 워크트리', [...CREATE, '--start', '--worktree'], 0, { logHas: ['gh issue develop 42 --name feat/42 --base main', 'git fetch origin', 'git worktree add ../proj-feat-42 -b feat/42 --track origin/feat/42'], json: { branch: 'feat/42', worktree: '../proj-feat-42', bundled: 'undefined' } });
adapterCase('--checkout 은 이슈 연결 브랜치로 직접 체크아웃', [...CREATE, '--start', '--checkout', '--base', 'develop'], 0, { logHas: ['gh issue develop 42 --name feat/42 --base develop', 'git fetch origin', 'git checkout -b feat/42 --track origin/feat/42'], logNot: ['worktree add'], json: { branch: 'feat/42' } });
adapterCase('--branch 가 기본 이름을 덮는다', [...CREATE, '--start', '--worktree', '--branch', 'feature/42'], 0, { logHas: ['--name feature/42 --base main', '-b feature/42 --track origin/feature/42'] });
adapterCase('이슈 연결 브랜치 생성 실패는 종료 3 (생성 뒤)', [...CREATE, '--start', '--worktree'], 3, { env: { FAKE_GH_FAIL: 'develop' }, logNot: ['worktree add'], json: { start: 'failed' } });
adapterCase('start: -R 이 이슈 연결 브랜치 생성에 전달된다', ['start', '42', '--type', 'docs', '-R', 'o/r', '--worktree'], 0, { logHas: ['gh issue develop 42 -R o/r --name docs/42'] });
adapterCase('start: 원격에 있는 브랜치(세션 묶음)는 이슈 연결 브랜치를 만들지 않고 그 브랜치로 체크아웃', ['start', '43', '--type', 'docs', '--checkout', '--branch', 'fix/42'], 0, { env: { FAKE_REMOTE_BRANCH: '1' }, logHas: ['git ls-remote --exit-code origin refs/heads/fix/42', 'git fetch origin', 'git checkout fix/42'], logNot: ['issue develop', 'checkout -b'], json: { branch: 'fix/42', bundled: 'true' } });
adapterCase('start: 원격에 있는 브랜치(세션 묶음)는 -b 없이 워크트리', ['start', '43', '--type', 'docs', '--worktree', '--branch', 'fix/42'], 0, { env: { FAKE_REMOTE_BRANCH: '1' }, logHas: ['git worktree add ../proj-docs-43 fix/42'], logNot: ['issue develop', ' -b '], json: { bundled: 'true' } });
adapterCase('start: 원격에만 있는 묶음 브랜치는 origin 을 명시해 연다', ['start', '43', '--type', 'docs', '--checkout', '--branch', 'fix/42'], 0, { env: { FAKE_REMOTE_BRANCH: '1', FAKE_LOCAL_BRANCH: '0' }, logHas: ['git checkout -b fix/42 --track origin/fix/42'], logNot: ['issue develop'], json: { bundled: 'true' } });
adapterCase('start: 원격에만 있는 묶음 브랜치는 워크트리도 origin 을 명시해 연다', ['start', '43', '--type', 'docs', '--worktree', '--branch', 'fix/42'], 0, { env: { FAKE_REMOTE_BRANCH: '1', FAKE_LOCAL_BRANCH: '0' }, logHas: ['git worktree add ../proj-docs-43 -b fix/42 --track origin/fix/42'], logNot: ['issue develop'], json: { bundled: 'true' } });
adapterCase('start: 자기 기본 브랜치를 다시 연 재시작은 묶음이 아니다', ['start', '43', '--type', 'docs', '--checkout'], 0, { env: { FAKE_REMOTE_BRANCH: '1' }, logHas: ['git checkout docs/43'], logNot: ['issue develop'], json: { branch: 'docs/43', bundled: 'undefined' } });
adapterCase('start: 원격 브랜치 조회 오류는 이슈 연결 브랜치 생성 전에 멈춘다', ['start', '43', '--type', 'docs', '--checkout', '--branch', 'fix/42'], 2, { env: { FAKE_REMOTE_BRANCH: '128' }, logNot: ['issue develop', 'git checkout'], json: { status: 'error' } });
adapterCase('브랜치 없는 시작은 이슈 연결 브랜치를 만들지 않는다', [...CREATE, '--start'], 0, { logNot: ['issue develop'] });
adapterCase('fetch 순서: worktree add 앞', [...CREATE, '--start', '--worktree'], 0);
{
  const r = run([...CREATE, '--start', '--worktree']);
  const ok = r.log.indexOf('git fetch origin') >= 0 && r.log.indexOf('git fetch origin') < r.log.indexOf('git worktree add');
  report(ok, '어댑터', 'fetch 가 worktree add 앞에 온다');
  const dev = r.log.indexOf('gh issue develop');
  report(dev >= 0 && dev < r.log.indexOf('git fetch origin'), '어댑터', '이슈 연결 브랜치를 만든 뒤 fetch 한다');
}
adapterCase('git 실패는 종료 3 (생성 뒤)', [...CREATE, '--start', '--worktree'], 3, { env: { FAKE_GIT_FAIL: '1' }, json: { start: 'failed' } });
adapterCase('--worktree 는 --start 와 함께만', [...CREATE, '--no-start', 'x', '--worktree'], 1, { logNot: ['gh issue create'] });
// start 단독
adapterCase('start: 타입 라벨에서 읽는다', ['start', '42', '--worktree'], 0, { env: { FAKE_ISSUE_LABELS: 'fix priority/high' }, logHas: ['--name fix/42 --base main', '-b fix/42 --track origin/fix/42'], json: { type: 'fix' } });
adapterCase('start: 타입 라벨 둘 이상은 거부', ['start', '42'], 1, { env: { FAKE_ISSUE_LABELS: 'fix feat' }, logNot: ['issue edit'] });
adapterCase('start: 타입 라벨 없음은 거부', ['start', '42'], 1, { env: { FAKE_ISSUE_LABELS: 'priority/high' }, logNot: ['issue edit'] });
adapterCase('start: --type 명시는 라벨을 읽지 않는다', ['start', '42', '--type', 'docs'], 0, { logNot: ['issue view'], json: { type: 'docs' } });
adapterCase('start: 번호 없음은 거부', ['start', '--type', 'docs'], 1);
adapterCase('start: -R 전달', ['start', '42', '--type', 'docs', '-R', 'o/r'], 0, { logHas: ['gh issue edit 42 -R o/r', 'gh issue comment 42 -R o/r'] });
adapterCase('start: 브랜치 없이도 성공', ['start', '42', '--type', 'docs'], 0, { logNot: ['git '] });
adapterCase('start: gh 실패는 종료 2', ['start', '42', '--type', 'docs'], 2, { env: { FAKE_GH_FAIL: 'edit' }, json: { status: 'error', number: '42' } });
adapterCase('모르는 서브커맨드', ['close', '42'], 1);

// 세션 인덱스 (#1050): 생성 · 시작이 성공하면 세션 파일에 한 줄씩. 어시스턴트가 아니라 어댑터가 쓴다
const idxDir = join(sandbox, '.claude', 'ops-agent', '.cache', 'session-issues');
function indexRows(sid) {
  const p = join(idxDir, `${sid}.jsonl`);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}
function indexCase(name, args, sid, want, env = {}) {
  rmSync(idxDir, { recursive: true, force: true });
  const r = run(args, { CLAUDE_CODE_SESSION_ID: sid, ...env });
  const got = indexRows(sid.replace(/[^A-Za-z0-9_-]/g, '')).map(x => `${x.repo}|${x.number}|${x.title}|${x.action}`);
  const ok = JSON.stringify(got) === JSON.stringify(want);
  report(ok, '세션 인덱스', name, ok ? '' : `want ${JSON.stringify(want)} got ${JSON.stringify(got)} (종료 ${r.code})`);
}
indexCase('--no-start 생성은 생성 한 줄', [...CREATE, '--no-start', '후속'], 'sid-1', ['o/r|42|t|생성']);
indexCase('--start 생성은 생성 · 시작 두 줄 (제목을 다시 조회하지 않는다)', [...CREATE, '--start'], 'sid-1', ['o/r|42|t|생성', 'o/r|42|t|시작']);
{
  rmSync(idxDir, { recursive: true, force: true });
  const r = run([...CREATE, '--start'], { CLAUDE_CODE_SESSION_ID: 'sid-1' });
  report(!r.log.includes('--json title,url'), '세션 인덱스', '생성에서 이어진 시작은 issue view 를 부르지 않는다');
}
indexCase('단독 시작은 제목 · 주소를 조회해 한 줄', ['start', '42', '--type', 'docs'], 'sid-1', ['o/r|42|제목 하나|시작'], { FAKE_ISSUE_URL: 'https://github.com/o/r/issues/42', FAKE_ISSUE_TITLE: '제목 하나' });
indexCase('github.com 밖 호스트는 host/owner/repo', ['start', '5', '--type', 'docs'], 'sid-1', ['ghe.example/o/r|5|x|시작'], { FAKE_ISSUE_URL: 'https://ghe.example/o/r/issues/5', FAKE_ISSUE_TITLE: 'x' });
indexCase('세션 번호가 없으면 쓰지 않는다', [...CREATE, '--start'], '', []);
indexCase('본문 검사 실패(생성 안 됨)는 쓰지 않는다', ['create', '--title', 't', '--body-file', badBody, '--type', 'feat', '--start'], 'sid-1', []);
indexCase('생성 실패는 쓰지 않는다', [...CREATE, '--start'], 'sid-1', [], { FAKE_GH_FAIL: 'create' });
indexCase('시작 실패는 생성 줄만', [...CREATE, '--start'], 'sid-1', ['o/r|42|t|생성'], { FAKE_GH_FAIL: 'comment' });
indexCase('세션 번호의 경로 문자는 걷는다', [...CREATE, '--no-start', 'x'], '../sid-2', ['o/r|42|t|생성']);
{
  rmSync(idxDir, { recursive: true, force: true });
  run([...CREATE, '--no-start', 'x'], { CLAUDE_CODE_SESSION_ID: 'sid-a' });
  run(['start', '42', '--type', 'docs'], { CLAUDE_CODE_SESSION_ID: 'sid-a', FAKE_ISSUE_URL: 'https://github.com/o/r/issues/42', FAKE_ISSUE_TITLE: 't' });
  run([...CREATE, '--no-start', 'x'], { CLAUDE_CODE_SESSION_ID: 'sid-b' });
  report(indexRows('sid-a').length === 2 && indexRows('sid-b').length === 1, '세션 인덱스', '호출이 쌓이고 세션마다 파일이 나뉜다');
}
{
  // 인덱스 디렉토리를 만들 수 없어도 어댑터 결과는 그대로다
  rmSync(join(sandbox, '.claude'), { recursive: true, force: true });
  writeFileSync(join(sandbox, '.claude'), 'not a dir');
  const r = run([...CREATE, '--no-start', 'x'], { CLAUDE_CODE_SESSION_ID: 'sid-1' });
  report(r.code === 0 && r.json && r.json.status === 'ok', '세션 인덱스', '인덱스 쓰기 실패는 결과를 바꾸지 않는다', `종료 ${r.code}`);
  rmSync(join(sandbox, '.claude'), { force: true });
}
{
  // 디렉토리는 있는데 파일에 덧붙이기가 실패해도(그 자리가 디렉토리) 어댑터 결과는 그대로다
  rmSync(idxDir, { recursive: true, force: true });
  mkdirSync(join(idxDir, 'sid-1.jsonl'), { recursive: true });
  const r = run([...CREATE, '--no-start', 'x'], { CLAUDE_CODE_SESSION_ID: 'sid-1' });
  report(r.code === 0 && r.json && r.json.status === 'ok' && r.json.number === '42' && r.json.start === 'skipped', '세션 인덱스', '인덱스 파일 덧붙이기 실패는 결과를 바꾸지 않는다', `종료 ${r.code}`);
  rmSync(idxDir, { recursive: true, force: true });
}

rmSync(sandbox, { recursive: true, force: true });
console.log(failed ? `\n실패 ${failed}건` : `\n${count}건 전부 통과`);
process.exit(failed ? 1 : 0);
