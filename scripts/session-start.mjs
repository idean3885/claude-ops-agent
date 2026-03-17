#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
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
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || join(import.meta.url.replace('file://', ''), '..', '..');

// Detect provider from git remote host
function detectProvider() {
  try {
    const remote = execSync('git remote get-url origin', { cwd, encoding: 'utf8', timeout: 3000 }).trim();
    const match = remote.match(/[@/]([^:/]+)[:/]/);
    if (match) return match[1];
  } catch {
    // No git or no remote
  }
  return null;
}

// Find matching provider definition
function findProvider(host) {
  if (!host) return { name: 'github', source: 'default' };

  // Check local providers first (~/.claude/devex/providers/)
  const localProviders = join(devexGlobal, 'providers');
  if (existsSync(localProviders)) {
    for (const file of readdirSync(localProviders).filter(f => f.endsWith('.md'))) {
      try {
        const content = readFileSync(join(localProviders, file), 'utf8');
        const hostMatch = content.match(/hostPattern[:\s]+[`"]?([^`"\n]+)/i);
        if (hostMatch && host.includes(hostMatch[1].trim())) {
          return { name: file.replace('.md', ''), source: 'local', host: hostMatch[1].trim() };
        }
      } catch { /* skip unreadable */ }
    }
  }

  // Check built-in providers (plugin/providers/)
  const builtinProviders = join(pluginRoot, 'providers');
  if (existsSync(builtinProviders)) {
    for (const file of readdirSync(builtinProviders).filter(f => f.endsWith('.md') && f !== 'PROVIDER.md')) {
      try {
        const content = readFileSync(join(builtinProviders, file), 'utf8');
        const hostMatch = content.match(/hostPattern[:\s]+[`"]?([^`"\n]+)/i);
        if (hostMatch && host.includes(hostMatch[1].trim())) {
          return { name: file.replace('.md', ''), source: 'builtin', host: hostMatch[1].trim() };
        }
      } catch { /* skip unreadable */ }
    }
  }

  // Default to github
  return { name: 'github', source: 'default' };
}

// Load overlay if exists
function loadOverlay(host) {
  if (!host) return null;
  const overlayPath = join(devexGlobal, 'overlays', `${host}.json`);
  if (existsSync(overlayPath)) {
    try {
      return JSON.parse(readFileSync(overlayPath, 'utf8'));
    } catch { /* skip */ }
  }
  return null;
}

const host = detectProvider();
const provider = findProvider(host);
const overlay = loadOverlay(host);

// Build context message
const parts = [`[devex] provider: ${provider.name} (${provider.source})`];
if (overlay) parts.push(`overlay: loaded`);

const output = JSON.stringify({
  continue: true,
  additionalContext: parts.join(', ')
});

process.stdout.write(output);
