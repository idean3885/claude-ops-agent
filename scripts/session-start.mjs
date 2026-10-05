#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';
import { homedir } from 'os';

// Read hook input from stdin
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) {
  input += chunk;
}

const data = JSON.parse(input);
const cwd = data.cwd || process.cwd();
const opsAgentGlobal = join(homedir(), '.claude', 'ops-agent');

// Resolve plugin root from script location
const scriptDir = new URL('.', import.meta.url).pathname;
const pluginRoot = resolve(scriptDir, '..');

// --- Plugin self-maintenance: ensure .git exists for development workflow ---
function ensurePluginGit() {
  const gitDir = join(pluginRoot, '.git');
  if (existsSync(gitDir)) return;
  try {
    const marketplacePath = join(pluginRoot, '.claude-plugin', 'marketplace.json');
    if (!existsSync(marketplacePath)) return;
    const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf8'));
    const repoUrl = marketplace.repository?.url;
    if (!repoUrl) return;
    execSync('git init', { cwd: pluginRoot, timeout: 5000, stdio: 'ignore' });
    execSync(`git remote add origin ${repoUrl}`, { cwd: pluginRoot, timeout: 5000, stdio: 'ignore' });
    execSync('git fetch origin', { cwd: pluginRoot, timeout: 10000, stdio: 'ignore' });
    // Detect default branch (main or master)
    let defaultBranch = 'main';
    try {
      const refs = execSync('git ls-remote --symref origin HEAD', { cwd: pluginRoot, encoding: 'utf8', timeout: 5000 });
      const branchMatch = refs.match(/refs\/heads\/(\S+)/);
      if (branchMatch) defaultBranch = branchMatch[1];
    } catch { /* fallback to main */ }
    execSync(`git reset --mixed origin/${defaultBranch}`, { cwd: pluginRoot, timeout: 5000, stdio: 'ignore' });
  } catch { /* non-critical */ }
}

// --- Provider detection ---
function detectProvider() {
  try {
    const remote = execSync('git remote get-url origin', { cwd, encoding: 'utf8', timeout: 3000 }).trim();
    const match = remote.match(/[@/]([^:/]+)[:/]/);
    if (match) return match[1];
  } catch { /* No git or no remote */ }
  return null;
}

function findProvider(host) {
  if (!host) return { name: 'github', source: 'default' };

  // Local providers first (~/.claude/ops-agent/providers/)
  const localProviders = join(opsAgentGlobal, 'providers');
  if (existsSync(localProviders)) {
    for (const file of readdirSync(localProviders).filter(f => f.endsWith('.md'))) {
      try {
        const content = readFileSync(join(localProviders, file), 'utf8');
        const hostMatch = content.match(/hostPattern\s*\|?\s*[`"]([^`"]+)[`"]/i);
        if (hostMatch && host.includes(hostMatch[1].trim())) {
          return { name: file.replace('.md', ''), source: 'local', host: hostMatch[1].trim() };
        }
      } catch { /* skip */ }
    }
  }

  // Built-in providers (plugin/providers/)
  const builtinProviders = join(pluginRoot, 'providers');
  if (existsSync(builtinProviders)) {
    for (const file of readdirSync(builtinProviders).filter(f => f.endsWith('.md') && f !== 'PROVIDER.md')) {
      try {
        const content = readFileSync(join(builtinProviders, file), 'utf8');
        const hostMatch = content.match(/hostPattern\s*\|?\s*[`"]([^`"]+)[`"]/i);
        if (hostMatch && host.includes(hostMatch[1].trim())) {
          return { name: file.replace('.md', ''), source: 'builtin', host: hostMatch[1].trim() };
        }
      } catch { /* skip */ }
    }
  }

  return { name: 'github', source: 'default' };
}

function loadOverlay(host) {
  if (!host) return null;
  const overlayPath = join(opsAgentGlobal, 'overlays', `${host}.json`);
  if (existsSync(overlayPath)) {
    try { return JSON.parse(readFileSync(overlayPath, 'utf8')); }
    catch { /* skip */ }
  }
  return null;
}

