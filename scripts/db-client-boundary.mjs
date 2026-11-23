/**
 * db-client-boundary.mjs — DB 클라이언트를 실행하거나 그 실행을 담은 스크립트를 쓰는 도구 호출을 찾는다.
 *
 * 접속 자산(클라이언트 버전 함정 · 접속 항목의 기본 스키마)은 소비 환경에 있다. 그 자산을 부르지 않고
 * 접속 목록과 `which mysql` 만 보고 쓰기 스크립트를 짜서, 자산에 적힌 실패가 그대로 재발했다 (#1197).
 * 원인은 「로드되지 않았다」라 자산 내용이 아니라 읽히는 시점을 고친다 (docs/lessons.md 「도구 경계에서 로드한다」).
 *
 * 판정은 순수 함수다. 자리 파일이 있는지는 호출자가 본다.
 */
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const CLIENTS = new Set(['mysql', 'mariadb', 'mysqldump', 'mysqlsh']);
// 경로째 담는 변수 대입: M=/opt/homebrew/opt/mysql-client@8.0/bin/mysql
const CLIENT_PATH_ASSIGN = /(?:^|[\s;&|(])[A-Za-z_][A-Za-z0-9_]*=["']?[^\s"';|&]*\/(?:mysql|mariadb|mysqldump|mysqlsh)["']?(?=[\s;|&)]|$)/m;

/** 셸 텍스트를 명령 단위로 나눈다. 따옴표 안의 구분자는 나누지 않는다. */
function segments(text) {
  const out = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = '';
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '\n' || c === ';' || c === '|' || c === '&' || c === '(' || c === ')' || c === '`') {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** 명령 단위의 첫 낱말(환경 변수 대입 · sudo · exec 를 건너뛴)의 이름. */
function commandWord(segment) {
  const words = segment.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || words[i] === 'sudo' || words[i] === 'exec' || words[i] === 'command')) i++;
  if (i >= words.length) return '';
  const w = words[i].replace(/^["']|["']$/g, '');
  return w.slice(w.lastIndexOf('/') + 1);
}

/** 셸 텍스트가 DB 클라이언트를 실행하는가. 인자 자리의 낱말(grep mysql)과 드라이버 이름(mysql2)은 넘긴다. */
export function invokesDbClient(text) {
  if (!text) return false;
  if (CLIENT_PATH_ASSIGN.test(text)) return true;
  for (const seg of segments(text)) {
    if (CLIENTS.has(commandWord(seg))) return true;
  }
  return false;
}

const SCRIPT_FILE = /\.(?:sh|bash|zsh)$/;

/**
 * 도구 호출이 DB 클라이언트 경계인가. Bash 는 명령, Write 는 쓰는 본문, Edit 는 새 문자열을 본다.
 * 파일 편집은 셸 스크립트(확장자 또는 shebang)만 본다. 문서의 산문 줄이 「mysql …」로 시작해도 실행이 아니다.
 */
export function isDbClientBoundary(toolName, toolInput) {
  const input = toolInput || {};
  if (toolName === 'Bash') return invokesDbClient(input.command || '');
  const isScript = SCRIPT_FILE.test(input.file_path || '') || /^#!/.test(input.content || '');
  if (!isScript) return false;
  if (toolName === 'Write') return invokesDbClient(input.content || '');
  if (toolName === 'Edit') return invokesDbClient(input.new_string || '');
  if (toolName === 'MultiEdit') return (input.edits || []).some(e => invokesDbClient((e && e.new_string) || ''));
  return false;
}

/** 소비 환경이 접속 자산을 연결하는 자리. 접속 목록(connections.json)과 같은 디렉토리다. */
export function clientNotesPath(env = process.env) {
  return env.OPS_AGENT_DB_CLIENT_NOTES || join(homedir(), '.claude', 'ops-agent', 'dbgate', 'client.md');
}

/** 경계면 조치 한 줄, 아니면 빈 문자열. 자리가 비어 있으면 가리킬 곳이 없으니 알리지 않는다. */
export function dbClientNotice(toolName, toolInput, env = process.env) {
  if (!isDbClientBoundary(toolName, toolInput)) return '';
  const path = clientNotesPath(env);
  if (!existsSync(path)) return '';
  return `[ops-agent DB 클라이언트 경계 · 알림] DB 클라이언트를 실행합니다. 접속 자산을 먼저 읽습니다(클라이언트 버전 · 접속 항목의 기본 스키마): ${path}`;
}
