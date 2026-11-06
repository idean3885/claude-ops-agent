#!/usr/bin/env node
// db-query 가드 자체 점검. 판정 함수는 그대로, 진입점(query.js)은 가짜 드라이버로 DB 없이 부른다.
// 가드는 거절할 때만 존재가 드러나므로, 무너지면 무거운 조회 · 쓰기 · 개인정보가 신호 없이 통과한다.
//
//   DQ1  읽기 문장 하나만 통과한다. 쓰기 · 여러 문장 · 잠금 · 파일 출력 · 대기 함수 · EXPLAIN ANALYZE 는 거절한다
//   DQ2  문자열 · 주석은 나타난 순서대로 지운다. 문자열 안의 주석 기호에 속지 않고, 버전 주석은 같은 순서로 찾아 거절한다
//   DQ3  SELECT 목록의 * (t.* · 수식어 뒤 · 다른 컬럼 뒤 포함)는 거절하고 COUNT(*) 는 통과한다
//   DQ4  SELECT · SHOW 권한만 있는 계정은 조회 전용, 그 밖의 권한 · 역할 · GRANT OPTION 은 아니다. 부분 회수 줄은 무시한다
//   DQ5  큰 테이블 전체 훑기와 큰 조인은 거절한다. 같은 id 는 곱하고 다른 id 는 더한다
//   DQ6  바깥 LIMIT 이 없으면 줄을 바꿔 붙이고, 상한을 넘는 LIMIT 은 거절한다
//   DQ7  개인정보 컬럼은 결과로 내지 않는다(별칭 · 함수 · 백틱 · camelCase 포함). 가림은 원래 이름과 결과 이름을 함께 보고, 값 안의 형태는 그 부분만 가린다
//   DQ8  진입점: 조회 전용 아님 → 종료 4, 예외 옵션 → 실행 · exception 기록, 비용 거절 → 본 조회 미실행, 정상 → LIMIT · 가림 · 기록
import { createRequire } from 'module';
import { spawnSync } from 'child_process';
import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-query-selftest-'));
process.env.DB_QUERY_PII = path.join(dir, 'no-pii.json'); // 소비 환경의 추가 패턴 없이 기본값만 본다

const require = createRequire(import.meta.url);
const guard = require('../skills/db-query/guard.js');

const cases = [];
const test = (name, fn) => cases.push([name, fn]);
const ok = sql => assert.equal(guard.verdictSql(sql).ok, true, sql);
const no = sql => assert.equal(guard.verdictSql(sql).ok, false, sql);

test('DQ1 읽기 문장만', () => {
  ['SELECT id FROM t', 'select id from t;', 'WITH a AS (SELECT 1 x) SELECT x FROM a', 'SHOW TABLES', 'DESC t', 'EXPLAIN SELECT id FROM t'].forEach(ok);
  ['UPDATE t SET a=1', 'DELETE FROM t', 'SELECT 1; DELETE FROM t', 'SELECT id FROM t FOR UPDATE',
    'SELECT id FROM t LOCK IN SHARE MODE', "SELECT id INTO OUTFILE '/tmp/x' FROM t", 'SELECT SLEEP(10)',
    "SELECT SOURCE_POS_WAIT('f', 4)", 'WITH a AS (SELECT 1) DELETE FROM t', 'SET @a = 1', '',
    'EXPLAIN ANALYZE SELECT id FROM big', 'DESC ANALYZE SELECT id FROM big', 'DESCRIBE ANALYZE SELECT id FROM big'].forEach(no);
});

