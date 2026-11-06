// 조회 가드의 판정. DB 에 붙지 않는 순수 함수만 둔다(자체 점검이 그대로 부른다).
// 무엇을 왜 막는지는 ../SKILL.md 「가드」 절과 experts/dba.md 「운영 조회」 기준이 정본이다.
const fs = require('fs');
const os = require('os');
const path = require('path');

const LIMITS = {
  rows: 200, // 결과 행 상한. LIMIT 이 없으면 붙이고, 이보다 큰 LIMIT 은 거절한다
  scanRows: 1000000, // 한 테이블을 훑는(type ALL · index) 예상 행 수 상한
  joinRows: 10000000, // 예상 처리 행 상한. 같은 id(한 SELECT 블록)는 rows × filtered 를 곱하고, 블록끼리는 더한다
  timeoutMs: 10000, // 서버가 조회를 끊는 시간(max_execution_time)
};

// 문자열 · 식별자 · 주석을 나타난 순서대로 한 번에 지운다. 순서대로 봐야 문자열 안의 주석 기호에 속지 않는다.
// 버전 주석(/*!50000 ... */)은 MySQL 이 안을 실행하고 안에 주석을 겹칠 수 있어 판정과 어긋난다. 이 토큰 순서로 찾아 거절한다(hasVersioned).
const TOKEN = /'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"|`(?:[^`]|``)*`|\/\*M?!\d*([\s\S]*?)\*\/|(\/\*\+[\s\S]*?\*\/)|\/\*[\s\S]*?\*\/|(?:--[ \t]|#)[^\n]*/gi; // 힌트 이름은 대소문자를 가리지 않는다 (max_execution_time · SET_VAR(max_execution_time=…))
function strip(sql) {
  return sql.replace(TOKEN, (m, versioned, hint) => {
    // 힌트는 주석 전체를 하나로 잡고 본문에 실행 시간 지정이 있으면 표지를 남긴다(철자 · 안쪽 문자열에 기대지 않는다)
    if (versioned !== undefined || (hint !== undefined && /max_execution_time/i.test(hint))) return ' /*!VERSIONED*/ ';
    if (m[0] === "'" || m[0] === '"') return "''";
    if (m[0] === '`') return `\`${m.slice(1, -1).replace(/[^\w$]/g, '_')}\``; // 식별자 이름은 개인정보 판정에 쓰므로 남긴다
    return ' ';
  });
}

const READ_HEADS = ['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN'];
const LOCKING = ['INTO OUTFILE', 'INTO DUMPFILE', 'FOR UPDATE', 'FOR SHARE', 'LOCK IN SHARE MODE'];
const WRITE_WORDS = /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|RENAME|CALL|LOAD|HANDLER|SET|DO)\b/;
const SLOW_FUNCS = /\b(SLEEP|BENCHMARK|GET_LOCK|MASTER_POS_WAIT|SOURCE_POS_WAIT|WAIT_FOR_EXECUTED_GTID_SET|WAIT_UNTIL_SQL_THREAD_AFTER_GTIDS)\s*\(/;

const hasVersioned = sql => strip(sql).includes('/*!VERSIONED*/');

// 개인정보로 보는 컬럼 이름. 소비 환경은 ~/.claude/ops-agent/db-query/pii.json 의 columns(정규식 문자열 배열)로 더한다.
// 이어 쓴 이름(homeaddress · phonenumber)과 숫자 접미(address1)도 잡도록, 뜻이 분명한 낱말은 이름 어디에 있든 보고
// 짧아서 다른 낱말에 섞이는 것(tel · ci · lat …)은 낱말 경계(_ · 숫자 · 끝)로만 본다.
const PII_ANYWHERE = /(phone|mobile|e_?mail|address|addr|birth|jumin|passport|resident|latitude|longitude|realname|fullname|firstname|lastname|korname|customername|membername|personname)/;
const PII_WORD = /(^|_)((tel|cell|hp|fax)(_?(no|num|number))?|mail|zip|zip_?code|post_?code|ssn|rrn|dob|ci|di|imei|udid|lat|lng|gps|location|card_?no|card_?num|account_?no|bank_?account|license_?no|mac|real_?name|full_?name|first_?name|last_?name)(?=_|\d|$)/;
function piiColumnPatterns() {
  const file = process.env.DB_QUERY_PII || path.join(os.homedir(), '.claude', 'ops-agent', 'db-query', 'pii.json');
  const extra = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).columns || [] : [];
  return [PII_ANYWHERE, PII_WORD, ...extra.map(re => new RegExp(re, 'i'))];
}
// userEmail · user-email 을 user_email 로 맞춰 본다
const normalize = name => String(name).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').toLowerCase();
const isPiiColumn = (name, patterns = piiColumnPatterns()) => {
  const n = normalize(name);
  return patterns.some(re => re.test(n) || re.test(n.replace(/_/g, '')));
};