// --- Git identity detection from provider ---
function detectGitIdentity(provider, host) {
  let providerPath;
  if (provider.source === 'local') {
    providerPath = join(opsAgentGlobal, 'providers', `${provider.name}.md`);
  } else {
    providerPath = join(pluginRoot, 'providers', `${provider.name}.md`);
  }

  if (!existsSync(providerPath)) return null;

  const content = readFileSync(providerPath, 'utf8');
  const nameMatch = content.match(/user\.name\s*\|\s*`([^`]+)`/);
  const emailMatch = content.match(/user\.email\s*\|\s*`([^`]+)`/);

  if (!nameMatch || !emailMatch) return null;

  let credentialUser = null;
  if (host) {
    try {
      const ghOutput = execSync(`gh auth status --hostname ${host} 2>&1`, { encoding: 'utf8', timeout: 3000 });
      const userMatch = ghOutput.match(/Logged in to .+ account (\S+)/);
      if (userMatch) credentialUser = userMatch[1];
    } catch { /* gh not available */ }
  }

  return { name: nameMatch[1], email: emailMatch[1], credentialUser, host };
}

// --- Build skill trigger context for message injection ---
function buildSkillContext(provider) {
  const skillsDir = join(pluginRoot, 'skills');
  if (!existsSync(skillsDir)) return '';

  let providerPath = join(pluginRoot, 'providers', 'github.md');
  if (provider.source === 'local') {
    const localPath = join(opsAgentGlobal, 'providers', `${provider.name}.md`);
    if (existsSync(localPath)) providerPath = localPath;
  } else if (provider.source === 'builtin') {
    const builtinPath = join(pluginRoot, 'providers', `${provider.name}.md`);
    if (existsSync(builtinPath)) providerPath = builtinPath;
  }

  // 표에 싣는 스킬은 여기서 고르되, 트리거 문구는 각 SKILL.md 가 원천이다.
  // 키워드를 여기에 복제하면 스킬 쪽 변경이 표에 반영되지 않은 채로 남고,
  // 빠진 키워드로 부른 요청은 인접 스킬로 새어 그 스킬의 게이트가 조용히 건너뛰어진다.
  const TABLE_SKILLS = [
    { name: 'flow', extra: 'natural language change request' },
    { name: 'org-flow' },
    { name: 'setup' },
  ];

  const rows = TABLE_SKILLS.map(({ name, extra }) => {
    const skillPath = join(skillsDir, name, 'SKILL.md');
    const triggers = readSkillTriggers(skillPath);
    if (!triggers) return '';
    return `| ${extra ? `${triggers}, ${extra}` : triggers} | ${skillPath} |`;
  }).filter(Boolean);

  if (rows.length === 0) return '';

  return [
    '',
    'Natural language skill triggers — on match, read the guide file and follow its workflow.',
    'Do NOT mention plugin name to the user. Provider file MUST be read before any API call.',
    '',
    `Provider: ${providerPath}`,
    '',
    '| Trigger | Guide |',
    '|---------|-------|',
    ...rows,
  ].join('\n');
}

// SKILL.md frontmatter 의 description 에서 `트리거 ...` 뒤의 인용 목록을 그대로 읽는다.
function readSkillTriggers(skillPath) {
  if (!existsSync(skillPath)) return '';
  let description;
  try {
    const head = readFileSync(skillPath, 'utf8').split('---')[1] || '';
    description = (head.match(/^description:\s*(.+)$/m) || [])[1] || '';
  } catch {
    return '';
  }
  const after = description.split(/트리거\s*/)[1];
  if (!after) return '';
  const quoted = after.match(/"[^"]+"/g);
  return quoted ? quoted.join(', ') : '';
}

