#!/usr/bin/env node
// dbgate 접속 목록 해석 자체 점검. 키체인 · DB 없이 부른다.
// 비밀번호를 엉뚱한 계정에 넣거나 지운 접속을 되살리는 결함은 접속이 실패하기 전까지 드러나지 않는다.
//
//   DG1  지운 접속(removed)은 목록에서 빠진다
//   DG2  아이디가 비면 userCommand 출력을 쓴다
//   DG3  비밀번호는 keychain 이 없으면 passwordCommand. 아이디를 따로 적은 접속이 다른 계정이면 쓰지 않는다
//   DG4  터널 표시: ssh · forward · 로컬 주소(local 제외)
//   DG5  DbGate 접속 파일 동기: 지운 접속의 예전 줄은 되살아나지 않고, 화면에서 만든 접속은 남는다
//   DG6  DbGate 접속 항목: 모두 읽기 전용, 폴더는 프로젝트 단계, SSH 터널 매핑, MySQL 만 SSL, 비밀번호 없으면 묻기
import { createRequire } from 'module';
import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbgate-selftest-'));
const list = path.join(dir, 'connections.json');
fs.writeFileSync(list, JSON.stringify([
  { id: 'a', label: '[alpha] a', engine: 'mysql', server: 'db.example', port: 3306 },
  { id: 'b', label: '[old] b', engine: 'mysql', server: 'db.example', port: 3306, removed: true },
]));
process.env.DBGATE_CONNECTIONS = list;

const require = createRequire(import.meta.url);
const c = require('../skills/dbgate/lib/connections.js');
const NO_ITEM = 'ops-agent-selftest-no-such-item';

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('DG1 지운 접속', () => {
  assert.deepEqual(c.load().map(x => x.id), ['a']);
});

test('DG2 userCommand', () => {
  assert.equal(c.findUser({ userCommand: 'echo team' }), 'team');
  assert.equal(c.findUser({ user: 'me', userCommand: 'echo team' }), 'me');
  assert.equal(c.findUser({}), '');
});

test('DG3 passwordCommand', () => {
  const team = { keychain: NO_ITEM, userCommand: 'echo team', passwordCommand: 'echo secret' };
  assert.equal(c.findPassword(team, c.findUser(team)), 'secret');
  const same = { ...team, user: 'team' };
  assert.equal(c.findPassword(same, c.findUser(same)), 'secret');
  const other = { ...team, user: 'someone' };
  assert.equal(c.findPassword(other, c.findUser(other)), null);
  assert.equal(c.findPassword({ keychain: NO_ITEM }, 'x'), null);
  // userCommand 없이 user 만 있으면 passwordCommand 는 그 user 의 비밀번호다
  assert.equal(c.findPassword({ keychain: NO_ITEM, user: 'me', passwordCommand: 'echo mine' }, 'me'), 'mine');
});

test('DG4 터널 표시', () => {
  assert.equal(c.tunnelMark({ ssh: {}, server: 'h' }), ' · SSH 터널');
  assert.equal(c.tunnelMark({ forward: {}, server: 'localhost' }), ' · k8s 포워딩');
  assert.equal(c.tunnelMark({ server: '127.0.0.1' }), ' · 포워딩 필요');
  assert.equal(c.tunnelMark({ server: 'localhost', local: true }), '');
  assert.equal(c.tunnelMark({ server: 'db.example' }), '');
});

test('DG5 접속 파일 동기', () => {
  const raw = [{ id: 'a' }, { id: 'b', removed: true }];
  const old = [JSON.stringify({ _id: 'a', displayName: 'old a' }), JSON.stringify({ _id: 'b', displayName: 'old b' }), JSON.stringify({ _id: 'ui', displayName: 'made in ui' }), ''];
  const lines = c.mergeStore(raw, old, [{ _id: 'a', displayName: 'new a' }]);
  assert.deepEqual(lines.map(l => JSON.parse(l)._id), ['a', 'ui']);
  assert.equal(JSON.parse(lines[0]).displayName, 'new a');
});

test('DG6 DbGate 접속 항목', () => {
  const my = c.toDbgate({ id: 'm', label: '[real] m', folder: 'Proj / real · site', engine: 'mysql', server: 'db', port: 3306,
    ssh: { login: 'u', host: 'bastion', port: 22, keyfile: '~/.ssh/k.pem' } }, 'team', false);
  assert.deepEqual(JSON.parse(JSON.stringify(my)), {
    _id: 'm', displayName: '[real] m · SSH 터널', parent: 'Proj', engine: 'mysql@dbgate-plugin-mysql', server: 'db', port: '3306', user: 'team',
    useSshTunnel: true, sshHost: 'bastion', sshPort: '22', sshLogin: 'u', sshMode: 'keyFile', sshKeyfile: path.join(os.homedir(), '.ssh/k.pem'),
    isReadOnly: true, useSsl: true, passwordMode: 'askPassword',
  });
  const rd = c.toDbgate({ id: 'r', label: '[alpha] r', engine: 'redis', server: 'r', port: 6379, separator: ':', database: '0' }, '', true);
  assert.equal(rd.defaultDatabase, '0');
  assert.equal(rd.isReadOnly, true);
  assert.equal(rd.useSsl, undefined);
  assert.equal(rd.passwordMode, undefined);
  assert.equal(rd.treeKeySeparator, ':');
  assert.equal(rd.engine, 'redis@dbgate-plugin-redis');
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
