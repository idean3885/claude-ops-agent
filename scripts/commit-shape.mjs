/**
 * commit-shape.mjs — 공개 레포 대외비 커밋 검사 앞의 「커밋 모양 게이트」 판정 (#1161).
 *
 * 대외비 커밋 검사는 스테이징분(-a 면 HEAD 대비)을 커밋 전에 읽는다. 같은 명령의 add · 경로 지정 ·
 * cd · git -C 처럼 명령이 실행되며 범위가 바뀌는 모양은 검사가 본 diff 와 실제 커밋이 다르다.
 * 그래서 모양을 해석해 따라가지 않고, 검사가 정확한 모양 하나(단독 커밋 호출)만 들인다(화이트리스트).
 */

const GIT_THEN_COMMIT = /(?:^|[^\w.-])git(?:\s+-\S+(?:\s+[^\s-]\S*)?)*\s+commit(?![\w-])/;
const EXECUTOR_RE = /(?:^|[^\w.-])(?:sh|bash|zsh|dash|ksh|fish|eval|source|exec|xargs|ssh|env|sudo|python3?|node|perl|ruby)(?![\w.-])|`|(?:^|[\s;&|(])\.\s/;
const QUOTED_HEREDOC_HEAD_RE = /<<-?[ \t]*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|\\([A-Za-z_][A-Za-z0-9_]*))[^\n]*\n/g;

// 인용 구분자(<<'EOF' · <<"EOF" · <<\EOF) 히어닥의 본문만 지운다. 셸이 그 본문을 펼치지 않는다.
// 비인용 구분자(<<EOF · <<-EOF) 본문은 $(…) · 백틱이 실행되므로 남겨 둔다.
function stripQuotedHeredocBodies(command) {
  let out = '';
  let from = 0;
  QUOTED_HEREDOC_HEAD_RE.lastIndex = 0;
  // why: 히어스트링(<<<'X')과 따옴표 안의 「<<'X'」 글자는 히어닥이 아니다. 머리로 읽으면 뒤 줄의 실행되는 명령까지 지운다 (#1188)
  //      명령 대체 $( 는 큰따옴표 안에서도 새 인용 문맥을 연다. "$(cat <<'EOF' … )" 의 머리는 실제 히어닥이다
  let q = null;
  let pos = 0;
  let depth = 0;
  const stack = [];
  const advance = to => {
    for (; pos < to; pos++) {
      const c = command[pos];
      if (q === "'") { if (c === "'") q = null; continue; }
      if (c === '\\') { pos++; continue; }
      if (c === '$' && command[pos + 1] === '(') { stack.push({ q, depth }); q = null; depth = 0; pos++; continue; }
      if (q === '"') { if (c === '"') q = null; continue; }
      if (c === '(') { depth++; continue; }
      if (c === ')') {
        if (depth > 0) depth--;
        else if (stack.length) ({ q, depth } = stack.pop());
        continue;
      }
      if (c === "'" || c === '"') q = c;
    }
  };
  let m;
  while ((m = QUOTED_HEREDOC_HEAD_RE.exec(command))) {
    advance(m.index);
    if (q !== null || command[m.index - 1] === '<') { QUOTED_HEREDOC_HEAD_RE.lastIndex = m.index + 2; continue; }
    const name = m[1] || m[2] || m[3];
    const bodyStart = m.index + m[0].length;
    const end = new RegExp(`(?:^|\\n)[ \\t]*${name}(?=\\s|\\)|$)`, 'g');
    end.lastIndex = bodyStart - 1;
    const e = end.exec(command);
    if (!e) break;
    out += command.slice(from, bodyStart);
    from = e.index;
    pos = e.index;
    q = null;
    QUOTED_HEREDOC_HEAD_RE.lastIndex = e.index + e[0].length;
  }
  return out + command.slice(from);
}

// 따옴표 안 · 인용 구분자 히어닥 본문의 글자를 지운다. 이 글자가 실행될 수 있는 모양(셸 · eval · 백틱 등)이면 null.
// 닫히지 않은 따옴표도 null 이다. 지운 자리 뒤의 명령을 가릴 수 있다.
function stripLiteralData(command) {
  const s = stripQuotedHeredocBodies(command);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { out += s.slice(i, i + 2); i++; continue; }
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return null;
      out += "''";
      i = end;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      if (j >= s.length) return null;
      const inner = s.slice(i + 1, j);
      out += inner.includes('$(') ? `"${inner}"` : '""';
      i = j;
      continue;
    }
    out += c;
  }
  return EXECUTOR_RE.test(out) ? null : out;
}

/** 명령에 커밋이 있는가. 넓게 본다. 따옴표 안 글자만 커밋처럼 보이는 경우만 뺀다. */
export function hasCommitInvocation(command, knownCommitRe) {
  const raw = (knownCommitRe && knownCommitRe.test(command)) || GIT_THEN_COMMIT.test(command);
  if (!raw) return false;
  const data = stripLiteralData(command);
  return data === null || GIT_THEN_COMMIT.test(data) || (knownCommitRe ? knownCommitRe.test(data) : false);
}

const SAFE_WORD = /^[A-Za-z0-9._:\/@+,=%~^-]+/;
const STANDARD_MESSAGE = /^"\$\(cat <<'([A-Za-z_][A-Za-z0-9_]*)'\n[\s\S]*?\n\1\n\)"/;

// 따옴표 문자열 · 표준 히어닥 메시지 · 셸 의미가 없는 낱말 하나. 길이를 돌려준다. 아니면 0.
function valueLength(rest) {
  const std = rest.match(STANDARD_MESSAGE);
  if (std) return std[0].length;
  if (rest[0] === "'") {
    const end = rest.indexOf("'", 1);
    return end < 0 ? 0 : end + 1;
  }
  if (rest[0] === '"') {
    let j = 1;
    while (j < rest.length && rest[j] !== '"') {
      if (rest[j] === '$' || rest[j] === '`') return 0;
      j += rest[j] === '\\' ? 2 : 1;
    }
    return j >= rest.length ? 0 : j + 1;
  }
  const w = rest.match(SAFE_WORD);
  return w && !w[0].startsWith('-') ? w[0].length : 0;
}

