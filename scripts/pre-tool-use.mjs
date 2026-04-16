#!/usr/bin/env node
/**
 * devex PreToolUse hook
 *
 * 1. 세션 컨텍스트 주입 (기존 기능)
 * 2. 대외비 가드 (GATE 0): 공개 표면 쓰기 명령(gh issue/pr/release, git commit)의
 *    본문·제목·메시지에서 대외비 키워드/패턴 히트 시 하드 차단.
 *
 * 키워드 소스: ~/.claude/devex/confidential-keywords.local.json
 * 드라이런: DEVEX_CONFIDENTIAL_DRYRUN=1 설정 시 차단 대신 경고만 출력
 * 비활성: DEVEX_CONFIDENTIAL_DISABLE=1 설정 시 가드 전체 스킵
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ─── stdin 수집 ───
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) { input += chunk; }

// ─── 세션 컨텍스트 (기존) ───
const cachePath = join(homedir(), '.claude', 'devex', '.cache', 'session-context.txt');
const sessionContext = existsSync(cachePath) ? readFileSync(cachePath, 'utf8') : '';

// ─── 대외비 가드 ───
const DISABLE = process.env.DEVEX_CONFIDENTIAL_DISABLE === '1';
const DRYRUN = process.env.DEVEX_CONFIDENTIAL_DRYRUN === '1';

if (!DISABLE) {
  try {
    const hookInput = JSON.parse(input);
    if ((hookInput.tool_name || '') === 'Bash') {
      const command = (hookInput.tool_input && hookInput.tool_input.command) || '';
      const result = runConfidentialGuard(command);
      if (result.blocked) {
        const header = DRYRUN ? '[DEVEX 대외비 가드 · 드라이런]' : '[DEVEX 대외비 가드 · 차단]';
        const hitLines = result.hits.map(h =>
          `  - "${h.keyword}" (${h.source}): ${h.context}`).join('\n');
        const msg = `${header} 공개 표면 쓰기 명령에서 대외비 히트:\n${hitLines}\n\n` +
          `해결: 본문/제목/메시지에서 해당 키워드 제거 후 재시도.\n` +
          `허용 리스트 조정: ~/.claude/devex/confidential-keywords.local.json`;
        if (DRYRUN) {
          process.stderr.write(msg + '\n');
          respondContinue(sessionContext);
          process.exit(0);
        } else {
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: msg,
            },
          }));
          process.exit(0);
        }
      }
    }
  } catch {
    // 입력 파싱 실패 시 가드는 생략하고 기본 응답 (훅이 통신을 망치지 않도록)
  }
}

respondContinue(sessionContext);

// ─────────────────────────────────────────────
function respondContinue(context) {
  if (context) {
    process.stdout.write(JSON.stringify({ continue: true, additionalContext: context }));
  } else {
    process.stdout.write('{"continue":true}');
  }
}

function runConfidentialGuard(command) {
  // 공개 쓰기 명령 감지 (체인된 명령도 커버)
  const writePatterns = [
    /\bgh\s+issue\s+(create|edit|comment)\b/,
    /\bgh\s+pr\s+(create|edit|comment|review)\b/,
    /\bgh\s+release\s+(create|edit)\b/,
    /\bgit\s+commit\b/,
  ];
  if (!writePatterns.some(re => re.test(command))) {
    return { blocked: false, hits: [] };
  }

  // 본문·제목·메시지 텍스트 추출
  const texts = [];
  extractOption(command, 'body', texts);
  extractOption(command, 'title', texts);
  extractOption(command, 'subject', texts);
  extractShortOption(command, 'm', texts);
  extractFileOption(command, 'body-file', texts);
  extractFileOption(command, 'notes-file', texts);

  if (texts.length === 0) {
    return { blocked: false, hits: [] };
  }

  // 키워드 로드
  const { keywords, patterns } = loadKeywords();
  if (keywords.length === 0 && patterns.length === 0) {
    return { blocked: false, hits: [] };
  }

  const hits = [];
  for (const t of texts) {
    for (const kw of keywords) {
      if (!kw) continue;
      let idx = t.value.indexOf(kw);
      while (idx !== -1) {
        hits.push({
          keyword: kw,
          source: t.source,
          context: snippet(t.value, idx, kw.length),
        });
        idx = t.value.indexOf(kw, idx + kw.length);
      }
    }
    for (const pat of patterns) {
      const re = new RegExp(pat.source, pat.flags.includes('g') ? pat.flags : pat.flags + 'g');
      let m;
      while ((m = re.exec(t.value)) !== null) {
        hits.push({
          keyword: m[0],
          source: t.source + ' (pattern)',
          context: snippet(t.value, m.index, m[0].length),
        });
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    }
  }

  return { blocked: hits.length > 0, hits };
}

function loadKeywords() {
  const cfgPath = process.env.DEVEX_CONFIDENTIAL_CONFIG_PATH
    || join(homedir(), '.claude', 'devex', 'confidential-keywords.local.json');
  if (!existsSync(cfgPath)) return { keywords: [], patterns: [] };
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    const keywords = Array.isArray(cfg.keywords) ? cfg.keywords.filter(k => typeof k === 'string' && k.length > 0) : [];
    const patterns = Array.isArray(cfg.patterns)
      ? cfg.patterns.filter(p => typeof p === 'string' && p.length > 0).map(p => {
          try { return new RegExp(p); } catch { return null; }
        }).filter(Boolean)
      : [];
    return { keywords, patterns };
  } catch {
    return { keywords: [], patterns: [] };
  }
}

function extractOption(command, name, out) {
  const re = new RegExp(`--${name}(?:=("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\\S+)|\\s+("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\\S+))`, 'g');
  let m;
  while ((m = re.exec(command)) !== null) {
    const raw = m[1] || m[2] || '';
    out.push({ source: `--${name}`, value: stripQuotes(raw) });
  }
}

function extractShortOption(command, name, out) {
  const re = new RegExp(`(?:^|\\s)-${name}(?:=("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\\S+)|\\s+("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\\S+))`, 'g');
  let m;
  while ((m = re.exec(command)) !== null) {
    const raw = m[1] || m[2] || '';
    out.push({ source: `-${name}`, value: stripQuotes(raw) });
  }
}

function extractFileOption(command, name, out) {
  const re = new RegExp(`--${name}(?:=(\\S+)|\\s+(\\S+))`, 'g');
  let m;
  while ((m = re.exec(command)) !== null) {
    const path = stripQuotes(m[1] || m[2] || '');
    if (path && existsSync(path)) {
      try {
        out.push({ source: `--${name}:${path}`, value: readFileSync(path, 'utf8') });
      } catch { /* 읽기 실패는 무시 */ }
    }
  }
}

function stripQuotes(s) {
  if (s.length >= 2) {
    const f = s[0], l = s[s.length - 1];
    if ((f === '"' && l === '"') || (f === "'" && l === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

function snippet(text, index, length) {
  const before = Math.max(0, index - 25);
  const after = Math.min(text.length, index + length + 25);
  const frag = text.substring(before, after).replace(/\s+/g, ' ');
  return `"${before > 0 ? '…' : ''}${frag}${after < text.length ? '…' : ''}"`;
}
