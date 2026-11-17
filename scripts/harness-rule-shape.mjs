/**
 * 하네스 허용 규칙 형태 대조 (#1082).
 *
 * 게이트가 갈래를 열어도, 명령이 하네스(Claude Code) Bash 허용 규칙과 글자 형태가 다르면 자동 모드
 * 분류기가 다시 판정한다. 같은 강제 푸시가 한 번은 거부되고 한 번은 통과했다. 거부되자 어시스턴트가
 * 명령을 사람에게 넘겼고, 대화창은 개방 명령 말고는 실행하지 않아 사람이 터미널을 따로 열었다.
 * 게이트가 열린 대상 명령을 실행 직전에 규칙과 대조해, 맞지 않으면 훅이 먼저 막고 맞는 형태를 알려 준다.
 *
 * 규칙 일치 방식은 Claude Code 공식 문서(permissions 「Wildcard patterns」 · 「Compound commands」)를 따른다.
 *   - 첫 `*` 앞까지는 글자 그대로 비교한다. `*` 는 공백을 포함한 아무 글자와 맞는다
 *   - 끝의 ` *`(공백 + 별표)는 맨 명령도 맞는다. 공백이 단어 경계라 `--x=1` 은 `--x *` 와 맞지 않는다
 *   - `:*` 끝(옛 형식)은 접두 일치로 읽는다
 *   - 복합 명령은 하위 명령 전부가 허용돼야 한다. 여기서는 게이트 대상 하위 명령만 대조한다
 *
 * 대조하지 않는 경우 (종전 동작):
 *   - 사용자 설정에 Bash 허용 규칙이 하나도 없음 (자동 모드가 아니거나 규칙을 쓰지 않는 환경)
 *   - 대상 하위 명령과 명령 경로(옵션 전까지의 낱말)가 같은 허용 규칙이 없음. 규칙이 없는 갈래는
 *     GATE 3 0단계(규칙 유무 확인)가 맡는다
 */

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Bash 허용 규칙 본문 하나가 명령과 맞는가.
 * @param {string} rule `Bash(...)` 의 괄호 안
 * @param {string} cmd 앞뒤 공백을 걷은 단일 명령
 */
export function bashRuleMatches(rule, cmd) {
  if (rule.endsWith(':*')) {
    const prefix = rule.slice(0, -2);
    return cmd === prefix || cmd.startsWith(prefix + ' ');
  }
  if (!rule.includes('*')) return cmd === rule;
  if (rule.endsWith(' *') && cmd === rule.slice(0, -2)) return true;
  const re = new RegExp('^' + rule.split('*').map(escapeRe).join('.*') + '$', 's');
  return re.test(cmd);
}

/** 옵션(`-` 로 시작) 전까지의 낱말. 규칙과 명령이 같은 하위 명령을 가리키는지 볼 때 쓴다 */
function commandPath(text) {
  const words = [];
  for (const w of text.trim().split(/\s+/)) {
    if (!w || w.startsWith('-') || w.includes('*')) break;
    words.push(w.replace(/:$/, ''));
  }
  return words;
}

/** 규칙의 명령 경로가 하위 명령의 명령 경로 앞부분과 같으면, 그 하위 명령을 위한 규칙이다 */
function ruleCovers(rule, segment) {
  const literal = rule.split('*')[0];
  const head = commandPath(literal);
  const seg = commandPath(segment);
  if (!(head.length > 0 && head.length <= seg.length && head.every((w, i) => w === seg[i]))) return false;
  // 규칙 머리의 옵션(`--force-with-lease`)이 대상 명령에 없으면 다른 행위다. `git push origin main` 은
  // `git push --force-with-lease *` 의 대상이 아니다
  const segWords = segment.trim().split(/\s+/);
  const headOptions = literal.trim().split(/\s+/).filter(w => w.startsWith('-')).map(w => w.replace(/:$/, ''));
  return headOptions.every(o => segWords.some(w => w === o || w.startsWith(o + '=')));
}

/**
 * 게이트가 열린 대상 하위 명령의 형태 판정.
 * 복합 명령 전체가 아니라 게이트 대상 하위 명령만 대조한다. 앞뒤의 `cd` · 환경 설정 · 버전 검사는
 * 게이트 훅의 동거 검사(#386)가 따로 판정한다.
 * 관련 규칙은 명령 경로(옵션 전까지의 낱말)가 하위 명령과 같은 규칙이다. `gh pr view *` 는
 * `gh pr merge` 의 규칙이 아니다. 관련 규칙이 없으면 대조하지 않는다(GATE 3 0단계의 몫).
 * @param {object} p
 * @param {string[]} p.targets 게이트 대상 하위 명령
 * @param {string[]} p.rules 사용자 설정의 Bash 허용 규칙 본문
 * @returns {null | {related: string[], target: string}}
 */
export function harnessShapeMismatch({ targets, rules }) {
  if (!rules.length) return null;
  for (const segment of targets) {
    const cmd = segment.trim();
    const related = rules.filter(r => ruleCovers(r, cmd));
    if (!related.length) continue;
    if (!rules.some(r => bashRuleMatches(r, cmd))) return { related, target: cmd };
  }
  return null;
}

/** 사용자 · 레포 설정 파일들에서 Bash 허용 규칙 본문을 모은다 */
export function bashAllowRulesFrom(settingsObjects) {
  const rules = [];
  for (const d of settingsObjects) {
    for (const r of d?.permissions?.allow || []) {
      const m = /^Bash\((.*)\)$/s.exec(r);
      if (m) rules.push(m[1]);
    }
  }
  return rules;
}
