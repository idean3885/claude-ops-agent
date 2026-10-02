#!/usr/bin/env node
/**
 * selftest-build-guard.mjs — 빌드 스크립트 가드 자체 점검.
 *
 * `build-guard-rules.mjs` 나 `pre-tool-use.mjs` 의 Write·Edit 분기를 고쳤으면 돌린다.
 * 가드는 발동할 때만 존재가 드러나므로 조용히 무력화되면 신호가 없다.
 *
 * 사용: node scripts/selftest-build-guard.mjs
 * 종료 코드: 실패 1, 전부 통과 0
 */
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const hook = join(here, 'pre-tool-use.mjs');

// 번들을 쓰는 레포와 쓰지 않는 레포를 각각 만든다.
const bundled = mkdtempSync(join(tmpdir(), 'ops-build-guard-'));
mkdirSync(join(bundled, 'gradle', 'lib'), { recursive: true });
mkdirSync(join(bundled, 'storage', 'adapter'), { recursive: true });
writeFileSync(join(bundled, 'settings.gradle'), "rootProject.name = 'x'\n");
writeFileSync(join(bundled, 'build.gradle'), '');
writeFileSync(join(bundled, 'gradle', 'lib', 'jpa.gradle'), "dependencies {\n  implementation 'org.springframework.boot:spring-boot-starter-data-jpa'\n}\n");
writeFileSync(join(bundled, 'storage', 'adapter', 'build.gradle'), "apply from: rootProject.file('gradle/adapter.gradle')\n\ndependencies {\n  implementation project(':storage-api')\n}\n");

const plain = mkdtempSync(join(tmpdir(), 'ops-build-guard-plain-'));
mkdirSync(join(plain, 'app'), { recursive: true });
writeFileSync(join(plain, 'settings.gradle'), "rootProject.name = 'y'\n");
writeFileSync(join(plain, 'app', 'build.gradle'), "dependencies {\n}\n");

const moduleScript = join(bundled, 'storage', 'adapter', 'build.gradle');
const multilineScript = join(bundled, 'storage', 'adapter', 'build.gradle.kts');
const multilineContent = 'dependencies {\n  implementation(\n    "org.example:existing:1.0"\n  )\n}\n';
writeFileSync(multilineScript, multilineContent);

