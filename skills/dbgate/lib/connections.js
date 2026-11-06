// 접속 목록을 읽고 계정 · 비밀번호 · 터널을 푼다. DbGate 서버(serve.js)와 조회 도구가 같이 쓴다.
// 목록 형식은 ../SKILL.md 「접속 목록」 절이 정본이다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const LIST = process.env.DBGATE_CONNECTIONS || path.join(os.homedir(), '.claude', 'ops-agent', 'dbgate', 'connections.json');
const ENGINES = { mysql: 'mysql@dbgate-plugin-mysql', redis: 'redis@dbgate-plugin-redis' };
// DbGate 폴더는 한 단계뿐이다. 목록의 「프로젝트 / 환경」 중 프로젝트만 폴더로 쓰고, 환경은 이름 앞 [환경] 으로 보인다.
const FOLDER_DEPTH = 1;

// removed 는 지운 접속이다. 가져오기 스크립트가 다시 넣지 않도록 목록에는 남기고 쓰지는 않는다.
function load() {
  if (!fs.existsSync(LIST)) return [];
  return JSON.parse(fs.readFileSync(LIST, 'utf8')).filter(conn => !conn.removed);
}

function run(cmd, args) {
  try {
    const value = execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().replace(/\n$/, '');
    return value || null;
  } catch {
    return null;
  }
}

const keychain = service => (service ? run('security', ['find-generic-password', '-s', service, '-w']) : null);
const command = line => (line ? run('bash', ['-c', line]) : null);

// 아이디가 비어 있으면 userCommand 의 출력을 쓴다.
function findUser(conn) {
  return conn.user || command(conn.userCommand) || '';
}

// 비밀번호 찾는 순서: 전용 키체인(keychain) → passwordCommand.
// passwordCommand 는 userCommand 계정의 비밀번호다. 아이디를 따로 적은 접속이 다른 계정이면 쓰지 않는다(권한 범위가 달라진다).
// userCommand 없이 user 만 있으면 passwordCommand 는 그 user 의 비밀번호로 본다.
function findPassword(conn, user) {
  const own = keychain(conn.keychain);
  if (own != null) return own;
  if (!conn.passwordCommand) return null;
  if (conn.user && conn.userCommand && command(conn.userCommand) !== user) return null;
  return command(conn.passwordCommand);
}

// 터널로 통신하는 접속은 폴더를 펼치지 않고 이름에서 보이게 표시한다.
// local 표시가 있는 접속은 로컬에서 도는 DB 라 표시하지 않는다.
function tunnelMark(conn) {
  if (conn.ssh) return ' · SSH 터널';
  if (conn.forward) return ' · k8s 포워딩';
  if (!conn.local && ['localhost', '127.0.0.1'].includes(conn.server)) return ' · 포워딩 필요';
  return '';
}

// 목록 항목 하나를 DbGate 접속 항목으로 옮긴다. 비밀번호는 넣지 않는다.
function toDbgate(conn, user, hasPassword) {
  const ssh = conn.ssh
    ? { useSshTunnel: true, sshHost: conn.ssh.host, sshPort: String(conn.ssh.port), sshLogin: conn.ssh.login, sshMode: 'keyFile', sshKeyfile: conn.ssh.keyfile.replace(/^~/, os.homedir()) }
    : {};
  return {
    _id: conn.id,
    displayName: conn.label + tunnelMark(conn),
    parent: (conn.folder || '').split(' / ').slice(0, FOLDER_DEPTH).join(' / ') || undefined,
    engine: ENGINES[conn.engine] || conn.engine,
    server: conn.server,
    port: String(conn.port),
    user,
    ...ssh,
    defaultDatabase: conn.database || undefined,
    isReadOnly: true,
    // MySQL 은 SSL 필수 계정이 있다. mysql 명령의 기본(암호화, 인증서 검증 없음)과 같게 켠다.
    useSsl: conn.engine === 'mysql' ? true : undefined,
    // Redis 키를 이 구분자로 묶어 트리로 보인다.
    treeKeySeparator: conn.separator || undefined,
    // 비밀번호를 못 찾으면 접속할 때 묻는다. 아이디는 채워져 보인다.
    passwordMode: hasPassword ? undefined : 'askPassword',
  };
}

// DbGate 접속 파일의 새 줄들. 목록에 있는 id(지운 접속 포함)는 목록 값으로 바꾸고, 화면에서 따로 만든 접속만 남긴다.
// 지운 접속을 managed 에 넣어야 예전에 동기된 줄이 남은 접속으로 되살아나지 않는다.
function mergeStore(rawList, storeLines, entries) {
  const managed = new Set(rawList.map(conn => conn.id));
  const kept = storeLines.filter(line => line.trim() && !managed.has(JSON.parse(line)._id));
  return [...entries.map(entry => JSON.stringify(entry)), ...kept];
}

// k8s 포트포워드를 연다. 파드 이름은 앞부분(podPrefix)으로 매번 찾는다.
// context 는 항상 명시한다(기본 context 가 다른 클러스터일 수 있다). 열지 못하면 null.
function openForward(f) {
  const base = ['--context', f.context, '-n', f.namespace];
  let pod = null;
  try {
    pod = execFileSync('kubectl', [...base, 'get', 'pods', '-o', 'name'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 })
      .toString().split('\n').find(name => name.startsWith(`pod/${f.podPrefix}`));
  } catch {
    pod = null;
  }
  if (!pod) return null;
  return spawn('kubectl', [...base, 'port-forward', '--address', '127.0.0.1', pod, `${f.localPort}:${f.remotePort}`], { stdio: 'ignore' });
}

module.exports = { LIST, load, findUser, findPassword, tunnelMark, toDbgate, mergeStore, openForward };
