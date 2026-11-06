#!/usr/bin/env node
// AI 가 DB 를 조회하는 유일한 진입점. 접속 목록(dbgate 스킬)의 MySQL 접속에 가드를 건 조회 하나를 보낸다.
//
//   node query.js "<접속 이름>" --sql "<SELECT ...>" [--database <스키마>] [--allow-write-account]
//
// 순서: 문장 판정 → 접속 → 계정 권한 확인 → 읽기 전용 세션 · 실행 시간 제한 → 실행 계획 비용 판정 → 실행 → 개인정보 가림 → 출력
// --allow-write-account: 조회 전용 계정이 아닌 접속을 이번 한 번 허용한다(긴급). 하네스 ask 규칙이 매번 사람에게 묻는다.
// 문장 · 비용 · 개인정보 가드는 이 옵션과 관계없이 걸린다.
//
// 종료 코드: 0 성공, 1 인자 오류, 3 거절(문장 · 비용), 4 조회 전용 계정 아님, 5 접속 실패
// 감사 기록: ~/.claude/ops-agent/db-query/audit.jsonl (DB_QUERY_AUDIT_LOG 로 바꾼다)
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { execSync, spawn } = require('child_process');
const connections = require('../dbgate/lib/connections');
const guard = require('./guard');

const AUDIT = process.env.DB_QUERY_AUDIT_LOG || path.join(os.homedir(), '.claude', 'ops-agent', 'db-query', 'audit.jsonl');

function parseArgs(argv) {
  const args = { label: null, sql: null, database: null, allowWrite: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--sql') args.sql = argv[++i];
    else if (a === '--database') args.database = argv[++i];
    else if (a === '--allow-write-account') args.allowWrite = true;
    else if (!args.label) args.label = a;
    else return null;
  }
  return args.label && args.sql ? args : null;
}

function audit(record) {
  fs.mkdirSync(path.dirname(AUDIT), { recursive: true });
  fs.appendFileSync(AUDIT, JSON.stringify({ ts: new Date().toISOString(), actor: 'ai', ...record }) + '\n');
}

function fail(code, message, record) {
  console.error(message);
  if (record) audit({ ...record, outcome: 'rejected', exit: code });
  process.exit(code);
}

