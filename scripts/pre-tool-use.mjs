#!/usr/bin/env node
/**
 * devex PreToolUse hook
 *
 * 1. 세션 컨텍스트 주입 (기존 기능)
 * 2. 대외비 가드 (GATE 0): 공개 표면 쓰기 명령(gh issue/pr/release, git commit)의
 *    본문·제목·메시지에서 대외비 키워드/패턴 히트 시 하드 차단.
 *
 *    타겟 호스트 인식:
 *    - `gh` 명령: GH_HOST 환경 변수 또는 `-R host/owner/repo` 플래그에서 호스트 추출
 *    - `git commit`: 현재 레포의 origin remote URL 검사
 *    - 타겟이 `internalHosts` 에 포함되면 `externalOnly` 키워드/패턴은 허용
 *    - `keywords` / `patterns` (루트) 는 타겟 무관 항상 차단 (예: 위키)
 *
 * 키워드 소스: ~/.claude/devex/confidential-keywords.local.json
 * 드라이런: DEVEX_CONFIDENTIAL_DRYRUN=1 설정 시 차단 대신 경고만 출력
 * 비활성: DEVEX_CONFIDENTIAL_DISABLE=1 설정 시 가드 전체 스킵
 */
import { execSync } from 'child_process';
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

const WHAT_GUARD_DISABLE = process.env.DEVEX_WHAT_GUARD_DISABLE === '1';
const WHAT_GUARD_DRYRUN = process.env.DEVEX_WHAT_GUARD_DRYRUN === '1';

