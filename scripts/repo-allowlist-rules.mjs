/**
 * repo-allowlist-rules.mjs — 레포 허용 목록 판정 (#969).
 *
 * 도구 호출이 닿는 레포를 원격 주소(host/owner/repo)로 식별해 사용자가 등록한 목록과 대조한다.
 * 디렉토리 경로는 워크트리 · 새 클론마다 달라 키가 되지 못한다. 원격 주소는 같은 레포의 모든 사본에서 같다.
 *
 * 목록 파일: ~/.claude/ops-agent/repo-allowlist.local.json (테스트는 OPS_AGENT_REPO_ALLOWLIST 로 경로를 바꾼다)
 *   { "hosts": ["git.example.com"],          판정할 호스트. 없으면 모든 호스트를 판정한다
 *     "write": ["git.example.com/org/app"],  읽기 · 쓰기
 *     "read":  ["git.example.com/org/lib"] }  읽기 전용 (클론 · 조회 · 워크트리는 되고 수정 · 커밋 · 푸시 · PR 은 막는다)
 * 파일이 없으면 판정하지 않는다. 판정 호스트의 레포가 목록에 없으면 이미 클론돼 있어도 읽기부터 막는다.
 * git 레포가 아니거나 원격이 없는 경로는 판정하지 않는다.
 *
 * 훅은 매 도구 호출마다 돈다. 하위 프로세스를 띄우지 않고 .git 을 직접 읽는다.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import { homedir } from 'os';

export const ALLOWLIST_FILE_RE = /(?:^|[\\/])repo-allowlist(?:\.local)?\.json$/;
export const DENY_HEADER = '[ops-agent 레포 허용 목록 · 차단]';
// 등록은 사용자가 트리거한다. 어시스턴트는 명령 한 줄과 그 행위 · 대상을 제시하고 허락을 받는다 (#972)
export const REGISTER_HINT = '등록이 필요하면 등록 명령 한 줄과 그 명령이 하는 일 · 대상 레포 · 권한(쓰기 · 읽기 전용)을 사용자에게 설명하고 허락을 받습니다. 실행은 사용자가 `!` 로 합니다.';
const REGISTER_SCRIPT_RE = /(?:^|\/)repo-allowlist[\w.-]*\.sh$/;

export function allowlistPath() {
  return process.env.OPS_AGENT_REPO_ALLOWLIST || join(homedir(), '.claude', 'ops-agent', 'repo-allowlist.local.json');
}

export function loadAllowlist(path = allowlistPath()) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { return null; }
  const j = JSON.parse(raw); // 깨진 목록은 조용히 무시하지 않는다. 호출부가 오류로 알린다
  const set = xs => new Set((Array.isArray(xs) ? xs : []).map(normalizeRepo).filter(Boolean));
  const hosts = Array.isArray(j.hosts) && j.hosts.length ? new Set(j.hosts.map(h => String(h).toLowerCase())) : null;
  return { hosts, write: set(j.write), read: set(j.read) };
}

/** 원격 주소 · host/owner/repo → 소문자 host/owner/repo. 알아보지 못하면 null. */
export function normalizeRepo(url) {
  if (!url) return null;
  let s = String(url).trim();
  let m;
  if ((m = s.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/))) s = `${m[1]}/${m[2]}`;
  else if ((m = s.match(/^(?:[^@/]+@)?([^/:]+):(?!\d+\/)(.+)$/))) s = `${m[1]}/${m[2]}`;
  const parts = s.replace(/\/+$/, '').replace(/\.git$/, '').split('/').filter(Boolean);
  if (parts.length < 3) return null;
  return parts.slice(0, 3).join('/').toLowerCase();
}

const rootCache = new Map();