// --- Auto-sync plugin version in installed_plugins.json (no dir rename) ---
function syncPluginVersion() {
  try {
    const versionFile = join(pluginRoot, 'VERSION');
    if (!existsSync(versionFile)) return;
    const currentVersion = readFileSync(versionFile, 'utf8').trim();

    const installedPath = join(homedir(), '.claude', 'plugins', 'installed_plugins.json');
    if (!existsSync(installedPath)) return;

    const installed = JSON.parse(readFileSync(installedPath, 'utf8'));
    const entry = installed.plugins?.['ops-agent@ops-agent']?.[0];
    if (!entry || entry.version === currentVersion) return; // already in sync

    entry.version = currentVersion;
    entry.lastUpdated = new Date().toISOString();
    try {
      const sha = execSync('git rev-parse HEAD', { cwd: pluginRoot, encoding: 'utf8', timeout: 3000 }).trim();
      entry.gitCommitSha = sha;
    } catch { /* skip */ }
    writeFileSync(installedPath, JSON.stringify(installed, null, 2) + '\n');
  } catch { /* non-critical */ }
}

// --- Auto-set git config on plugin repo based on its own remote ---
function ensurePluginGitIdentity() {
  try {
    const remote = execSync('git remote get-url origin', { cwd: pluginRoot, encoding: 'utf8', timeout: 3000 }).trim();
    const hostMatch = remote.match(/[@/]([^:/]+)[:/]/);
    if (!hostMatch) return;
    const pluginHost = hostMatch[1];
    const pluginProvider = findProvider(pluginHost);
    const identity = detectGitIdentity(pluginProvider, pluginHost);
    if (!identity) return;

    const currentName = execSync('git config user.name', { cwd: pluginRoot, encoding: 'utf8', timeout: 1000 }).trim();
    const currentEmail = execSync('git config user.email', { cwd: pluginRoot, encoding: 'utf8', timeout: 1000 }).trim();
    if (currentName !== identity.name) {
      execSync(`git config user.name "${identity.name}"`, { cwd: pluginRoot, timeout: 1000, stdio: 'ignore' });
    }
    if (currentEmail !== identity.email) {
      execSync(`git config user.email "${identity.email}"`, { cwd: pluginRoot, timeout: 1000, stdio: 'ignore' });
    }
  } catch { /* non-critical — git config may not be set yet */ }
}

// --- Cleanup stale version directories ---
// 자기 버전보다 **낮은** 버전만 정리한다. 같거나 높은 버전은 건드리지 않는다.
// 이전 구현은 이름이 다르면 전부 지웠다. 그래서 릴리스 직후 구버전 세션의 SessionStart 가
// 방금 설치된 신버전을 지워, 동기 스크립트가 성공을 보고한 뒤에도 캐시가 구버전으로 남았다.
//
// 삭제한 자리에는 현재 버전을 가리키는 심볼릭을 남긴다. 옛 경로를 잡고 있는 활성 세션의
// hook 호출이 ENOENT 로 실패하지 않고 신버전 코드를 해소한다.
function parseSemver(name) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(name);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function cleanupStaleVersions() {
  try {
    const cacheParent = resolve(pluginRoot, '..');
    const currentDir = pluginRoot.split('/').pop();
    const current = parseSemver(currentDir);
    // 버전 디렉토리가 아니면(워크트리·개발 경로) 비교 기준이 없다. 아무것도 지우지 않는다.
    if (!current) return;

    for (const dir of readdirSync(cacheParent)) {
      if (dir === currentDir) continue;
      const other = parseSemver(dir);
      if (!other) continue;
      if (compareSemver(other, current) >= 0) continue;

      const target = join(cacheParent, dir);
      // 이미 심볼릭이면 옛 경로 연결 장치다. 그대로 둔다.
      if (lstatSync(target).isSymbolicLink()) continue;

      execSync(`rm -rf "${target}"`, { timeout: 5000, stdio: 'ignore' });
      execSync(`ln -sfn "${currentDir}" "${target}"`, { timeout: 1000, stdio: 'ignore' });
    }
  } catch { /* non-critical */ }
}

