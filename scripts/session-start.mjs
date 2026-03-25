#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
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
const devexGlobal = join(homedir(), '.claude', 'devex');

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

  // Local providers first (~/.claude/devex/providers/)
  const localProviders = join(devexGlobal, 'providers');
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
  const overlayPath = join(devexGlobal, 'overlays', `${host}.json`);
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
    providerPath = join(devexGlobal, 'providers', `${provider.name}.md`);
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
    const localPath = join(devexGlobal, 'providers', `${provider.name}.md`);
    if (existsSync(localPath)) providerPath = localPath;
  } else if (provider.source === 'builtin') {
    const builtinPath = join(pluginRoot, 'providers', `${provider.name}.md`);
    if (existsSync(builtinPath)) providerPath = builtinPath;
  }

  return [
    '',
    'Natural language skill triggers — on match, read the guide file and follow its workflow.',
    'Do NOT mention plugin name to the user. Provider file MUST be read before any API call.',
    '',
    `Provider: ${providerPath}`,
    '',
    '| Trigger | Guide |',
    '|---------|-------|',
    `| "이슈", "issue" (create/start/complete) | ${join(skillsDir, 'issue', 'SKILL.md')} |`,
    `| "커밋", "commit" | ${join(skillsDir, 'commit', 'SKILL.md')} |`,
    `| "PR", "풀리퀘" | ${join(skillsDir, 'pr', 'SKILL.md')} |`,
    `| "flow", "플로우", natural language change request | ${join(skillsDir, 'flow', 'SKILL.md')} |`,
    `| "spec", "명세" | ${join(skillsDir, 'spec', 'SKILL.md')} |`,
    `| "setup", "설정" | ${join(skillsDir, 'setup', 'SKILL.md')} |`,
  ].join('\n');
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
    const entry = installed.plugins?.['devex@claude-devex']?.[0];
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
function cleanupStaleVersions() {
  try {
    const cacheParent = resolve(pluginRoot, '..');
    const currentDir = pluginRoot.split('/').pop();
    const siblings = readdirSync(cacheParent);
    for (const dir of siblings) {
      if (dir !== currentDir && /^\d+\.\d+\.\d+$/.test(dir)) {
        const target = join(cacheParent, dir);
        execSync(`rm -rf "${target}"`, { timeout: 5000, stdio: 'ignore' });
      }
    }
  } catch { /* non-critical */ }
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
syncMarketplace();
syncPluginVersion();
ensurePluginGitIdentity();

const host = detectProvider();
const provider = findProvider(host);
const overlay = loadOverlay(host);

// Read actual version from VERSION file (not directory name)
let pluginVersion = 'unknown';
try {
  const vf = join(pluginRoot, 'VERSION');
  if (existsSync(vf)) pluginVersion = readFileSync(vf, 'utf8').trim();
} catch { /* skip */ }

const parts = [`devex: v${pluginVersion}`, `provider: ${provider.name} (${provider.source})`];
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

const context = parts.join('\n');

// Write context to cache file for PreToolUse hook to read
try {
  const cacheDir = join(devexGlobal, '.cache');
  if (!existsSync(cacheDir)) {
    execSync(`mkdir -p "${cacheDir}"`, { timeout: 1000, stdio: 'ignore' });
  }
  writeFileSync(join(cacheDir, 'session-context.txt'), context);
} catch { /* non-critical */ }

console.log(JSON.stringify({ continue: true }));
