#!/usr/bin/env node
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// Read hook input from stdin
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) {
  input += chunk;
}

const data = JSON.parse(input);
const cwd = data.cwd || process.cwd();

// Ensure .devex/ directory exists
const devexDir = join(cwd, '.devex');
if (!existsSync(devexDir)) {
  mkdirSync(devexDir, { recursive: true });
}

// Output: continue session normally
const output = JSON.stringify({ continue: true });
process.stdout.write(output);