test('DQ2 문자열 · 주석', () => {
  ok("SELECT id FROM t WHERE memo = 'DELETE; DROP TABLE t'");
  ok('SELECT id /* ; UPDATE t */ FROM t');
  no("SELECT id FROM t WHERE memo = 'a#b' FOR UPDATE");
  no("SELECT id FROM t WHERE memo = 'x -- y' FOR UPDATE");
  no("SELECT id FROM t WHERE memo = '/*' FOR UPDATE -- */");
  no('SELECT id FROM t /*!50000 FOR UPDATE */');
  no("SELECT id FROM t /*!50000 INTO OUTFILE '/tmp/x' */");
  no('SELECT id FROM t /*!50000 FOR /* */ UPDATE */');
  no('SELECT /*! /* */ * */ FROM t');
  ok("SELECT id FROM t WHERE memo = '/*!50000 x */'");
  no("SELECT id FROM t WHERE 1=1 /* ' */ LIMIT 5 /*!50000 FOR /* */ UPDATE */ -- '");
  no("SELECT id FROM t -- it's\n/*!50000 FOR /* */ UPDATE */ -- don't");
  no('SELECT id FROM t /*M!100000 FOR UPDATE */');
  no('SELECT /*+ MAX_EXECUTION_TIME(600000) */ id FROM t');
  no('SELECT /*+ max_execution_time(600000) */ id FROM t');
  no('SELECT /*+ SET_VAR(max_execution_time=600000) */ id FROM t');
  no('SELECT id FROM t WHERE id IN (SELECT /*+ max_execution_time(99999999) */ id FROM u)');
  no('SELECT /*+ QB_NAME(`a*b`) MAX_EXECUTION_TIME(600000) */ id FROM t');
  no("SELECT /*+ SET_VAR(optimizer_switch='a*') max_execution_time(600000) */ id FROM t");
  ok('SELECT /*+ INDEX(t idx_a) */ id FROM t');
});

test('DQ3 SELECT *', () => {
  ['SELECT * FROM t', 'SELECT t.* FROM t', 'SELECT DISTINCT * FROM t', 'SELECT id, t.* FROM t', 'SELECT SQL_NO_CACHE * FROM t',
    'SELECT db.t.* FROM db.t', 'SELECT id FROM t WHERE id IN (SELECT * FROM u)'].forEach(no);
  ok('SELECT COUNT(*) FROM t WHERE id < 10');
  ok('SELECT a * b AS c FROM t');
  ok('SELECT id FROM t WHERE EXISTS (SELECT * FROM u WHERE u.t_id = t.id)');
});

test('DQ4 계정 권한', () => {
  assert.equal(guard.privileges(['GRANT USAGE ON *.* TO `r`@`%`', 'GRANT SELECT, SHOW VIEW ON `app`.* TO `r`@`%`']).readOnly, true);
  assert.equal(guard.privileges(['GRANT SELECT ON *.* TO `r`@`%`', 'REVOKE SELECT ON `mysql`.* FROM `r`@`%`']).readOnly, true);
  assert.equal(guard.privileges(['GRANT SELECT, INSERT ON `app`.* TO `w`@`%`']).readOnly, false);
  assert.equal(guard.privileges(['GRANT SELECT ON `app`.* TO `w`@`%` WITH GRANT OPTION']).readOnly, false);
  assert.equal(guard.privileges(['GRANT `reader`@`%` TO `u`@`%`']).readOnly, false);
  assert.equal(guard.privileges(['GRANT ALL PRIVILEGES ON *.* TO `root`@`%`']).readOnly, false);
});

test('DQ5 비용', () => {
  assert.equal(guard.costVerdict([{ id: 1, table: 'events', type: 'index', rows: 300000000, filtered: 100 }]).ok, false);
  assert.equal(guard.costVerdict([{ id: 1, table: 'events', type: 'ALL', rows: 2000000, filtered: 10 }]).ok, false);
  assert.equal(guard.costVerdict([{ id: 1, table: 'a', type: 'ref', rows: 5000 }, { id: 1, table: 'b', type: 'ref', rows: 5000 }]).ok, false);
  assert.equal(guard.costVerdict([{ id: 1, table: 'a', type: 'ref', rows: 5000 }, { id: 2, table: 'b', type: 'ref', rows: 5000 }, { id: null, table: '<union1,2>', type: 'ALL', rows: null }]).ok, true);
  assert.equal(guard.costVerdict([{ id: 1, table: 'events', type: 'range', rows: 1200, filtered: 100 }]).ok, true);
  assert.equal(guard.costVerdict([{ id: 1, table: 'small', type: 'ALL', rows: 300, filtered: 100 }]).ok, true);
});