// --- Migrate legacy .omc/state/ to .ops-agent/state/ (5.0.0 rename) ---
// 워크트리 state 경로 컨벤션이 5.0.0 에서 변경되었다.
// cwd 또는 worktree 루트에 .omc/state/ 가 남아 있고 .ops-agent/state/ 가 없으면 1회 이동.
// .ops-agent/state/ 가 이미 있으면 사용자가 수동 처리한 것으로 간주하고 건드리지 않음.
function migrateOmcStateToOpsAgent() {
  try {
    const legacy = join(cwd, '.omc', 'state');
    const target = join(cwd, '.ops-agent', 'state');
    if (!existsSync(legacy)) return;
    if (existsSync(target)) return; // 사용자 수동 처리분 보존
    execSync(`mkdir -p "${join(cwd, '.ops-agent')}"`, { timeout: 1000, stdio: 'ignore' });
    execSync(`mv "${legacy}" "${target}"`, { timeout: 2000, stdio: 'ignore' });
    // .omc 디렉토리가 비었으면 정리
    try { execSync(`rmdir "${join(cwd, '.omc')}" 2>/dev/null`, { timeout: 1000, stdio: 'ignore' }); } catch { /* skip */ }
  } catch { /* non-critical */ }
}

// --- Maintain ~/.claude/ops-agent/current -> active plugin root ---
// 소비자와 안내 문구가 참조할 버전 무관 진입점 하나. 캐시 디렉토리 이름은 버전이라
// 갱신 때마다 바뀌고, 소비자가 글롭으로 찾으면 정렬 규칙에 따라 낡은 버전을 집는다.
// 안내 문구에 버전이 들어가면 그 문구를 복사해 둔 사용자가 나중에 옛 스크립트를 실행한다.
//
// cleanupStaleVersions 는 이미 설치됐던 버전 디렉토리만 잇는다. 한 번도 설치된 적 없는
// 버전이 문구에 들어가면 그 경로는 없다. 고정 경로는 그 조건에 걸리지 않는다.
function linkCurrentRoot() {
  try {
    // 설치된 플러그인만 이 링크의 주인이다. 개발 워크트리에서 이 스크립트를 실행해도
    // 링크가 그쪽으로 넘어가지 않는다. 넘어가면 워크트리를 지운 뒤 링크가 끊기고,
    // 그 시점에 게이트 안내가 없는 경로를 싣는다.
    if (!parseSemver(pluginRoot.split('/').pop())) return;
    execSync(`mkdir -p "${opsAgentGlobal}"`, { timeout: 1000, stdio: 'ignore' });
    execSync(`ln -sfn "${pluginRoot}" "${join(opsAgentGlobal, 'current')}"`, { timeout: 1000, stdio: 'ignore' });
  } catch { /* non-critical */ }
}

// --- Mirror style-rules SSOT to ~/.claude/ops-agent/style-rules/ ---
// ops-agent 의 base/extensions 룰을 사용자 스코프로 미러링한다.
// 외부 어댑터 등 소비자는 이 경로를 참조한다 (ops-agent 캐시 버전 디렉토리는 갱신 시 바뀌므로).
// *.local.* 파일은 사용자 추가 룰이므로 덮어쓰지 않는다.
//
// 미러는 세션별 스냅숏이 아니라 고정 경로 하나이므로 마지막 기록자가 이긴다. 새 세션이 열리면
// 진행 중인 다른 세션도 즉시 새 규칙을 읽는다. 그래서 소비자가 알아야 하는 것은 갱신 시점이
// 아니라 지금 읽는 규칙이 몇 버전인가다. VERSION 을 함께 기록해 그것을 판정할 수 있게 한다.
// 없으면 이미 고쳐진 결함을 다시 제기하게 된다 (#207).
function mirrorStyleRules() {
  try {
    const src = join(pluginRoot, 'config', 'style-rules');
    if (!existsSync(src)) return;
    const dst = join(opsAgentGlobal, 'style-rules');
    execSync(`mkdir -p "${dst}/base" "${dst}/extensions"`, { timeout: 1000, stdio: 'ignore' });

    for (const sub of ['base', 'extensions']) {
      const subSrc = join(src, sub);
      const subDst = join(dst, sub);
      if (!existsSync(subSrc)) continue;
      for (const file of readdirSync(subSrc)) {
        if (file.includes('.local.')) continue; // 사용자 로컬 룰 보호
        const srcPath = join(subSrc, file);
        const dstPath = join(subDst, file);
        const content = readFileSync(srcPath, 'utf8');
        writeFileSync(dstPath, content);
      }
    }

    // 파일별 역할 색인(README.md)도 함께 미러한다. 미러만 보는 소비자가 어느 파일이
    // 무엇을 다루는지 찾을 자리가 없으면 base/extensions 를 전수로 열게 된다.
    for (const file of readdirSync(src)) {
      if (!file.endsWith('.md') || file.includes('.local.')) continue;
      writeFileSync(join(dst, file), readFileSync(join(src, file), 'utf8'));
    }

    // 미러가 어느 버전의 규칙인지 남긴다. 소스에 VERSION 이 없으면 낡은 값이 남지 않게 쓰지 않는다.
    const versionSrc = join(pluginRoot, 'VERSION');
    if (existsSync(versionSrc)) {
      writeFileSync(join(dst, 'VERSION'), readFileSync(versionSrc, 'utf8').trim() + '\n');
    }
  } catch { /* non-critical */ }
}

