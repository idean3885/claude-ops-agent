// DbGate 웹 서버를 이 PC 안(127.0.0.1)에서만 접속되게 띄운다.
// dbgate-serve 는 모든 네트워크 주소에서 접속을 받으므로, 시작 전에 HTTP 서버의 listen 주소를 고정한다.
//
// 접속 목록을 켤 때마다 DbGate 접속 파일(~/.dbgate/connections.jsonl)에 맞춘다.
// 아이디 · 폴더 · 읽기 전용까지 미리 들어가고, 비밀번호는 파일에 쓰지 않는다.
// 찾은 비밀번호는 DbGate 가 접속을 열 때 메모리에서만 넣어 준다.
const http = require('http');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const path = require('path');
const connections = require('./lib/connections');

const STORE = path.join(os.homedir(), '.dbgate', 'connections.jsonl');
const API = path.join(execSync('npm root -g').toString().trim(), 'dbgate-serve', 'node_modules', 'dbgate-api', 'src');

// 목록에 있는 접속은 목록 값으로 바꾸고, DbGate 화면에서 따로 만든 접속은 그대로 둔다. 비밀번호 사전(id → 값)을 돌려준다.
function syncConnections() {
  const passwords = new Map();
  if (!fs.existsSync(connections.LIST)) return passwords;
  const list = connections.load();
  const entries = list.map(conn => {
    const user = connections.findUser(conn);
    const password = connections.findPassword(conn, user);
    if (password != null) passwords.set(conn.id, password);
    return connections.toDbgate(conn, user, password != null);
  });
  const raw = JSON.parse(fs.readFileSync(connections.LIST, 'utf8'));
  const store = fs.existsSync(STORE) ? fs.readFileSync(STORE, 'utf8').split('\n') : [];
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, connections.mergeStore(raw, store, entries).map(line => line + '\n').join(''));
  console.log(`접속 ${list.length}개 맞춤, 비밀번호 ${passwords.size}개`);
  return passwords;
}

// DbGate 는 접속을 열 때마다 connections.getCore 로 접속 정보를 읽는다. 그 결과에 비밀번호를 암호화된 형태로 더한다.
function injectPasswords(passwords) {
  if (passwords.size === 0) return;
  const store = require(path.join(API, 'controllers', 'connections.js'));
  const { encryptPasswordString } = require(path.join(API, 'utility', 'crypting.js'));
  const getCore = store.getCore;
  store.getCore = async function (args) {
    const res = await getCore.call(this, args);
    if (res && !res.password && passwords.has(res._id) && !(args && args.mask)) {
      return { ...res, password: encryptPasswordString(passwords.get(res._id)) };
    }
    return res;
  };
}

// forward 가 있는 접속은 서버와 함께 k8s 포트포워드를 연다. 서버가 꺼지면 함께 끈다.
function startForwards() {
  const children = [];
  for (const conn of connections.load()) {
    if (!conn.forward) continue;
    const child = connections.openForward(conn.forward);
    if (!child) {
      console.log(`포워딩 못 엶: ${conn.label} (파드를 찾지 못함)`);
      continue;
    }
    children.push(child);
    console.log(`포워딩 엶: ${conn.label}`);
  }
  process.on('exit', () => children.forEach(child => child.kill()));
}

const passwords = syncConnections();
startForwards();

const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function (port, ...rest) {
  if (typeof port === 'number' || typeof port === 'string') {
    return listen.call(this, port, '127.0.0.1', ...rest.filter(arg => typeof arg === 'function'));
  }
  return listen.call(this, port, ...rest);
};

require(path.join(API, '..', '..', '..', 'bin', 'dbgate-serve.js'));
// DbGate 는 모듈을 처음 불러올 때 npm 설치판 표시(dbgate-serve.js 가 정하는 전역 값)를 읽어 웹 화면을 낼지 정한다.
// 그래서 비밀번호 연결은 dbgate-serve.js 를 불러온 뒤에 건다. 요청은 서버가 뜬 뒤에 오므로 늦지 않다.
injectPasswords(passwords);
