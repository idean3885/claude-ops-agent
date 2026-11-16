/**
 * push-delegation.mjs — 대화창 문장으로 여는 세션 단위 push 위임 (#1046).
 *
 * 사람이 선언한 레포에서 사용자가 대화창에 「푸시 권한 위임」만 입력하면, 그 세션 · 그 레포의
 * `git-default-push` 갈래를 연다. 판정 근거는 사용자 입력 훅이 받은 사람의 입력이다.
 * 어시스턴트는 사용자 입력란에 글을 넣을 수 없으므로 「자연어 승인은 개방이 아니다」를 유지한다.
 *
 * 차용한 격리 기술 (docs/action-gate.md 「대화창 위임」):
 *   - Chrome DevTools 「allow pasting」: 정해진 문장을 직접 입력해야 열린다
 *   - sudo: 범위를 하나(터미널 → 세션)에 묶고 시간으로 닫는다
 *   - GitHub sudo mode: 열리는 작업을 목록으로 고정한다
 * 버린 것: Chrome 의 영구 · 프로필 전체 개방, GitHub 의 사용 시 연장(열어 두고 잊히는 길).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

/** 호출 문장. 메시지 전체가 이 문장일 때만 연다 (앞뒤 공백 제외) */
export const DELEGATION_PHRASE = '푸시 권한 위임';

/** 레포 선언으로 열 수 있는 갈래. 이 밖의 값은 선언에 적혀 있어도 무시한다 */
export const DELEGABLE_SCOPES = new Set(['git-default-push']);

/** 열린 뒤 닫히는 시간. 세션이 끝나도 닫힌다 (세션 번호 불일치) */
export const DELEGATION_TTL_MS = 8 * 60 * 60 * 1000;

/** 위임 기록 파일 경로를 가리는 정규식. 어시스턴트의 쓰기를 막을 때 쓴다 */
export const DELEGATION_FILE_RE = /push-delegation\.json$/;

/** `.git` 이 있는 상위 디렉토리 */
export function repoRootOf(dir) {
  let d = dir;
  for (let i = 0; d && i < 40; i++) {
    if (existsSync(join(d, '.git'))) return d;
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return null;
}

export function delegationPath(sessionId, home = homedir()) {
  const safe = String(sessionId || '').replace(/[^A-Za-z0-9_-]/g, '');
  return join(home, '.claude', 'ops-agent', '.cache', `${safe}.push-delegation.json`);
}

/** 레포 선언 `.ops-agent/repo-type.json` 의 `allow` 중 열 수 있는 갈래 */
export function declaredScopes(repoRoot) {
  if (!repoRoot) return [];
  try {
    const d = JSON.parse(readFileSync(join(repoRoot, '.ops-agent', 'repo-type.json'), 'utf8'));
    return Array.isArray(d.allow) ? d.allow.filter(s => DELEGABLE_SCOPES.has(s)) : [];
  } catch {
    return [];
  }
}

/** 메시지 전체가 호출 문장인가. 문장 중간 · 붙여 넣은 글 속은 아니다 */
export function isDelegationPrompt(prompt) {
  return typeof prompt === 'string' && prompt.trim() === DELEGATION_PHRASE;
}

/** 위임을 기록한다. 선언한 갈래가 없으면 기록하지 않고 null */
export function recordDelegation(sessionId, repoRoot, now = Date.now(), home = homedir()) {
  const scopes = declaredScopes(repoRoot);
  if (!sessionId || !repoRoot || !scopes.length) return null;
  const rec = { sessionId, repoRoot, scopes, expiresAt: now + DELEGATION_TTL_MS };
  const p = delegationPath(sessionId, home);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(rec) + '\n');
  return rec;
}

/** 이 세션 · 이 레포에 열린 갈래. 만료 · 다른 레포 · 선언이 빠졌으면 빈 목록 */
export function delegatedScopes(sessionId, repoRoot, now = Date.now(), home = homedir()) {
  if (!sessionId || !repoRoot) return [];
  const p = delegationPath(sessionId, home);
  if (!existsSync(p)) return [];
  try {
    const rec = JSON.parse(readFileSync(p, 'utf8'));
    if (rec.sessionId !== sessionId || rec.repoRoot !== repoRoot) return [];
    if (!rec.expiresAt || now > rec.expiresAt) return [];
    // 선언을 지우면 위임도 바로 닫힌다. 기록에 남은 갈래와 지금 선언의 교집합만 연다.
    const now_ = new Set(declaredScopes(repoRoot));
    return (rec.scopes || []).filter(s => now_.has(s));
  } catch {
    return [];
  }
}