// 바깥 깊이(괄호 0)의 글자만 남긴다
function topLevel(body) {
  let depth = 0;
  let flat = '';
  for (const ch of body) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (depth === 0) flat += ch;
  }
  return flat;
}

// 모든 SELECT 목록(SELECT 와 그 깊이의 FROM 사이). COUNT(...) 안은 값이 나가지 않으므로 뺀다.
function selectLists(body) {
  const lists = [];
  const re = /\bSELECT\b/gi;
  let m;
  while ((m = re.exec(body))) {
    let depth = 0;
    let i = m.index + m[0].length;
    for (; i < body.length; i += 1) {
      const ch = body[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') { if (depth === 0) break; depth -= 1; }
      else if (depth === 0 && /^\bFROM\b/i.test(body.slice(i, i + 5)) && /\W/.test(body[i - 1] || ' ')) break;
    }
    // EXISTS (SELECT * ...) 는 행이 있는지만 본다. 값이 나가지 않으므로 목록을 보지 않는다
    if (!/\bEXISTS\s*\(\s*$/i.test(body.slice(0, m.index))) lists.push(body.slice(m.index + m[0].length, i).replace(/\bCOUNT\s*\([^()]*\)/gi, ' '));
  }
  return lists;
}

// 문장 하나만, 읽기 문장만 통과한다. kind: select(실행 계획으로 비용을 보는 문장) · meta(SHOW · DESC · EXPLAIN)
function verdictSql(sql, patterns = piiColumnPatterns()) {
  // 버전 주석은 안에 주석을 겹쳐 판정과 서버의 해석을 어긋나게 할 수 있다. 조회에 쓸 일이 없으므로 받지 않는다
  if (hasVersioned(sql)) return { ok: false, reason: '버전 주석(/*! */ · /*M! */)과 실행 시간 힌트(MAX_EXECUTION_TIME)는 보내지 않는다' };
  const body = strip(sql);
  const statements = body.split(';').map(s => s.trim()).filter(Boolean);
  if (statements.length === 0) return { ok: false, reason: '빈 문장' };
  if (statements.length > 1) return { ok: false, reason: '문장은 하나만 보낸다' };
  const st = statements[0];
  const head = st.split(/\s+/)[0].toUpperCase().replace(/^\(+/, '');
  if (!READ_HEADS.includes(head)) return { ok: false, reason: `읽기 문장만 보낸다 (${head})` };
  const up = st.toUpperCase().replace(/\s+/g, ' ');
  const lock = LOCKING.find(bad => up.includes(bad));
  if (lock) return { ok: false, reason: `${lock} 는 보내지 않는다` };
  if (head === 'WITH' && WRITE_WORDS.test(up)) return { ok: false, reason: 'WITH 뒤에 쓰기 문장이 있다' };
  if (SLOW_FUNCS.test(up)) return { ok: false, reason: '대기 · 부하 함수는 보내지 않는다' };
  if (/^(EXPLAIN|DESCRIBE|DESC)\s+ANALYZE\b/.test(up)) return { ok: false, reason: 'EXPLAIN ANALYZE 는 조회를 실제로 실행한다. EXPLAIN 만 보낸다' };
  if (head !== 'SELECT' && head !== 'WITH') return { ok: true, kind: 'meta' };

  for (const list of selectLists(st)) {
    const items = topLevel(list).split(',').map(item => item.trim().replace(/^((DISTINCT|DISTINCTROW|ALL|HIGH_PRIORITY|STRAIGHT_JOIN|SQL_\w+)\s+)+/i, ''));
    if (items.some(item => /^([\w`$]+\.)*\*$/.test(item))) {
      return { ok: false, reason: 'SELECT 목록의 * 는 보내지 않는다. 필요한 컬럼을 적는다 (개인정보 컬럼이 섞여 나온다)' };
    }
    // 뒤에 점이 오는 이름은 테이블 · 별칭 한정자라 컬럼이 아니다
    const ids = [...list.matchAll(/[A-Za-z_][\w$]*/g)].filter(m => !/^\s*\./.test(list.slice(m.index + m[0].length))).map(m => m[0]);
    const pii = ids.find(id => isPiiColumn(id, patterns));
    if (pii) {
      return { ok: false, reason: `개인정보 컬럼(${pii})을 결과로 내지 않는다. COUNT 같은 집계나 존재 여부로 바꾼다 (DB11)` };
    }
  }
  const limit = /\bLIMIT\s+(\d+)(?:\s*,\s*(\d+))?/i.exec(topLevel(st));
  if (limit) {
    const count = Number(limit[2] ?? limit[1]);
    if (count > LIMITS.rows) return { ok: false, reason: `LIMIT ${count} 은 상한 ${LIMITS.rows} 을 넘는다` };
  }
  return { ok: true, kind: 'select' };
}

// 바깥 LIMIT 이 없으면 붙인다. 줄 주석으로 끝나는 문장에 붙어 주석 안에 들어가지 않도록 줄을 바꿔 붙인다.
function withLimit(sql, rows = LIMITS.rows) {
  const flat = topLevel(strip(sql).replace(/;\s*$/, ''));
  if (/\bLIMIT\s+\d+/i.test(flat)) return sql;
  return `${sql.replace(/;\s*$/, '')}\nLIMIT ${rows}`;
}

// SHOW GRANTS 결과에서 조회 전용 계정인지 본다. 역할(role) 부여는 무엇이 담겼는지 몰라 조회 전용으로 보지 않는다.
// 부분 회수(REVOKE ... 줄, MySQL 8.0.16+)는 권한을 줄이기만 하므로 판정에서 뺀다.
const READ_PRIVS = new Set(['SELECT', 'SHOW VIEW', 'USAGE', 'SHOW DATABASES']);
function privileges(grants) {
  const extra = new Set();
  for (const line of grants) {
    if (/^REVOKE\s/i.test(line)) continue;
    const m = /^GRANT\s+(.+?)\s+ON\s+/i.exec(line);
    if (!m) {
      extra.add('ROLE');
      continue;
    }
    for (const priv of m[1].split(',').map(p => p.trim().toUpperCase().replace(/\s*\(.*\)$/, ''))) {
      if (!READ_PRIVS.has(priv)) extra.add(priv);
    }
    if (/WITH\s+GRANT\s+OPTION/i.test(line)) extra.add('GRANT OPTION');
  }
  return { readOnly: extra.size === 0, extra: [...extra] };
}

// EXPLAIN(전통 형식) 행들로 비용을 판정한다. 같은 id 는 중첩 루프라 곱하고, id 가 다른 블록(UNION 가지 · 파생 테이블)은 더한다.
function costVerdict(plan, limits = LIMITS) {
  const blocks = new Map();
  for (const row of plan) {
    const rows = Number(row.rows) || 0;
    const filtered = row.filtered == null ? 100 : Number(row.filtered);
    if (['ALL', 'index'].includes(row.type) && rows > limits.scanRows) {
      return { ok: false, reason: `${row.table} 를 전부 훑는다 (예상 ${rows.toLocaleString()}행 > ${limits.scanRows.toLocaleString()}). 인덱스 조건으로 좁히거나 추정치(information_schema.TABLES.TABLE_ROWS)를 쓴다` };
    }
    if (row.id == null) continue; // UNION RESULT: 앞 블록의 합이다
    blocks.set(row.id, (blocks.get(row.id) ?? 1) * Math.max(1, rows * (filtered / 100)));
  }
  const total = [...blocks.values()].reduce((a, b) => a + b, 0);
  if (total > limits.joinRows) {
    return { ok: false, reason: `예상 처리 행이 너무 많다 (${Math.round(total).toLocaleString()} > ${limits.joinRows.toLocaleString()}). 조건을 좁힌다` };
  }
  return { ok: true, estimate: Math.round(total) };
}

// 개인정보로 보이는 컬럼은 통째로, 값 안의 개인정보 형태는 그 부분만 가린다. 결과가 대화에 들어가기 전의 마지막 방어다.
// 컬럼은 원래 이름(orgName)과 결과 이름 둘 다 본다.
const PII_VALUE = [
  /[\w.+-]+@[\w-]+(\.[\w-]+)+/g, // 이메일
  /\b\d{6}[- ]?[1-8]\d{6}\b/g, // 주민 · 외국인등록번호
  /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g, // 카드번호
  // 전화 · 휴대폰: 01x · 지역번호 · 070 · 050x, 구분자(- · 점 · 공백 · 괄호) 유무, +82 · +82 (0)
  /(\+82[-. ]?(\(0\)\s?)?\(?0?|\(?\b0)(1[016789]|2|[3-7]\d|50\d)\)?[-. ]?\d{3,4}[-. ]?\d{4}\b/g,
];
const MASK = '***';

function text(value) {
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function maskRows(columns, rows, patterns = piiColumnPatterns()) {
  let masked = 0;
  const piiCols = columns.map(col => (typeof col === 'string' ? [col] : [col.name, col.orgName]).some(n => n && isPiiColumn(n, patterns)));
  const out = rows.map(row => row.map((value, i) => {
    if (value == null) return value;
    if (piiCols[i]) {
      masked += 1;
      return MASK;
    }
    let hit = false;
    let s = text(value);
    for (const re of PII_VALUE) {
      s = s.replace(re, () => {
        hit = true;
        return MASK;
      });
    }
    if (hit) masked += 1;
    return s;
  }));
  return { rows: out, masked };
}

module.exports = { LIMITS, strip, verdictSql, withLimit, privileges, costVerdict, maskRows, isPiiColumn };