if (!DISABLE) {
  try {
    const hookInput = JSON.parse(input);
    if ((hookInput.tool_name || '') === 'Bash') {
      const command = (hookInput.tool_input && hookInput.tool_input.command) || '';
      const cwd = hookInput.cwd || process.cwd();
      const result = runConfidentialGuard(command, cwd);
      if (result.blocked) {
        const header = DRYRUN ? '[DEVEX 대외비 가드 · 드라이런]' : '[DEVEX 대외비 가드 · 차단]';
        const hitLines = result.hits.map(h =>
          `  - "${h.keyword}" (${h.source}): ${h.context}`).join('\n');
        const targetInfo = result.target
          ? `\n타겟: ${result.target.scope} (${result.target.reason})`
          : '';
        const msg = `${header} 공개 표면 쓰기 명령에서 대외비 히트:${targetInfo}\n${hitLines}\n\n` +
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

      // 도메인 What 추상화 가드: 커밋·PR·이슈 본문에서 구현 세부 노출 차단
      if (!WHAT_GUARD_DISABLE) {
        const whatResult = runWhatAbstractionGuard(command);
        if (whatResult.blocked) {
          const header = WHAT_GUARD_DRYRUN
            ? '[DEVEX What 추상화 가드 · 드라이런]'
            : '[DEVEX What 추상화 가드 · 차단]';
          const hitLines = whatResult.hits
            .map(h => `  - [${h.rule}] "${h.match}": ${h.context}`).join('\n');
          const msg = `${header} 본문에 구현 세부가 노출되어 있습니다.\n${hitLines}\n\n` +
            `해결: 도메인 행위·사용자 가치만 기술하세요. 클래스명·메서드명·어노테이션·헥사고날 어휘·yaml 키·산출물 카운트 모두 제거.\n` +
            `흐름은 mermaid flowchart/sequenceDiagram 사용.\n` +
            `가이드: ~/.claude/plugins/cache/claude-devex/devex/*/skills/flow/guides/commit.md 의 "도메인 What 추상화" 섹션\n` +
            `비활성: DEVEX_WHAT_GUARD_DISABLE=1 (예외 상황만)`;
          if (WHAT_GUARD_DRYRUN) {
            process.stderr.write(msg + '\n');
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

function runConfidentialGuard(command, cwd) {
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

  const cfg = loadConfig();
  if (isEmptyConfig(cfg)) {
    return { blocked: false, hits: [] };
  }

  // 타겟 결정 — internal 이면 externalOnly 규칙은 스킵
  const target = resolveTarget(command, cwd, cfg.internalHosts);

  // 항상 차단되는 규칙 (위키 등 존재 자체가 대외비인 키워드)
  const alwaysRules = { keywords: cfg.keywords, patterns: cfg.patterns };
  // external 타겟에만 차단되는 규칙 (사내 인프라 참조 — 사내 작업엔 허용)
  const externalRules = target.scope === 'external'
    ? { keywords: cfg.externalOnly.keywords, patterns: cfg.externalOnly.patterns }
    : { keywords: [], patterns: [] };

  const hits = [];
  for (const t of texts) {
    collectHits(t, alwaysRules.keywords, alwaysRules.patterns, hits);
    collectHits(t, externalRules.keywords, externalRules.patterns, hits);
  }

  return { blocked: hits.length > 0, hits, target };
}

function collectHits(t, keywords, patterns, hits) {
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

function resolveTarget(command, cwd, internalHosts) {
  const hosts = internalHosts || [];
  // 1. gh 명령: GH_HOST 환경 변수 접두어 우선
  const ghHostMatch = command.match(/\bGH_HOST=([^\s'"]+)/);
  if (ghHostMatch) {
    const host = ghHostMatch[1];
    if (hosts.some(h => host === h || host.endsWith('.' + h))) {
      return { scope: 'internal', reason: `GH_HOST=${host}` };
    }
    return { scope: 'external', reason: `GH_HOST=${host}` };
  }

  // 2. gh -R 플래그: owner/repo 형식으로는 호스트 판별 불가 → gh config 조회
  if (/\bgh\s+(issue|pr|release)\b/.test(command)) {
    try {
      const defaultHost = execSync('gh config get -h github.com active_account 2>/dev/null; gh auth status 2>&1', {
        cwd, encoding: 'utf8', timeout: 2000,
      });
      for (const host of hosts) {
        if (defaultHost.includes(host)) {
          return { scope: 'internal', reason: `gh default host=${host}` };
        }
      }
    } catch { /* gh 조회 실패 시 external 로 fallback */ }
    return { scope: 'external', reason: 'gh default host 미확인' };
  }

  // 3. git commit: 현재 레포의 origin remote URL 검사
  if (/\bgit\s+commit\b/.test(command)) {
    try {
      const url = execSync('git remote get-url origin 2>/dev/null', {
        cwd, encoding: 'utf8', timeout: 2000,
      }).trim();
      for (const host of hosts) {
        if (url.includes(host)) {
          return { scope: 'internal', reason: `origin remote=${host}` };
        }
      }
      return { scope: 'external', reason: `origin remote 외부: ${url.substring(0, 60)}` };
    } catch { return { scope: 'external', reason: 'origin remote 조회 실패' }; }
  }

  // 4. 기본값: 안전하게 external
  return { scope: 'external', reason: '타겟 미확인' };
}

function loadConfig() {
  const cfgPath = process.env.DEVEX_CONFIDENTIAL_CONFIG_PATH
    || join(homedir(), '.claude', 'devex', 'confidential-keywords.local.json');
  const empty = {
    keywords: [], patterns: [],
    externalOnly: { keywords: [], patterns: [] },
    internalHosts: [],
  };
  if (!existsSync(cfgPath)) return empty;
  try {
    const raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
    return {
      keywords: toStringArray(raw.keywords),
      patterns: toRegexArray(raw.patterns),
      externalOnly: {
        keywords: toStringArray(raw.externalOnly && raw.externalOnly.keywords),
        patterns: toRegexArray(raw.externalOnly && raw.externalOnly.patterns),
      },
      internalHosts: toStringArray(raw.internalHosts),
    };
  } catch {
    return empty;
  }
}

function toStringArray(value) {
  return Array.isArray(value)
    ? value.filter(v => typeof v === 'string' && v.length > 0)
    : [];
}

function toRegexArray(value) {
  return Array.isArray(value)
    ? value
        .filter(p => typeof p === 'string' && p.length > 0)
        .map(p => { try { return new RegExp(p); } catch { return null; } })
        .filter(Boolean)
    : [];
}

function isEmptyConfig(cfg) {
  return cfg.keywords.length === 0
    && cfg.patterns.length === 0
    && cfg.externalOnly.keywords.length === 0
    && cfg.externalOnly.patterns.length === 0;
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

// ─── 도메인 What 추상화 가드 ───
// 커밋/PR/이슈 본문에서 구현 세부(클래스명·메서드명·어노테이션·헥사고날 어휘·yaml 키·산출물 카운트) 차단
function runWhatAbstractionGuard(command) {
  const writePatterns = [
    /\bgh\s+issue\s+(create|edit|comment)\b/,
    /\bgh\s+pr\s+(create|edit|comment|review)\b/,
    /\bgh\s+release\s+(create|edit)\b/,
    /\bgit\s+commit\b/,
  ];
  if (!writePatterns.some(re => re.test(command))) {
    return { blocked: false, hits: [] };
  }

  const texts = [];
  // 제목은 이슈/PR 번호 prefix 또는 짧은 도메인 표현이라 검사 대상 아님 — body/m/subject·body-file만
  extractOption(command, 'body', texts);
  extractShortOption(command, 'm', texts);
  extractFileOption(command, 'body-file', texts);
  extractFileOption(command, 'notes-file', texts);

  if (texts.length === 0) return { blocked: false, hits: [] };

  // 룰 정의
  const rules = [
    {
      id: 'hexagonal-classname',
      // PascalCase + 헥사고날 접미사 합성어 (단어 경계)
      // 예: WorkloadSnapshotUserService, NodeContainerMetricPortAdapter
      regex: /\b[A-Z][a-zA-Z0-9]+(Port|Adapter|UseCase|Listener|Service|Repository|Validator|Controller|Handler)\b/g,
      threshold: 1,
    },
    {
      id: 'annotation',
      // Spring/Lombok/Jakarta 어노테이션 (PascalCase)
      // 예: @TransactionalEventListener, @RequiredArgsConstructor
      regex: /@[A-Z][a-zA-Z]+/g,
      threshold: 1,
    },
    {
      id: 'tx-phase-const',
      // 트랜잭션 phase/propagation 상수
      regex: /\b(AFTER_COMMIT|BEFORE_COMMIT|AFTER_COMPLETION|AFTER_ROLLBACK|REQUIRES_NEW|MANDATORY|REQUIRED|SUPPORTS|NOT_SUPPORTED|NESTED|NEVER)\b/g,
      threshold: 1,
    },
    {
      id: 'config-file-path',
      // application-*.yml / application-*.yaml / build.gradle / *.properties 같은 의존성 파일 경로
      regex: /\bapplication-[a-z0-9_-]+\.ya?ml\b|\bbuild\.gradle\b|\b[a-z0-9_-]+\.properties\b/g,
      threshold: 1,
    },
    {
      id: 'artifact-count',
      // "N종 신규", "N files changed", "+M / -N"
      regex: /\d+\s*(종\s*신규|files?\s+changed|insertions?\b|deletions?\b)|\+\d+\s*\/\s*-\d+/g,
      threshold: 1,
    },
    {
      id: 'method-signature',
      // camelCase + 빈 괄호 (메서드 호출 표기) — 예: validateForCreate(), startDelegation()
      regex: /\b[a-z][a-zA-Z0-9]*\(\)/g,
      threshold: 1,
    },
  ];

  const hits = [];
  for (const t of texts) {
    // mermaid 코드 블록은 흐름 시각화라 검사 제외
    const stripped = t.value.replace(/```mermaid[\s\S]*?```/g, '');
    for (const rule of rules) {
      const re = new RegExp(rule.regex.source, rule.regex.flags);
      let count = 0;
      let m;
      while ((m = re.exec(stripped)) !== null) {
        count++;
        if (count <= 3) {
          hits.push({
            rule: rule.id,
            match: m[0],
            source: t.source,
            context: snippet(stripped, m.index, m[0].length),
          });
        }
        if (m.index === re.lastIndex) re.lastIndex++;
      }
      // threshold 미만이면 이번 룰 히트 무효화 (예: threshold=3 인데 1개만 매치 → 무시)
      if (count < rule.threshold) {
        const removeCount = Math.min(count, hits.length);
        for (let i = 0; i < removeCount; i++) {
          // 마지막 N개 제거
          if (hits[hits.length - 1].rule === rule.id) hits.pop();
        }
      }
    }
  }

  return { blocked: hits.length > 0, hits };
}
