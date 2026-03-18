#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'fs';
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
    execSync('git reset --mixed origin/master', { cwd: pluginRoot, timeout: 5000, stdio: 'ignore' });
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
        const hostMatch = content.match(/hostPattern[:\s]+[`"]?([^`"\n]+)/i);
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
        const hostMatch = content.match(/hostPattern[:\s]+[`"]?([^`"\n]+)/i);
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

// --- Execute ---
ensurePluginGit();
cleanupStaleVersions();

const host = detectProvider();
const provider = findProvider(host);
const overlay = loadOverlay(host);

const parts = [`[devex] provider: ${provider.name} (${provider.source})`];
if (overlay) parts.push('overlay: loaded');

process.stdout.write(JSON.stringify({
  continue: true,
  additionalContext: parts.join(', ')
}));