const freePort = () => new Promise(resolve => {
  const srv = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

const listening = port => new Promise(resolve => {
  const sock = net.connect(port, '127.0.0.1');
  sock.once('connect', () => { sock.destroy(); resolve(true); });
  sock.once('error', () => resolve(false));
});

async function waitPort(port, ms = 15000) {
  for (let t = 0; t < ms; t += 300) {
    if (await listening(port)) return true;
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

// 터널이 필요한 접속은 이번 조회 동안만 연다. 이미 열린 포트포워드(DbGate 서버가 연 것)가 있으면 그것을 쓴다.
async function openRoute(conn) {
  if (conn.ssh) {
    const port = await freePort();
    const s = conn.ssh;
    const child = spawn('ssh', ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-i', s.keyfile.replace(/^~/, os.homedir()),
      '-p', String(s.port), '-L', `127.0.0.1:${port}:${conn.server}:${conn.port}`, `${s.login}@${s.host}`], { stdio: 'ignore' });
    if (!(await waitPort(port))) { child.kill(); return null; }
    return { host: '127.0.0.1', port, close: () => child.kill() };
  }
  if (conn.forward) {
    const port = conn.forward.localPort;
    if (await listening(port)) return { host: '127.0.0.1', port, close: () => {} };
    const child = connections.openForward(conn.forward);
    if (!child || !(await waitPort(port))) { if (child) child.kill(); return null; }
    return { host: '127.0.0.1', port, close: () => child.kill() };
  }
  return { host: conn.server, port: Number(conn.port), close: () => {} };
}

function render(columns, rows) {
  const lines = [columns.join('\t'), ...rows.map(r => r.map(v => (v == null ? 'NULL' : String(v))).join('\t'))];
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) fail(1, 'usage: node query.js "<접속 이름>" --sql "<SELECT ...>" [--database <스키마>] [--allow-write-account]');

  const conn = connections.load().find(c => c.label === args.label);
  if (!conn) fail(1, `접속 목록에 없다: ${args.label}`);
  if (conn.engine !== 'mysql') fail(1, `MySQL 접속만 조회한다 (${conn.engine})`);
  const base = { label: args.label, sql: args.sql };

  const verdict = guard.verdictSql(args.sql);
  if (!verdict.ok) fail(3, `거절: ${verdict.reason}`, base);

  const user = connections.findUser(conn);
  const password = connections.findPassword(conn, user);
  const route = await openRoute(conn);
  if (!route) fail(5, '터널을 열지 못했다', base);

  // DB_QUERY_MYSQL2 는 자체 점검이 가짜 드라이버를 넣는 자리다
  const mysql = require(process.env.DB_QUERY_MYSQL2 || path.join(execSync('npm root -g').toString().trim(), 'dbgate-serve', 'node_modules', 'mysql2', 'promise'));
  let db;
  try {
    db = await mysql.createConnection({
      host: route.host, port: route.port, user, password: password || undefined,
      database: args.database || conn.database || undefined,
      // mysql 명령의 기본과 같다: 암호화는 하되 인증서는 검증하지 않는다. SSL 필수 계정이 있고, 사설 인증서 CA 를 목록에 두지 않는다
      ssl: { rejectUnauthorized: false }, connectTimeout: 15000,
    });
  } catch (err) {
    route.close();
    fail(5, `접속 실패: ${err.code || err.message}`, base);
  }
  const done = () => { db.destroy(); route.close(); };

  try {
    const [grants] = await db.query({ sql: 'SHOW GRANTS', rowsAsArray: true });
    const priv = guard.privileges(grants.map(r => String(r[0])));
    const account = priv.readOnly ? 'read-only' : 'exception';
    if (!priv.readOnly && !args.allowWrite) {
      done();
      fail(4, `조회 전용 계정이 아니다 (추가 권한: ${priv.extra.join(', ')}). 긴급이면 --allow-write-account 로 다시 실행한다. 하네스가 승인을 묻는다`, { ...base, account });
    }

    await db.query('SET SESSION TRANSACTION READ ONLY');
    // 가드는 역슬래시를 문자열 이스케이프로, 큰따옴표를 문자열로 읽는다. 서버도 같게 읽도록 sql_mode 를 MySQL 8 기본값으로 고정한다
    // (NO_BACKSLASH_ESCAPES · ANSI_QUOTES 가 없는 값)
    await db.query("SET SESSION sql_mode = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'");
    await db.query(`SET SESSION max_execution_time = ${guard.LIMITS.timeoutMs}`);

    let sql = args.sql;
    let estimate = null;
    if (verdict.kind === 'select') {
      const [plan] = await db.query(`EXPLAIN ${sql.replace(/;\s*$/, '')}`);
      const cost = guard.costVerdict(plan);
      if (!cost.ok) {
        done();
        fail(3, `거절: ${cost.reason}`, { ...base, account });
      }
      estimate = cost.estimate;
      sql = guard.withLimit(sql);
    }

    const [rows, fields] = await db.query({ sql, rowsAsArray: true });
    const columns = (fields || []).map(f => ({ name: f.name, orgName: f.orgName }));
    const shown = rows.slice(0, guard.LIMITS.rows);
    const masked = guard.maskRows(columns, shown);
    console.log(render(columns.map(c => c.name), masked.rows));
    console.log(`-- 행 ${shown.length}${rows.length > shown.length ? ` (상한 ${guard.LIMITS.rows}에서 자름)` : ''} · 가림 ${masked.masked}칸 · 계정 ${account}${estimate != null ? ` · 예상 처리 ${estimate}행` : ''}`);
    audit({ ...base, account, outcome: 'ok', rows: shown.length, masked: masked.masked, exit: 0 });
    done();
  } catch (err) {
    done();
    fail(5, `실행 실패: ${err.code || err.message}`, base);
  }
}

main();