// want: 'pass' = 통과해야 한다, 'deny' = 차단되어야 한다
const CASES = [
  ['모듈 스크립트에 라이브러리 좌표 (Edit)', 'Edit', {
    file_path: moduleScript, old_string: "  implementation project(':storage-api')\n",
    new_string: "  implementation project(':storage-api')\n  implementation 'org.springframework:spring-tx'\n",
  }, 'deny'],
  ['모듈 스크립트에 버전 있는 좌표 (Edit)', 'Edit', {
    file_path: moduleScript, old_string: 'dependencies {\n',
    new_string: 'dependencies {\n  testImplementation("com.h2database:h2:2.3.232")\n',
  }, 'deny'],
  ['모듈 스크립트 전체 쓰기에 라이브러리 좌표 (Write)', 'Write', {
    file_path: moduleScript,
    content: "apply from: rootProject.file('gradle/adapter.gradle')\n\ndependencies {\n  implementation project(':storage-api')\n  runtimeOnly 'com.h2database:h2'\n}\n",
  }, 'deny'],
  ['여러 줄에 걸친 좌표 선언 (Write)', 'Write', {
    file_path: moduleScript,
    content: "apply from: rootProject.file('gradle/adapter.gradle')\n\ndependencies {\n  implementation project(':storage-api')\n  implementation(\n    'org.example:client:1.0'\n  )\n}\n",
  }, 'deny'],
  ['기존 선언과 시작 줄이 같은 여러 줄 선언 (Write)', 'Write', {
    file_path: multilineScript,
    content: multilineContent.replace('dependencies {\n', 'dependencies {\n  implementation(\n    "org.example:client:1.0"\n  )\n'),
  }, 'deny'],
  ['여러 줄에 걸친 좌표 선언 (Edit)', 'Edit', {
    file_path: moduleScript, old_string: 'dependencies {\n',
    new_string: 'dependencies {\n  implementation(\n    "org.example:client:1.0"\n  )\n',
  }, 'deny'],
  ['여러 줄 선언 안의 좌표만 교체 (Edit)', 'Edit', {
    file_path: multilineScript, old_string: 'org.example:existing:1.0',
    new_string: 'org.example:client:1.0',
  }, 'deny'],
  ['여러 줄 선언 안의 좌표 순차 교체 (MultiEdit)', 'MultiEdit', {
    file_path: multilineScript, edits: [
      { old_string: 'org.example:existing:1.0', new_string: 'LIB', replace_all: true },
      { old_string: 'LIB', new_string: 'org.example:client:1.0', replace_all: true },
    ],
  }, 'deny'],
  ['기존 여러 줄 좌표를 그대로 둔 편집 (Write)', 'Write', {
    file_path: multilineScript,
    content: multilineContent + '// unchanged dependency\n',
  }, 'pass'],
  ['모듈 간 의존을 좌표로 바꾸는 부분 교체 (Edit)', 'Edit', {
    file_path: moduleScript, old_string: "project(':storage-api')", new_string: "'org.example:client:1.0'",
  }, 'deny'],
  ['순차 교체로 좌표가 되는 편집 (MultiEdit)', 'MultiEdit', {
    file_path: moduleScript, edits: [
      { old_string: "project(':storage-api')", new_string: 'LIB' },
      { old_string: 'LIB', new_string: "'org.example:client:1.0'" },
    ],
  }, 'deny'],
  ['모듈 간 의존 추가', 'Edit', {
    file_path: moduleScript, old_string: "  implementation project(':storage-api')\n",
    new_string: "  implementation project(':storage-api')\n  implementation project(':storage-core')\n",
  }, 'pass'],
  ['번들 apply 추가', 'Edit', {
    file_path: moduleScript, old_string: "apply from: rootProject.file('gradle/adapter.gradle')\n",
    new_string: "apply from: rootProject.file('gradle/adapter.gradle')\napply from: rootProject.file('gradle/lib/jpa.gradle')\n",
  }, 'pass'],
  ['이미 있던 좌표를 그대로 둔 편집', 'Write', {
    file_path: join(bundled, 'gradle', 'lib', 'jpa.gradle'),
    content: "dependencies {\n  implementation 'org.springframework.boot:spring-boot-starter-data-jpa'\n  implementation 'org.flywaydb:flyway-core'\n}\n",
  }, 'pass'],
  ['루트 build.gradle', 'Edit', {
    file_path: join(bundled, 'build.gradle'), old_string: '',
    new_string: "dependencies {\n  implementation 'a:b:1'\n}\n",
  }, 'pass'],
  ['번들 없는 레포의 모듈 스크립트', 'Edit', {
    file_path: join(plain, 'app', 'build.gradle'), old_string: 'dependencies {\n',
    new_string: "dependencies {\n  implementation 'org.springframework:spring-tx'\n",
  }, 'pass'],
  ['빌드 스크립트가 아닌 파일', 'Edit', {
    file_path: join(bundled, 'storage', 'adapter', 'README.md'), old_string: '',
    new_string: "implementation 'org.springframework:spring-tx'\n",
  }, 'pass'],
];

let failed = 0;
for (const [name, toolName, toolInput, want] of CASES) {
  const res = spawnSync('node', [hook], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd: bundled, session_id: 'selftest' }),
    env: { ...process.env, OPS_AGENT_BUILD_GUARD_DISABLE: '', OPS_AGENT_BUILD_GUARD_DRYRUN: '' },
    encoding: 'utf8',
  });
  const out = res.stdout || '';
  const denied = out.includes('"permissionDecision":"deny"') && out.includes('빌드 스크립트 가드');
  const ran = !res.error && res.status === 0 && !res.signal;
  const ok = want === 'deny' ? denied : (ran && !denied);
  if (!ok) {
    failed++;
    if (!ran) console.log(`      훅 실행 실패: status=${res.status} signal=${res.signal} ${res.error || ''}\n${res.stderr || ''}`);
  }
  console.log(`${ok ? '  OK' : '  XX'}  ${name} — want ${want}, got ${denied ? 'deny' : 'pass'}`);
}

rmSync(bundled, { recursive: true, force: true });
rmSync(plain, { recursive: true, force: true });
console.log(failed ? `\n${failed}건 실패` : '\n전부 통과');
process.exit(failed ? 1 : 0);