// --- Assemble global ~/.claude/CLAUDE.md from managed fragments ---
// 분리 조립: ops-agent 가 퍼블릭 base 조각을 ~/.claude/global-md/00-ops-agent-base.md 로 기록하고,
// 외부 소비자(사내 어댑터 등)는 NN-*.md 규약으로 같은 디렉토리에 자기 조각을 둔다.
// 조각들을 파일명 순으로 마커와 함께 연결 + 로컬 오버레이(CLAUDE.local.md)를 더해
// ~/.claude/CLAUDE.md 로 조립한다. 결과가 기존과 동일하면 기록을 생략한다 (idempotent).
// 기존 CLAUDE.md 가 이 엔진 생성물(마커 없음)이 아니면 .bak 로 1회 백업 후 전환한다.
const GLOBAL_MD_MARKER = '<!-- ops-agent:global-md assembled — 직접 편집 금지. 원천은 각 조각 -->';

function assembleGlobalClaudeMd() {
  try {
    const claudeHome = join(homedir(), '.claude');
    const fragDir = join(claudeHome, 'global-md');
    execSync(`mkdir -p "${fragDir}"`, { timeout: 1000, stdio: 'ignore' });

    // ops-agent base 조각 기록 (플러그인 소유, 갱신 시 덮어씀)
    const baseSrc = join(pluginRoot, 'config', 'global-md', 'base.md');
    if (existsSync(baseSrc)) {
      const baseDst = join(fragDir, '00-ops-agent-base.md');
      const baseContent = readFileSync(baseSrc, 'utf8');
      if (!existsSync(baseDst) || readFileSync(baseDst, 'utf8') !== baseContent) {
        writeFileSync(baseDst, baseContent);
      }
    }

    // 조각 디렉토리에서 *.md 를 파일명 순으로 수집 (00-ops-agent-base, NN-*, ...)
    const fragFiles = readdirSync(fragDir).filter((f) => f.endsWith('.md')).sort();
    if (fragFiles.length === 0) return;

    const sections = [GLOBAL_MD_MARKER, ''];
    for (const f of fragFiles) {
      const content = readFileSync(join(fragDir, f), 'utf8').trim();
      if (!content) continue;
      sections.push(`<!-- BEGIN ${f} -->`);
      sections.push(content);
      sections.push(`<!-- END ${f} -->`);
      sections.push('');
    }

    // 로컬 오버레이 (사용자 소유, 덮어쓰지 않음, 최하단)
    const localOverlay = join(claudeHome, 'CLAUDE.local.md');
    if (existsSync(localOverlay)) {
      const content = readFileSync(localOverlay, 'utf8').trim();
      if (content) {
        sections.push('<!-- BEGIN CLAUDE.local.md (사용자 로컬) -->');
        sections.push(content);
        sections.push('<!-- END CLAUDE.local.md -->');
        sections.push('');
      }
    }

    const assembled = sections.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';

    const target = join(claudeHome, 'CLAUDE.md');
    if (existsSync(target)) {
      const current = readFileSync(target, 'utf8');
      if (current === assembled) return; // idempotent — 변경 없음
      // 생성 마커가 없으면 수기 파일 — .bak 로 1회 백업 (덮어쓰지 않음)
      if (!current.startsWith(GLOBAL_MD_MARKER)) {
        const bak = join(claudeHome, 'CLAUDE.md.bak');
        if (!existsSync(bak)) writeFileSync(bak, current);
      }
    }
    writeFileSync(target, assembled);
  } catch { /* non-critical */ }
}