test('DQ6 LIMIT', () => {
  assert.equal(guard.withLimit('SELECT id FROM t'), 'SELECT id FROM t\nLIMIT 200');
  assert.equal(guard.withLimit('SELECT id FROM t -- note'), 'SELECT id FROM t -- note\nLIMIT 200');
  assert.equal(guard.withLimit('SELECT id FROM t LIMIT 5;'), 'SELECT id FROM t LIMIT 5;');
  assert.equal(guard.withLimit('SELECT id FROM t WHERE id IN (SELECT id FROM u LIMIT 3)'), 'SELECT id FROM t WHERE id IN (SELECT id FROM u LIMIT 3)\nLIMIT 200');
  no('SELECT id FROM t LIMIT 5000');
  no('SELECT id FROM t LIMIT 5, 99999999');
  ok('SELECT id FROM t LIMIT 50');
});

test('DQ7 개인정보', () => {
  ['SELECT home_address AS a FROM t', 'SELECT CONCAT(first_name, last_name) AS n FROM t', 'SELECT HEX(email) FROM t',
    'SELECT `user email` FROM t', 'SELECT userEmail FROM t', 'SELECT u.telephone FROM u',
    'SELECT address1, phone1 FROM customers', 'SELECT phonenumber FROM t', 'SELECT homeaddress FROM t', 'SELECT birthdate FROM t',
    'SELECT mobileno FROM t', 'SELECT location FROM users', 'SELECT email2 FROM t', 'SELECT customer_name FROM t', 'SELECT tel1 FROM t', 'SELECT telno FROM t', 'SELECT TELNO FROM t', 'SELECT hpno FROM t', 'SELECT cellnum FROM t', 'SELECT telnum FROM t', 'SELECT faxno FROM t', 'SELECT telnumber FROM t'].forEach(no);
  ok('SELECT driver_version, pod_name, node_ip_count FROM gpu_nodes');
  ok('SELECT COUNT(email) FROM t');
  ok('SELECT ci.id, ci.name FROM cluster_info ci');
  ok("SELECT id FROM t WHERE email = 'a@example.com'");
  const { rows, masked } = guard.maskRows(['id', 'user_email', 'memo', 'pod_name'], [
    [1, 'a@example.com', '연락처 010 1234 5678 로 회신', 'web-1'],
    [2, null, '주민 900101-1234567 · 카드 1234 5678 9012 3456', { k: '+82-10-1234-5678' }],
  ]);
  assert.deepEqual(rows[0], ['1', '***', '연락처 *** 로 회신', 'web-1']);
  assert.deepEqual(rows[1], ['2', null, '주민 *** · 카드 ***', '{"k":"***"}']);
  assert.equal(masked, 4);
  for (const v of ['0212345678', '07012345678', '050512345678', '02)1234-5678', '(02) 1234-5678', '+82-2-1234-5678', '031-123-4567',
    '02.1234.5678', '+82 (0)2 1234 5678', '010.1234.5678', '+82 (0)10 1234 5678', '010 1234 5678', '+82-10-1234-5678']) {
    assert.deepEqual(guard.maskRows(['memo'], [[`대표 ${v} 끝`]]).rows[0], ['대표 *** 끝'], v);
  }
  assert.equal(guard.maskRows(['memo'], [['주문 20261106 수량 12345']]).masked, 0);
  // 소비 환경은 pii.json 의 columns 로 컬럼 이름을 더한다
  const extra = path.join(dir, 'pii.json');
  fs.writeFileSync(extra, JSON.stringify({ columns: ['^nickname$'] }));
  process.env.DB_QUERY_PII = extra;
  no('SELECT nickname FROM t');
  process.env.DB_QUERY_PII = path.join(dir, 'no-pii.json');
  ok('SELECT nickname FROM t');
  // 값 형태로는 안 잡히는 개인정보는 컬럼의 원래 이름으로 가린다
  const aliased = guard.maskRows([{ name: 'a', orgName: 'home_address' }], [['Seoul Main St 12']]);
  assert.deepEqual(aliased.rows[0], ['***']);
});

