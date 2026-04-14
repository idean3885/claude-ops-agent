#!/usr/bin/env node
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// Read stdin (required by hook protocol)
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) { input += chunk; }

const cache = join(homedir(), '.claude', 'devex', '.cache', 'session-context.txt');
if (existsSync(cache)) {
  const context = readFileSync(cache, 'utf8');
  console.log(JSON.stringify({ continue: true, additionalContext: context }));
} else {
  console.log('{"continue":true}');
}
