#!/usr/bin/env node
/**
 * selftest-git-guard-rules.mjs — git 위험 조작 판정 자체 점검.
 *
 * 브랜치 강제 삭제는 원격 기본 브랜치에 이미 들어 있으면 통과하고, 아니면 막는다 (#1204).
 * 판정이 실제 git 조회에 기대므로 임시 원격 · 복제본을 만들어 시험한다.
 *
 * 사용: node scripts/selftest-git-guard-rules.mjs
 * 종료 코드: 실패 1, 전부 통과 0
 */
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { detectGitRiskActions } from './git-guard-rules.mjs';

const root = mkdtempSync(join(tmpdir(), 'git-guard-'));
const origin = join(root, 'origin.git');
const work = join(root, 'work');
const sh = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });

sh(`git init -q --bare -b main ${origin}`);
sh(`git clone -q ${origin} ${work}`);
sh('git config user.email t@t && git config user.name t', work);
writeFileSync(join(work, 'a'), '1');
sh('git add a && git commit -qm base && git push -q origin main', work);
// 머지된 브랜치: 원격 main 에 들어간 뒤, 로컬은 다른 브랜치를 체크아웃해 -d 가 거부되는 상태를 만든다
sh('git checkout -qb merged && git commit -q --allow-empty -m m && git checkout -q main', work);
sh('git merge -q --no-ff merged -m merge && git push -q origin main && git reset -q --hard HEAD~1', work);
// 머지되지 않은 브랜치
sh('git checkout -qb unmerged && git commit -q --allow-empty -m u && git checkout -q main', work);
sh('git remote set-head origin main', work);

const runGit = args => {
  try {
    return execSync(`git ${args}`, { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
};
const blocked = cmd => detectGitRiskActions([cmd], { runGit }).some(op => op.verb === 'branch -D');

const CASES = [
  ['원격 기본 브랜치에 머지된 브랜치', 'git branch -D merged', false],
  ['머지되지 않은 브랜치', 'git branch -D unmerged', true],
  ['머지된 것과 안 된 것을 함께', 'git branch -D merged unmerged', true],
  ['없는 브랜치', 'git branch -D nothing', true],
  ['원격 브랜치 삭제', 'git branch -D -r origin/merged', true],
  ['--delete --force 형태 · 머지됨', 'git branch --delete --force merged', false],
];

let fail = 0;
for (const [name, cmd, want] of CASES) {
  const got = blocked(cmd);
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}: ${cmd} → ${got ? '차단' : '통과'}`);
}
// 원격 기본 브랜치를 모르고, 대신 쓰는 init.defaultBranch 이름의 원격 브랜치도 없으면 막는다
sh('git remote set-head origin -d && git config init.defaultBranch nowhere', work);
const unknown = blocked('git branch -D merged');
if (!unknown) fail++;
console.log(`${unknown ? 'OK  ' : 'FAIL'} 원격 기본 브랜치 미상: git branch -D merged → ${unknown ? '차단' : '통과'}`);

rmSync(root, { recursive: true, force: true });
console.log(`${CASES.length + 1 - fail}/${CASES.length + 1} 통과`);
process.exit(fail ? 1 : 0);