// 진입점: 가짜 드라이버가 SHOW GRANTS · SET · EXPLAIN · 본 조회에 시나리오대로 답하고 받은 본 조회를 기록한다
const fake = path.join(dir, 'fake-mysql2.js');
fs.writeFileSync(fake, `
const fs = require('fs');
const s = JSON.parse(process.env.FAKE_DB);
exports.createConnection = async () => ({
  async query(arg) {
    const sql = typeof arg === 'string' ? arg : arg.sql;
    if (sql === 'SHOW GRANTS') return [s.grants.map(g => [g])];
    if (sql.startsWith('SET ')) return [{}];
    if (sql.startsWith('EXPLAIN ')) return [s.plan];
    fs.appendFileSync(process.env.FAKE_DB_LOG, sql + '\\n=====\\n');
    return [s.rows, s.fields];
  },
  destroy() {},
});`);
const list = path.join(dir, 'connections.json');
fs.writeFileSync(list, JSON.stringify([{ id: 'x', label: '[test] x', engine: 'mysql', server: 'db.invalid', port: 3306, user: 'u' }]));
const audit = path.join(dir, 'audit.jsonl');
const log = path.join(dir, 'executed.log');
const READ = ['GRANT SELECT ON `app`.* TO `u`@`%`'];
const WRITE = ['GRANT SELECT, INSERT ON `app`.* TO `u`@`%`'];
const SMALL = [{ id: 1, table: 't', type: 'ref', rows: 10 }];

function run(scenario, sql, extra = []) {
  fs.rmSync(log, { force: true });
  const r = spawnSync('node', [path.join(here, '../skills/db-query/query.js'), '[test] x', '--sql', sql, ...extra], {
    encoding: 'utf8',
    env: { ...process.env, DBGATE_CONNECTIONS: list, DB_QUERY_MYSQL2: fake, DB_QUERY_AUDIT_LOG: audit, FAKE_DB: JSON.stringify(scenario), FAKE_DB_LOG: log },
  });
  const last = fs.readFileSync(audit, 'utf8').trim().split('\n').pop();
  return { code: r.status, out: r.stdout, executed: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '', audit: JSON.parse(last) };
}

test('DQ8 진입점', () => {
  const base = { plan: SMALL, rows: [[1, 'Seoul Main St 12']], fields: [{ name: 'id', orgName: 'id' }, { name: 'a', orgName: 'home_address' }] };
  let r = run({ ...base, grants: WRITE }, 'SELECT id FROM t');
  assert.equal(r.code, 4);
  assert.equal(r.executed, '');
  assert.deepEqual([r.audit.outcome, r.audit.account], ['rejected', 'exception']);

  r = run({ ...base, grants: WRITE }, 'SELECT id FROM t', ['--allow-write-account']);
  assert.equal(r.code, 0);
  assert.deepEqual([r.audit.outcome, r.audit.account], ['ok', 'exception']);

  r = run({ ...base, grants: READ, plan: [{ id: 1, table: 'big', type: 'index', rows: 300000000 }] }, 'SELECT COUNT(*) FROM big');
  assert.equal(r.code, 3);
  assert.equal(r.executed, '');

  r = run({ ...base, grants: READ }, 'SELECT id, note FROM t');
  assert.equal(r.code, 0);
  assert.match(r.executed, /\nLIMIT 200\n/);
  assert.match(r.out, /^id\ta\n1\t\*\*\*\n/);
  assert.deepEqual([r.audit.outcome, r.audit.account, r.audit.masked], ['ok', 'read-only', 1]);
});

let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${name}: ${err.message}`);
  }
}
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
