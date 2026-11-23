#!/usr/bin/env node
/**
 * expert-route-probe.mjs — 명령 하나를 전문가 경유 지표가 어떻게 세는지 실행해 보인다.
 *
 * 기록된 줄이 오탐인지, 기록되지 않은 쓰기가 미탐인지 가를 때 쓴다. 표면 판별 · 커밋 범위 해석의 경계는 문장으로 다 옮길 수 없어,
 * hooks-config 「전문가 경유 지표」 표의 「알려진 미탐 · 오탐」 칸은 종류만 적고 판별은 이 도구의 실행 결과를 따른다.
 *
 * 훅(pre-tool-use.mjs)을 실제 HOME 그대로 실행하고, 경유 지표의 기록 · 캐시 자리(OPS_AGENT_EXPERT_ROUTE_DIR)와
 * 대화 기록 파일만 임시 디렉토리에 둔다. 그래서 명령 · git 설정의 `~` · 전역 git 설정 · 표면 오버레이는 실제 세션과 같게 풀리고,
 * 사용자 HOME 에는 쓰지 않는다. 명령은 실행하지 않는다. 다른 가드는 끄고, 대화 기록은 빈 파일이라
 * 기록이 있으면 판정은 늘 누락(missed)이다. 볼 것은 기록 여부 · 표면 · 본문 줄 수다.
 * 커밋은 지정한 레포의 지금 상태(스테이징분 · 작업 트리)로 센다. 지난 커밋을 볼 때는 그 커밋 직전 상태를 되살린 레포를 준다.
 * 작업 트리와 스테이징 내용은 바꾸지 않는다(git diff 가 인덱스의 파일 시각 정보를 갱신할 수는 있다).
 * Bash 명령만 받는다. mcp 도구 표면은 이 도구로 볼 수 없다.
 *
 * 사용: node scripts/expert-route-probe.mjs [--repo <레포 경로>] [--json] -- '<명령>'
 * 종료 코드: 기록 있음 0, 기록 없음 1, 사용법 오류 · 레포 경로 없음 · 훅 실행 실패 2
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const hook = join(dirname(fileURLToPath(import.meta.url)), 'pre-tool-use.mjs');

// 기록 목록을 낸다. 레포 경로가 없거나 훅을 실행하지 못하면 예외를 던진다.
// extraEnv 는 자체 점검이 가짜 HOME 을 줄 때만 쓴다.
export function probe(command, repo, extraEnv = {}) {
  let isDir = false;
  try { isDir = statSync(repo).isDirectory(); } catch { /* 없음 */ }
  if (!isDir) throw new Error(`레포 경로가 없다: ${repo}`);
  const out = mkdtempSync(join(tmpdir(), 'expert-route-probe-'));
  try {
    const transcript = join(out, 'transcript.jsonl');
    writeFileSync(transcript, '');
    const r = spawnSync('node', [hook], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, session_id: 'probe', cwd: repo, transcript_path: transcript }),
      encoding: 'utf8',
      cwd: repo,
      env: {
        ...process.env,
        ...extraEnv,
        OPS_AGENT_EXPERT_ROUTE_DIR: join(out, 'state'),
        OPS_AGENT_EXPERT_ROUTE_DISABLE: '',
        OPS_AGENT_CONFIDENTIAL_DISABLE: '1',
        OPS_AGENT_WHAT_GUARD_DISABLE: '1',
        OPS_AGENT_ACTION_GATE_DISABLE: '1',
        OPS_AGENT_FINAL_CHECK_DISABLE: '1',
        OPS_AGENT_FLOW_ENTRY_DISABLE: '1',
        OPS_AGENT_HAN_GUARD_DISABLE: '1',
        OPS_AGENT_BODY_LINT_DISABLE: '1',
      },
    });
    if (r.error || r.status !== 0) throw new Error(`훅 실행 실패: ${r.error ? r.error.message : `종료 ${r.status}`}`);
    const dir = join(out, 'state', 'metrics');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(f => /^expert-route-\d{4}-\d{2}\.jsonl$/.test(f))
      .flatMap(f => readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)))
      .map(r => ({ surface: r.surface, bodyLines: r.bodyLines ?? null }));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

// 설치본은 링크 경로(~/.claude/ops-agent/current)로 불려 argv 와 import.meta.url 이 다르다.
// 실제 경로로 비교하지 않으면 아무것도 하지 않고 0(기록 있음)으로 끝난다 (#1193)
const isEntry = (() => {
  try { return realpathSync(process.argv[1] || '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isEntry) {
  const args = process.argv.slice(2);
  let repo = process.cwd();
  let json = false;
  let command = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo') repo = resolve(args[++i] || '.');
    else if (args[i] === '--json') json = true;
    else if (args[i] === '--') { command = args.slice(i + 1).join(' '); break; }
  }
  if (!command) {
    console.error("사용: node scripts/expert-route-probe.mjs [--repo <레포 경로>] [--json] -- '<명령>'");
    process.exit(2);
  }
  let recs;
  try { recs = probe(command, repo); } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  if (json) console.log(JSON.stringify(recs));
  else if (!recs.length) console.log('기록 없음');
  else for (const r of recs) console.log(`기록: ${r.surface} · 본문 ${r.bodyLines ?? '모름'}줄`);
  process.exit(recs.length ? 0 : 1);
}