// git 디렉토리(워크트리 · 서브모듈이면 .git 파일이 가리키는 곳)에서 공용 디렉토리의 config 를 읽어 원격을 돌려준다.
function remoteOfGitEntry(gitEntry) {
  let gitDir = gitEntry;
  if (statSync(gitEntry).isFile()) {
    const m = readFileSync(gitEntry, 'utf8').match(/^gitdir:\s*(.+)$/m);
    if (!m) return null;
    gitDir = resolve(dirname(gitEntry), m[1].trim());
  }
  let common = gitDir;
  const cd = join(gitDir, 'commondir');
  if (existsSync(cd)) common = resolve(gitDir, readFileSync(cd, 'utf8').trim());
  let config;
  try { config = readFileSync(join(common, 'config'), 'utf8'); } catch { return null; }
  const remotes = [];
  let cur = null;
  for (const line of config.split('\n')) {
    const sec = line.match(/^\s*\[\s*remote\s+"([^"]+)"\s*\]/);
    if (sec) { cur = sec[1]; continue; }
    if (/^\s*\[/.test(line)) { cur = null; continue; }
    const u = cur && line.match(/^\s*url\s*=\s*(.+?)\s*$/);
    if (u) remotes.push([cur, u[1]]);
  }
  const pick = remotes.find(([n]) => n === 'origin') || remotes[0];
  return pick ? normalizeRepo(pick[1]) : null;
}

/** 경로가 속한 레포의 원격(host/owner/repo). 레포가 아니거나 원격이 없으면 null. 없는 경로는 가장 가까운 상위로 본다. */
export function repoOfPath(p) {
  if (!p) return null;
  let dir = p;
  for (let i = 0; i < 64 && !existsSync(dir); i++) {
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  try { dir = realpathSync(dir); } catch { return null; }
  const seen = [];
  for (let i = 0; dir && i < 64; i++) {
    if (rootCache.has(dir)) { const r = rootCache.get(dir); seen.forEach(d => rootCache.set(d, r)); return r; }
    seen.push(dir);
    const g = join(dir, '.git');
    if (existsSync(g)) {
      let r = null;
      try { r = remoteOfGitEntry(g); } catch { r = null; }
      seen.forEach(d => rootCache.set(d, r));
      return r;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  seen.forEach(d => rootCache.set(d, null));
  return null;
}

/** 판정. 통과면 null, 막으면 사유 문자열. */
export function judgeRepo(allow, repo, need) {
  if (!allow || !repo) return null;
  const host = repo.split('/')[0];
  if (allow.hosts && !allow.hosts.has(host)) return null;
  if (allow.write.has(repo)) return null;
  if (need === 'read' && allow.read.has(repo)) return null;
  return allow.read.has(repo) ? 'read-only' : 'unlisted';
}

// ─── 셸 명령 해석 ───

// 셸 인용 규칙으로 토큰을 나눈다. 따옴표는 벗긴다. 구분자(; && || | 줄바꿈)는 따로 '\0' 토큰으로 남긴다.
function tokenize(s) {
  const out = [];
  let cur = null;
  let q = null;
  const push = () => { if (cur !== null) out.push(cur); cur = null; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) { q = null; continue; }
      if (q === '"' && c === '\\' && i + 1 < s.length) { cur += s[++i]; continue; }
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; if (cur === null) cur = ''; continue; }
    if (c === '\\' && i + 1 < s.length) { if (s[i + 1] !== '\n') cur = (cur ?? '') + s[i + 1]; i++; continue; }
    if (c === '\n' || c === ';' || c === '|' || (c === '&' && s[i + 1] === '&')) {
      push(); out.push('\0');
      if ((c === '|' && s[i + 1] === '|') || c === '&') i++;
      continue;
    }
    if (c === '&') { push(); out.push('\0'); continue; }
    if (/\s/.test(c)) { push(); continue; }
    if (c === '>' || c === '<') {
      // 리다이렉트는 대상을 다음 토큰으로 떼어 낸다. 2>&1 같은 fd 복제는 대상이 아니다
      const fd = cur !== null && /^\d$/.test(cur) ? cur : null;
      if (fd !== null) cur = null; else push();
      let op = c;
      while (s[i + 1] === '>' || s[i + 1] === '<') op += s[++i];
      if (s[i + 1] === '&') { i++; while (i + 1 < s.length && /[\d-]/.test(s[i + 1])) i++; continue; }
      out.push({ redirect: op });
      continue;
    }
    cur = (cur ?? '') + c;
  }
  push();
  return out;
}

function segmentsOf(command) {
  const segs = [[]];
  for (const t of tokenize(command)) {
    if (t === '\0') { if (segs[segs.length - 1].length) segs.push([]); continue; }
    segs[segs.length - 1].push(t);
  }
  return segs.filter(s => s.length);
}

const expandHome = p => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
const looksLikeUrl = t => /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(t) || /^[^@/\s]+@[^:/\s]+:/.test(t);
const absPath = (cwd, t) => { const e = expandHome(t); return isAbsolute(e) ? e : resolve(cwd, e); };
const hasShellExpr = t => /[$`*?]/.test(t);

const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);
// 추적 내용 · 이력 · 원격을 바꾸는 서브커맨드. 브랜치 이동 · 워크트리 · fetch · pull 은 읽기 전용 레포에서도 된다
const GIT_WRITE = new Set([
  'commit', 'push', 'merge', 'rebase', 'cherry-pick', 'revert', 'reset', 'am', 'apply', 'add', 'rm', 'mv',
  'stash', 'clean', 'restore', 'notes', 'update-ref', 'commit-tree', 'filter-branch', 'replace',
]);
const GH_READ_VERBS = new Set(['view', 'list', 'diff', 'checks', 'status', 'download', 'watch', 'clone', 'checkout', 'search', 'browse']);
const GH_VALUE_OPTS = new Set(['-R', '--repo', '--hostname', '-X', '--method', '-H', '--header', '-q', '--jq', '-t', '--template',
  '-f', '--raw-field', '-F', '--field', '--input', '-b', '--body', '-F', '--body-file', '-t', '--title', '-B', '--base', '-H', '--head',
  '-l', '--label', '-a', '--assignee', '-m', '--milestone', '-p', '--project', '-r', '--reviewer', '-L', '--limit', '-s', '--state',
  '-A', '--author', '-S', '--search', '--json', '--type', '--structure', '--branch',
  '--no-start', '--cache', '-p', '--preview']);
// 레포를 대상으로 하는 gh 명령 묶음. 그 밖(auth · config · extension 등)은 작업 디렉토리 읽기로만 본다
const GH_REPO_GROUPS = new Set(['pr', 'issue', 'release', 'repo', 'label', 'workflow', 'run', 'secret', 'variable', 'cache', 'ruleset', 'attestation']);
const WRITE_CMDS = new Set(['rm', 'rmdir', 'mv', 'touch', 'mkdir', 'tee', 'truncate', 'chmod', 'chown', 'unlink', 'install', 'rsync', 'cp', 'ln', 'patch', 'dd']);
const LAST_ARG_WRITE = new Set(['cp', 'ln', 'install', 'rsync']);

function ghRepoArg(v, host) {
  if (!v || hasShellExpr(v)) return null;
  const parts = v.replace(/^https?:\/\//, '').split('/').filter(Boolean);
  if (parts.length >= 3) return normalizeRepo(parts.slice(0, 3).join('/'));
  if (parts.length === 2) return normalizeRepo(`${host}/${parts[0]}/${parts[1]}`);
  return null;
}

/** Bash 명령이 닿는 레포를 { repo, need, why } 로 모은다. */
export function bashTargets(command, hookCwd) {
  const targets = [];
  let cwd = hookCwd;
  const add = (path, need, why) => {
    const repo = repoOfPath(path);
    if (repo) targets.push({ repo, need, why });
  };
  for (const seg of segmentsOf(command)) {
    const env = {};
    let toks = seg.slice();
    const redirects = [];
    const words = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t && typeof t === 'object') {
        const target = toks[i + 1];
        if (typeof target === 'string' && !t.redirect.includes('<') && !hasShellExpr(target)) redirects.push(target);
        i++;
        continue;
      }
      words.push(t);
    }
    while (words.length) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
        const [k, ...v] = words.shift().split('=');
        env[k] = v.join('=');
      } else if (/^(?:sudo|env|command|exec|time|nohup)$/.test(words[0])) words.shift();
      // `bash <경로>/gh-issue.sh …` 처럼 셸로 감싼 스크립트는 스크립트를 명령으로 본다
      else if (/^(?:bash|sh|zsh)$/.test(words[0]) && words[1] && /(?:^|\/)gh-issue\.sh$/.test(words[1])) words.shift();
      else break;
    }
    if (!words.length) continue;
    const cmd = words[0].replace(/^.*\//, '');
    const args = words.slice(1);

    for (const r of redirects) add(absPath(cwd, r), 'write', `${cmd} 리다이렉트`);

    if (cmd === 'cd') {
      const a = args.find(x => !x.startsWith('-'));
      if (a && !hasShellExpr(a)) { cwd = absPath(cwd, a); add(cwd, 'read', 'cd'); }
      continue;
    }

    if (cmd === 'git') {
      let segCwd = cwd;
      let i = 0;
      for (; i < args.length; i++) {
        const a = args[i];
        if (!a.startsWith('-')) break;
        if (a === '-C' && args[i + 1] && !hasShellExpr(args[i + 1])) segCwd = absPath(segCwd, args[i + 1]);
        if (GIT_VALUE_OPTS.has(a)) i++;
      }
      const sub = args[i];
      const rest = args.slice(i + 1);
      if (sub === 'clone') {
        const src = rest.find(x => !x.startsWith('-'));
        if (!src || hasShellExpr(src)) continue;
        const repo = looksLikeUrl(src) ? normalizeRepo(src) : repoOfPath(absPath(segCwd, src));
        if (repo) targets.push({ repo, need: 'read', why: 'git clone' });
        continue;
      }
      let need = GIT_WRITE.has(sub) ? 'write' : 'read';
      if (sub === 'tag' && rest.some(x => !x.startsWith('-') || /^-[adsfm]/.test(x)) && !rest.includes('-l') && !rest.includes('--list')) need = 'write';
      if (sub === 'branch' && rest.some(x => /^-[dDmMcC]$|^--(?:delete|move|copy)$/.test(x))) need = 'write';
      add(segCwd, need, `git ${sub || ''}`.trim());
      continue;
    }

    if (cmd === 'gh' || /^gh-issue\.sh$/.test(cmd)) {
      const host = (env.GH_HOST || process.env.GH_HOST || 'github.com').toLowerCase();
      let repoOpt = null;
      let hostname = null;
      let method = null;
      let hasParams = false;
      const pos = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        const eq = a.match(/^(--[a-z-]+)=(.*)$/);
        const name = eq ? eq[1] : a;
        const val = eq ? eq[2] : args[i + 1];
        if (name === '-R' || name === '--repo') { repoOpt = val; if (!eq) i++; continue; }
        if (name === '--hostname') { hostname = val; if (!eq) i++; continue; }
        if (name === '-X' || name === '--method') { method = String(val).toUpperCase(); if (!eq) i++; continue; }
        if (/^(?:-f|--raw-field|-F|--field|--input)$/.test(name)) hasParams = true;
        if (a.startsWith('-')) { if (!eq && GH_VALUE_OPTS.has(a)) i++; continue; }
        pos.push(a);
      }
      const h = (hostname || host).toLowerCase();
      if (cmd !== 'gh') {
        // 이슈 어댑터: create · start 는 쓰기다
        const repo = repoOpt ? ghRepoArg(repoOpt, h) : repoOfPath(cwd);
        if (repo) targets.push({ repo, need: 'write', why: `${cmd} ${pos[0] || ''}`.trim() });
        continue;
      }
      const [group, verb] = pos;
      if (group === 'api') {
        const ep = (pos[1] || '').replace(/^\//, '');
        const m = ep.match(/^repos\/([^/]+)\/([^/?]+)/);
        if (!m || hasShellExpr(m[1] + m[2])) continue;
        const repo = normalizeRepo(`${h}/${m[1]}/${m[2]}`);
        const write = method ? method !== 'GET' && method !== 'HEAD' : hasParams;
        if (repo) targets.push({ repo, need: write ? 'write' : 'read', why: `gh api ${write ? method || 'POST' : 'GET'}` });
        continue;
      }
      const need = GH_REPO_GROUPS.has(group) && !GH_READ_VERBS.has(verb) ? 'write' : 'read';
      let repo = null;
      if (repoOpt) repo = ghRepoArg(repoOpt, h);
      else if (group === 'repo' && pos[2]) repo = ghRepoArg(pos[2], h);
      if (repo) targets.push({ repo, need, why: `gh ${group || ''} ${verb || ''}`.trim() });
      else if (group) add(cwd, need, `gh ${group} ${verb || ''}`.trim());
      continue;
    }

    // 그 밖의 명령: 작업 디렉토리는 읽기, 경로 인자는 명령 종류에 따라 읽기 · 쓰기
    add(cwd, 'read', cmd);
    const inPlace = (cmd === 'sed' || cmd === 'perl') && args.some(a => /^-[A-Za-z]*i/.test(a) || a.startsWith('--in-place'));
    const writes = WRITE_CMDS.has(cmd) || inPlace;
    const paths = args.filter(a => a && !a.startsWith('-') && !hasShellExpr(a) && !looksLikeUrl(a));
    // sed · perl 은 -e 가 없으면 첫 인자가 스크립트다
    if ((cmd === 'sed' || cmd === 'perl') && !args.some(a => /^-[A-Za-z]*e$/.test(a))) paths.shift();
    paths.forEach((a, idx) => {
      const isPathLike = a.includes('/') || a.startsWith('~') || a.startsWith('.');
      let need = 'read';
      if (writes) need = LAST_ARG_WRITE.has(cmd) ? (idx === paths.length - 1 ? 'write' : 'read') : 'write';
      if (need === 'read' && !isPathLike) return;
      add(absPath(cwd, a), need, cmd);
    });
  }
  return targets;
}

/** 등록 스크립트(repo-allowlist*.sh)를 조회(list) 밖의 인자로 실행하는 Bash 명령인지. */
export function runsRegisterScript(command) {
  for (const seg of segmentsOf(command || '')) {
    const words = seg.filter(t => typeof t === 'string');
    let i = 0;
    while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || /^(?:sudo|env|command|exec|time|nohup|bash|sh|zsh)$/.test(words[i]))) i++;
    if (i < words.length && REGISTER_SCRIPT_RE.test(words[i]) && words[i + 1] !== 'list') return true;
  }
  return false;
}

/** 도구 호출이 닿는 레포. */
export function toolTargets(toolName, toolInput, cwd) {
  const ti = toolInput || {};
  const pathOf = p => (typeof p === 'string' && p ? absPath(cwd, p) : null);
  const one = (p, need, why) => { const path = pathOf(p); const repo = path && repoOfPath(path); return repo ? [{ repo, need, why }] : []; };
  switch (toolName) {
    case 'Read': return one(ti.file_path, 'read', 'Read');
    case 'Grep': case 'Glob': case 'LS': return one(ti.path || cwd, 'read', toolName);
    case 'Edit': case 'Write': case 'MultiEdit': return one(ti.file_path, 'write', toolName);
    case 'NotebookEdit': return one(ti.notebook_path, 'write', toolName);
    case 'Bash': return bashTargets(ti.command || '', cwd);
    default: return [];
  }
}

/** 첫 위반을 사유 메시지로. 통과면 null. */
export function checkRepoAllowlist(allow, toolName, toolInput, cwd) {
  if (!allow) return null;
  for (const t of toolTargets(toolName, toolInput, cwd)) {
    const verdict = judgeRepo(allow, t.repo, t.need);
    if (!verdict) continue;
    const what = verdict === 'read-only'
      ? `${t.repo} 는 읽기 전용으로 등록돼 있습니다. 쓰기 호출입니다 (${t.why}).`
      : `${t.repo} 는 사용자가 등록한 레포가 아닙니다 (${t.need === 'write' ? '쓰기' : '읽기'} · ${t.why}).`;
    return `${DENY_HEADER} ${what}\n`
      + '등록하지 않은 레포는 클론 · 읽기 · 쓰기 모두 작업 대상이 아닙니다. 요청이 정말 이 레포를 가리키는지 사용자에게 확인합니다.\n'
      + REGISTER_HINT;
  }
  return null;
}