// --- Trials: 시범 적용 규칙 주입 (세션 1회, 디렉토리 무관) ---
// 외부 규범·도구를 정식 등재 전에 기간을 두고 써 보는 상태를 세션마다 올린다.
// 파일이 사용자 스코프(~/.claude/ops-agent/)에 있어 작업 디렉토리가 바뀌어도 풀리지 않는다.
// 메모리는 프로젝트 디렉토리별이라 운반체로 쓰지 않는다 (#442).
// 시범이라도 호출형이 아니라 상시형이다. 사용자가 「확인」을 부르지 않는다.
// 지표: jsonl 의 groupBy 필드 값별 줄 수. since 가 없으면 trial 의 started 이후 ts 만 센다.
// 파일 없음 · 형식 오류는 조용히 건너뛴다 (세션 시작을 막지 않는다).
const METRIC_MAX_BYTES = 5 * 1024 * 1024;
function buildMetricText(m, started) {
  try {
    if (!m || !m.source || !m.groupBy) return '';
    const label = m.name || m.groupBy;
    const src = String(m.source).replace(/^~(?=\/|$)/, homedir());
    if (!existsSync(src) || lstatSync(src).size > METRIC_MAX_BYTES) return `${label} 기록 없음`;
    const from = Date.parse(m.since || started || '');
    const counts = new Map();
    for (const line of readFileSync(src, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (!row || typeof row !== 'object') continue;
      if (!Number.isNaN(from)) {
        const ts = Date.parse(row.ts);
        if (Number.isNaN(ts) || ts < from) continue;
      }
      const key = String(row[m.groupBy] ?? '(없음)');
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    if (counts.size === 0) return `${label} 기록 없음`;
    return `${label} ${[...counts].map(([k, n]) => `${k} ${n}`).join(' · ')}`;
  } catch {
    return '';
  }
}

function buildTrialsContext() {
  try {
    const path = join(opsAgentGlobal, 'trials.local.json');
    if (!existsSync(path)) return '';
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const active = (parsed.trials || []).filter(t => t && t.name && !t.ended);
    if (active.length === 0) return '';
    const lines = [
      '',
      '[시범 적용 중 — 자연어 항시 적용. 사용자가 확인을 부르지 않는다. 판정은 검토 조건 충족 시]',
    ];
    for (const t of active) {
      lines.push(`- ${t.name}${t.title ? ` · ${t.title}` : ''}${t.started ? ` (${t.started}~)` : ''}`);
      for (const r of t.rules || []) lines.push(`  규칙: ${r}`);
      if (t.review) lines.push(`  검토 조건: ${t.review}`);
      // 지표 · 기준 · 판정일: trial 당 최대 4줄
      const metricTexts = (Array.isArray(t.metrics) ? t.metrics : []).map(m => buildMetricText(m, t.started)).filter(Boolean);
      if (metricTexts.length) lines.push(`  지표: ${metricTexts.join(' / ')}`);
      const criteria = (Array.isArray(t.criteria) ? t.criteria : []).filter(c => typeof c === 'string' && c);
      if (criteria.length) lines.push(`  기준: ${criteria.join(' / ')}`);
      if (typeof t.reviewAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.reviewAt)) {
        lines.push(`  판정일: ${t.reviewAt}`);
        // why: 판정일은 사용자 달력 기준이다. UTC 로 비교하면 한국 자정 직후 9시간 동안 하루 늦게 잡힌다
        if (new Date().toLocaleDateString('sv-SE') >= t.reviewAt) {
          lines.push('  판정일 도래: 기준과 지표를 대조해 정식 도입 · 폐기 · 재검토를 사용자에게 묻는다');
        }
      }
      lines.push(`  산출물·관찰은 ${path} 의 log 에 한 줄씩 더한다`);
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

// --- Sync marketplace metadata to latest remote (prevents stale version path) ---
function syncMarketplace() {
  try {
    // Derive marketplace name from cache path: .../cache/{marketplace}/{plugin}/{version}
    const marketplaceName = resolve(pluginRoot, '..', '..').split('/').pop();
    const marketplaceDir = join(homedir(), '.claude', 'plugins', 'marketplaces', marketplaceName);
    if (!existsSync(join(marketplaceDir, '.git'))) return;

    // Check if remote has newer commits
    execSync('git fetch origin', { cwd: marketplaceDir, timeout: 10000, stdio: 'ignore' });
    let defaultBranch = 'main';
    try {
      const refs = execSync('git ls-remote --symref origin HEAD', { cwd: marketplaceDir, encoding: 'utf8', timeout: 5000 });
      const m = refs.match(/refs\/heads\/(\S+)/);
      if (m) defaultBranch = m[1];
    } catch { /* fallback */ }

    const local = execSync('git rev-parse HEAD', { cwd: marketplaceDir, encoding: 'utf8', timeout: 3000 }).trim();
    const remote = execSync(`git rev-parse origin/${defaultBranch}`, { cwd: marketplaceDir, encoding: 'utf8', timeout: 3000 }).trim();
    if (local === remote) return; // already up to date

    execSync(`git reset --hard origin/${defaultBranch}`, { cwd: marketplaceDir, timeout: 5000, stdio: 'ignore' });
  } catch { /* non-critical */ }
}

// --- Execute ---
ensurePluginGit();
cleanupStaleVersions();
linkCurrentRoot();
syncMarketplace();
syncPluginVersion();
ensurePluginGitIdentity();
mirrorStyleRules();
assembleGlobalClaudeMd();
migrateOmcStateToOpsAgent();

const host = detectProvider();
const provider = findProvider(host);
const overlay = loadOverlay(host);

// Read actual version from VERSION file (not directory name)
let pluginVersion = 'unknown';
try {
  const vf = join(pluginRoot, 'VERSION');
  if (existsSync(vf)) pluginVersion = readFileSync(vf, 'utf8').trim();
} catch { /* skip */ }

const parts = [`ops-agent: v${pluginVersion}`, `provider: ${provider.name} (${provider.source})`];
if (overlay) parts.push('overlay: loaded');

const identity = detectGitIdentity(provider, host);
if (identity) {
  parts.push('');
  parts.push('Git Identity (MUST verify before commit/push):');
  parts.push(`  user.name: ${identity.name}`);
  parts.push(`  user.email: ${identity.email}`);
  if (identity.credentialUser) {
    parts.push(`  credential: ${identity.credentialUser}@${identity.host}`);
  }
  parts.push(`  Verify: git config user.name && git config user.email`);
  parts.push(`  Fix: git config user.name "${identity.name}" && git config user.email "${identity.email}"`);
}

parts.push(buildSkillContext(provider));
parts.push(buildTrialsContext());

const context = parts.filter(Boolean).join('\n');

// 외부 소비자용 캐시 (어댑터가 세션 컨텍스트를 참조할 수 있도록 유지)
try {
  const cacheDir = join(opsAgentGlobal, '.cache');
  if (!existsSync(cacheDir)) {
    execSync(`mkdir -p "${cacheDir}"`, { timeout: 1000, stdio: 'ignore' });
  }
  writeFileSync(join(cacheDir, 'session-context.txt'), context);
} catch { /* non-critical */ }

// SessionStart 는 hookSpecificOutput.additionalContext 로 컨텍스트를 전달한다.
// 이전 구현은 PreToolUse 최상위 additionalContext 로 매 툴 호출마다 재전송했으나,
// 해당 위치는 지원 필드가 아니어서 실제로는 한 번도 전달되지 않았다.
console.log(JSON.stringify({
  continue: true,
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: context,
  },
}));