const FLAGS = new Set(['-q', '--quiet', '-s', '--signoff', '-a', '--all', '--amend', '--no-edit',
  '-S', '--gpg-sign', '--allow-empty']);
const BOUNDARY = /^(?:\s|$)/;

/**
 * 명령 전체가 단독 커밋 호출 하나인가. `git commit` + 허용 옵션뿐이어야 한다.
 * 허용: -m/--message 값, -F/--file 경로 또는 `-` + 따옴표 구분자 히어닥(명령 끝), -q -s -a --amend --no-edit
 * -S[키]/--gpg-sign[=키] --allow-empty, -a · -q · -s 묶음(끝에 m · F 하나).
 */
export function isStandaloneCommit(command) {
  let rest = command.replace(/^[ \t]+/, '').replace(/\s+$/, '');
  if (!/^git commit(?:\s|$)/.test(rest)) return false;
  rest = rest.slice('git commit'.length);
  let stdinHeredoc = false;
  while (rest.length) {
    const ws = rest.match(/^[ \t]+/);
    if (!ws) return false;
    rest = rest.slice(ws[0].length);
    if (!rest.length) break;
    const hd = rest.match(/^<<'([A-Za-z_][A-Za-z0-9_]*)'[ \t]*\n([\s\S]*?)\n\1$/);
    if (hd) {
      if (!stdinHeredoc) return false;
      if (hd[2].split('\n').includes(hd[1])) return false;
      rest = '';
      break;
    }
    const tok = rest.match(/^\S+/)[0];
    let valueOpt = null;
    let attached = '';
    let m;
    if ((m = tok.match(/^-[aqs]*([mF])(.*)$/s)) && tok.length >= 2) { valueOpt = m[1]; attached = m[2]; }
    else if ((m = tok.match(/^--(message|file)(=.*)?$/s))) { valueOpt = m[1] === 'message' ? 'm' : 'F'; attached = m[2] ? m[2].slice(1) : ''; }
    if (valueOpt) {
      const head = tok.length - attached.length;
      const afterOpt = rest.slice(head);
      let valueStart;
      if (attached.length) valueStart = afterOpt;
      else {
        const sp = afterOpt.match(/^[ \t]+/);
        if (!sp) return false;
        valueStart = afterOpt.slice(sp[0].length);
      }
      if (valueOpt === 'F' && /^-(?:\s|$)/.test(valueStart)) {
        stdinHeredoc = true;
        rest = valueStart.slice(1);
        continue;
      }
      const len = valueLength(valueStart);
      if (!len) return false;
      rest = valueStart.slice(len);
      if (!BOUNDARY.test(rest)) return false;
      continue;
    }
    if (FLAGS.has(tok) || /^-[aqs]+$/.test(tok) || /^-S[A-Za-z0-9]+$/.test(tok) || /^--gpg-sign=[A-Za-z0-9]+$/.test(tok)) {
      rest = rest.slice(tok.length);
      continue;
    }
    return false;
  }
  return !stdinHeredoc || /<<'/.test(command);
}
