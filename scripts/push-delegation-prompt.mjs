#!/usr/bin/env node
/**
 * push-delegation-prompt.mjs — UserPromptSubmit 훅: 「푸시 권한 위임」 입력을 받아 세션 위임을 연다 (#1046).
 *
 * 메시지 전체가 호출 문장일 때만 동작한다. 판정과 기록 형식은 push-delegation.mjs 에 있다.
 * 선언이 없는 레포면 열지 않고, 사람이 할 선언 한 줄을 알린다.
 * 입력: stdin 의 hook JSON (`prompt` · `session_id` · `cwd`). 출력: 컨텍스트에 더할 한 줄.
 */
import { DELEGATION_PHRASE, isDelegationPrompt, recordDelegation, repoRootOf } from './push-delegation.mjs';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  let h;
  try { h = JSON.parse(input); } catch { process.exit(0); }
  if (!isDelegationPrompt(h.prompt)) process.exit(0);
  const root = repoRootOf(h.cwd || process.cwd());
  const rec = recordDelegation(h.session_id, root);
  if (rec) {
    process.stdout.write(
      `[푸시 권한 위임] 열림: 이 세션 · ${root} · 기본 브랜치 push. 세션이 끝나거나 8시간 뒤 닫힌다.\n`
      + `force push · 원격 브랜치 삭제 · reset --hard 등 다른 갈래는 계속 막힌다. 사람에게 열린 범위를 한 줄로 알린다.\n`);
  } else {
    process.stdout.write(
      `[푸시 권한 위임] 열지 않음: ${root || '레포 밖'} 은 위임을 선언하지 않았다. 「${DELEGATION_PHRASE}」은 선언한 레포에서만 연다.\n`
      + `선언은 사람이 한다 (.ops-agent/repo-type.json 에 "allow": ["git-default-push"]). 사람에게 이 사실만 알린다.\n`);
  }
  process.exit(0);
});
