/**
 * commit-scope.mjs — 셸 명령 글자에서 「이 커밋에 무엇이 담기는가」를 읽는다.
 *
 * 전문가 경유 지표(commit-md)가 쓴다 (pre-tool-use.mjs).
 * 낱말로만 나누면 리다이렉션(`2>&1` · `> f`) · 히어닥 · 파이프 · 명령 대체(`$(…)`) · `$'…'` · 붙여 쓴 값(`-m"a b"`)을
 * 경로 지정으로 잘못 읽어 범위가 엉뚱한 경로가 되고, 담긴 md 를 세지 못한다.
 * 대외비 커밋 검사는 이 해석을 쓰지 않는다(강화는 #1161).
 * 그래서 셸 인용 · 명령 대체 · 히어닥 · 리다이렉션을 따라 단순 명령 단위 낱말로 읽은 뒤 커밋 인자를 해석한다.
 *
 * 범위(scope): { rev: '--cached' | 'HEAD' | 'untracked', paths: [] }
 *   --cached   스테이징분
 *   HEAD       HEAD 대비 추적 파일(paths 가 있으면 그 경로)
 *   untracked  추적하지 않는 파일(같은 명령 앞의 `git add` 가 담을 수 있다)
 */

// git 과 서브커맨드 사이 전역 옵션 중 값을 다음 낱말로 받는 것
const GIT_GLOBAL_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--super-prefix']);
// git commit 인자 중 값을 받는 것 (git-commit(1)). `=` 로 붙이거나 다음 낱말로 받는다
const COMMIT_VALUE_LONG = new Set(['message', 'file', 'author', 'date', 'template', 'reuse-message', 'reedit-message',
  'fixup', 'squash', 'cleanup', 'trailer', 'pathspec-from-file']);
// 값을 붙여서만 받는 긴 옵션(다음 낱말은 값이 아니다)
const COMMIT_OPTIONAL_LONG = new Set(['untracked-files', 'gpg-sign']);
// 값을 받지 않는 긴 옵션 (git-commit(1)). 여기에도 위에도 없는 긴 옵션(줄여 쓴 이름 · 새 옵션)은 다음 낱말이 값인지 경로인지 모른다
const COMMIT_FLAG_LONG = new Set(['all', 'include', 'only', 'patch', 'interactive', 'amend', 'no-edit', 'edit', 'reset-author',
  'short', 'branch', 'porcelain', 'long', 'null', 'signoff', 'no-signoff', 'verify', 'no-verify', 'allow-empty', 'allow-empty-message',
  'no-post-rewrite', 'dry-run', 'status', 'no-status', 'no-gpg-sign', 'quiet', 'verbose', 'pathspec-file-nul']);
// 다른 셸에 글자로 명령을 넘기는 것. `bash -c '…'` · `eval '…'` 안의 명령도 이 명령의 일이다
const SHELL_NAMES = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
// git add 경로가 파일 하나를 가리킨다고 볼 수 있는 꼴: 글롭 · 디렉토리 꼴이 아니고 이름에 확장자가 있다
const isLiteralFile = p => !/^[:!]|[*?[\]]|\/$/.test(p) && /^[^.][^/]*\.[^./]+$/.test(p.replace(/^.*\//, ''));
// 값을 받는 짧은 옵션. 같은 낱말 안에서 뒤 글자가 있으면 그것이 값이다(`-m"a b"` · `-mfix`)
const COMMIT_VALUE_SHORT = new Set(['m', 'F', 'c', 'C', 't']);
// 값을 붙여서만 받는 짧은 옵션
const COMMIT_ATTACHED_SHORT = new Set(['S', 'u']);
// 명령 앞에 붙어 다음 낱말이 실제 명령인 것
const COMMAND_PREFIX = new Set(['sudo', 'env', 'command', 'exec', 'time', 'nohup']);

/**
 * 셸 명령을 단순 명령 목록으로 읽는다. 각 명령은 { start, words: [{ text, dynamic }] } 다.
 * dynamic 은 낱말에 명령 대체 · 변수가 있어 글자로 값을 알 수 없다는 뜻이다.
 * 리다이렉션 대상 · 히어닥 본문은 낱말에 넣지 않는다. 명령 대체 안의 명령은 바깥 명령보다 앞에 넣는다(먼저 실행된다).
 * 인용이 닫히지 않는 등 읽지 못하면 null.
 */
export function shellSimpleCommands(src) {
  const r = lex(src, 0, false);
  return r ? r.cmds : null;
}

function lex(src, start, inSubst) {
  const cmds = [];
  let words = [];
  let cmdStart = start;
  let word = null;
  let redirect = null; // 'target' | 'heredoc' | null
  const heredocs = [];
  // 명령 대체 안의 명령. 바깥 명령보다 먼저 실행되므로 바깥 명령을 넣기 전에 목록에 넣는다
  const inner = [];
  let depth = 0;
  let i = start;
  const n = src.length;
  const begin = () => {
    if (!word) {
      word = { text: '', dynamic: false, quoted: false, at: i };
    }
  };
  const endWord = () => {
    if (!word) return;
    if (redirect === 'heredoc') {
      heredocs.push({ delim: word.text, strip: word.strip });
      redirect = null;
    } else if (redirect === 'target') {
      redirect = null;
    } else {
      if (!words.length) cmdStart = word.at;
      words.push({ text: word.text, dynamic: word.dynamic });
    }
    word = null;
  };
  const endCommand = () => {
    endWord();
    cmds.push(...inner);
    inner.length = 0;
    if (words.length) cmds.push({ start: cmdStart, words });
    words = [];
  };
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t') { endWord(); i++; continue; }
    if (c === '\n') {
      endCommand();
      i++;
      // 히어닥 본문: 구분자 줄까지 건너뛴다
      while (heredocs.length) {
        const h = heredocs.shift();
        for (;;) {
          if (i >= n) return null;
          let e = src.indexOf('\n', i);
          if (e < 0) e = n;
          let lineText = src.slice(i, e);
          if (h.strip) lineText = lineText.replace(/^\t+/, '');
          i = e + 1;
          if (lineText === h.delim) break;
        }
      }
      continue;
    }
    if (c === '#' && !word) {
      const e = src.indexOf('\n', i);
      i = e < 0 ? n : e;
      continue;
    }
    if (c === ';' || c === '|' || c === '&' || c === '(' || c === ')') {
      if (c === '&' && src[i + 1] === '>') { // &> 대상
        endWord();
        i += src[i + 2] === '>' ? 3 : 2;
        redirect = 'target';
        continue;
      }
      endCommand();
      if (c === '(') { depth++; i++; continue; }
      if (c === ')') {
        if (depth > 0) { depth--; i++; continue; }
        if (inSubst) return { cmds, end: i + 1 };
        i++;
        continue;
      }
      i += (c === '|' || c === '&') && src[i + 1] === c ? 2 : 1;
      if (c === ';' && src[i] === ';') i++;
      continue;
    }
    if (c === '<' || c === '>') {
      // `2>` 의 2 는 낱말이 아니라 파일 서술자다
      if (word && !word.quoted && !word.dynamic && /^\d+$/.test(word.text)) word = null;
      else endWord();
      let op = c;
      i++;
      while (i < n && /[<>&|-]/.test(src[i]) && op.length < 3) {
        if (src[i] === '-' && op !== '<<') break;
        op += src[i];
        i++;
      }
      if (/[>&]&$/.test(op) || op.endsWith('&')) {
        // >&1 · <&- 같은 서술자 복제: 대상 낱말이 서술자다
        if (/[\d-]/.test(src[i] || '')) { while (i < n && /[\d-]/.test(src[i])) i++; continue; }
      }
      if (op === '<<' || op === '<<-') {
        redirect = 'heredoc';
        begin();
        word.strip = op === '<<-';
        continue;
      }
      redirect = 'target';
      continue;
    }
    if (c === '\\') {
      if (src[i + 1] === '\n') { i += 2; continue; }
      begin();
      word.text += src[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (c === "'") {
      begin();
      const e = src.indexOf("'", i + 1);
      if (e < 0) return null;
      word.text += src.slice(i + 1, e);
      word.quoted = true;
      i = e + 1;
      continue;
    }
    if (c === '$' && src[i + 1] === "'") {
      begin();
      let j = i + 2;
      let text = '';
      while (j < n && src[j] !== "'") {
        if (src[j] === '\\' && j + 1 < n) { text += src[j + 1] === 'n' ? '\n' : src[j + 1]; j += 2; continue; }
        text += src[j];
        j++;
      }
      if (j >= n) return null;
      word.text += text;
      word.quoted = true;
      i = j + 1;
      continue;
    }
    if (c === '$' && src[i + 1] === '(') {
      begin();
      word.dynamic = true;
      const sub = lex(src, i + 2, true);
      if (!sub) return null;
      inner.push(...sub.cmds);
      i = sub.end;
      continue;
    }
    if (c === '$' && /[{A-Za-z0-9_@*#?$!-]/.test(src[i + 1] || '')) {
      begin();
      word.dynamic = true;
      if (src[i + 1] === '{') {
        const e = src.indexOf('}', i + 2);
        if (e < 0) return null;
        i = e + 1;
      } else if (/[A-Za-z_]/.test(src[i + 1])) {
        i++;
        while (i < n && /[A-Za-z0-9_]/.test(src[i])) i++;
      } else {
        i += 2;
      }
      continue;
    }
    if (c === '`') {
      begin();
      word.dynamic = true;
      let j = i + 1;
      while (j < n && src[j] !== '`') j += src[j] === '\\' ? 2 : 1;
      if (j >= n) return null;
      i = j + 1;
      continue;
    }
    if (c === '"') {
      begin();
      word.quoted = true;
      let j = i + 1;
      for (;;) {
        if (j >= n) return null;
        const d = src[j];
        if (d === '"') { j++; break; }
        if (d === '\\' && j + 1 < n) { word.text += src[j + 1]; j += 2; continue; }
        if (d === '$' && src[j + 1] === '(') {
          word.dynamic = true;
          const sub = lex(src, j + 2, true);
          if (!sub) return null;
          inner.push(...sub.cmds);
          j = sub.end;
          continue;
        }
        if (d === '`') {
          word.dynamic = true;
          let k = j + 1;
          while (k < n && src[k] !== '`') k += src[k] === '\\' ? 2 : 1;
          if (k >= n) return null;
          j = k + 1;
          continue;
        }
        if (d === '$' && /[{A-Za-z0-9_@*#?$!-]/.test(src[j + 1] || '')) { word.dynamic = true; j++; continue; }
        word.text += d;
        j++;
      }
      i = j;
      continue;
    }
    begin();
    word.text += c;
    i++;
  }
  if (inSubst) return null;
  endCommand();
  return { cmds, end: n };
}

function stripPrefix(words) {
  let k = 0;
  for (;;) {
    while (k < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k].text)) k++;
    if (k < words.length && COMMAND_PREFIX.has(words[k].text)) {
      k++;
      while (k < words.length && words[k].text.startsWith('-')) k++;
      continue;
    }
    break;
  }
  return words.slice(k);
}

/**
 * 커밋 인자(commit 뒤 낱말)를 읽어 담길 범위를 낸다.
 * 인자대로의 범위를 내고, 글자로 범위를 확정하지 못하면(값을 모르는 경로 · pathspec 파일 · 앞선 git add) 넉넉한 범위를 낸다.
 */
export function commitArgsScope(args, added) {
  const add = addState(added);
  const sawAdd = add.broad || add.paths.length > 0;
  let all = false;
  let include = false;
  let uncertain = false;
  const paths = [];
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    const t = w.text;
    if (t === '--') {
      for (const p of args.slice(i + 1)) {
        if (p.dynamic) uncertain = true;
        else paths.push(p.text);
      }
      break;
    }
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const name = t.slice(2, eq < 0 ? undefined : eq);
      if (name === 'all') all = true;
      else if (name === 'include') include = true;
      else if (name === 'pathspec-from-file') { uncertain = true; if (eq < 0) i++; }
      else if (COMMIT_VALUE_LONG.has(name) && eq < 0) i++;
      else if (COMMIT_OPTIONAL_LONG.has(name)) { /* 붙여 쓴 값만 받는다 */ }
      else if (!COMMIT_FLAG_LONG.has(name) && eq < 0 && i + 1 < args.length) uncertain = true;
      continue;
    }
    if (t.startsWith('-') && t.length > 1) {
      for (let k = 1; k < t.length; k++) {
        const ch = t[k];
        if (ch === 'a') all = true;
        else if (ch === 'i') include = true;
        else if (COMMIT_ATTACHED_SHORT.has(ch)) break;
        else if (COMMIT_VALUE_SHORT.has(ch)) { if (k === t.length - 1) i++; break; }
      }
      continue;
    }
    if (w.dynamic) { uncertain = true; continue; }
    paths.push(t);
  }
  let precise;
  if (all) precise = [{ rev: 'HEAD', paths: [] }];
  else if (paths.length) precise = include ? [{ rev: '--cached', paths: [] }, { rev: 'HEAD', paths }] : [{ rev: 'HEAD', paths }];
  else precise = [{ rev: '--cached', paths: [] }];
  if (uncertain || add.broad) {
    return { scopes: broadScopes(sawAdd) };
  }
  if (add.paths.length) {
    // 앞선 git add 가 파일 경로만 담으면 그 경로만 더 담긴다. 추적 파일 변경은 HEAD 대비, 새 md 는 추적하지 않는 파일로 본다
    const scopes = [...precise];
    if (!scopes.some(s => s.rev === '--cached' && !s.paths.length)) scopes.push({ rev: '--cached', paths: [] });
    if (!all) scopes.push({ rev: 'HEAD', paths: add.paths });
    const md = add.paths.filter(p => /\.md$/i.test(p));
    if (md.length) scopes.push({ rev: 'untracked', paths: md });
    return { scopes };
  }
  return { scopes: precise };
}

export function broadScopes(withUntracked) {
  const s = [{ rev: '--cached', paths: [] }, { rev: 'HEAD', paths: [] }];
  if (withUntracked) s.push({ rev: 'untracked', paths: [] });
  return s;
}

// 앞선 git add 들이 담는 것. broad 면 무엇을 담는지 글자로 모른다. paths 는 파일 하나씩 가리키는 경로다
function addState(added) {
  if (!added) return { broad: false, paths: [] };
  if (added === true) return { broad: true, paths: [] };
  return added;
}

// git add 인자가 파일 경로만이면 그 경로 목록, 아니면(-A · -u · -p · 디렉토리 · 글롭 · 값을 모르는 경로) null
function addLiteralPaths(args) {
  const paths = [];
  let rest = false;
  for (const w of args) {
    if (w.dynamic) return null;
    const t = w.text;
    if (!rest && t === '--') { rest = true; continue; }
    if (!rest && t.startsWith('-')) {
      if (['-v', '--verbose', '-f', '--force', '-N', '--intent-to-add'].includes(t)) continue;
      return null;
    }
    if (!isLiteralFile(t)) return null;
    paths.push(t.replace(/^\.\//, ''));
  }
  return paths.length ? paths : null;
}

// `bash -c '<글>'` · `eval <글>` 이 실행하는 글. 없거나 글자로 모르면 null
function shellScript(w) {
  const name = w[0] && w[0].text.replace(/^.*\//, '');
  if (name === 'eval') return w.length > 1 && w.slice(1).every(x => !x.dynamic) ? w.slice(1).map(x => x.text).join(' ') : null;
  if (!SHELL_NAMES.has(name)) return null;
  for (let k = 1; k < w.length; k++) {
    const t = w[k].text;
    if (!t.startsWith('-') || t.startsWith('--')) return null;
    if (t.slice(1).includes('c')) return w[k + 1] && !w[k + 1].dynamic ? w[k + 1].text : null;
  }
  return null;
}

// 셸 안쪽(bash -c · eval) 명령을 펼친다. 안쪽 명령의 위치는 감싼 명령의 위치다
function flatten(cmds, depth = 0) {
  const out = [];
  for (const cmd of cmds) {
    const script = depth < 3 ? shellScript(stripPrefix(cmd.words)) : null;
    const inner = script === null ? null : shellSimpleCommands(script);
    if (inner) out.push(...flatten(inner, depth + 1).map(c => ({ ...c, start: cmd.start })));
    else out.push(cmd);
  }
  return out;
}

/**
 * 명령에 든 커밋들. [{ start, scopes }] (명령 순서).
 * 셸로 읽지 못하면 null 이다. 호출자가 넉넉한 범위로 다룬다.
 */
export function analyzeCommits(command) {
  const cmds = shellSimpleCommands(command);
  if (!cmds) return null;
  const commits = [];
  let added = false;
  for (const cmd of flatten(cmds)) {
    const w = stripPrefix(cmd.words);
    if (!w.length || w[0].text.replace(/^.*\//, '') !== 'git') continue;
    let k = 1;
    while (k < w.length && w[k].text.startsWith('-')) {
      const t = w[k].text;
      k += GIT_GLOBAL_VALUE.has(t) ? 2 : 1;
    }
    const sub = w[k] && w[k].text;
    if (sub === 'add' || sub === 'stage') {
      const paths = addLiteralPaths(w.slice(k + 1));
      const prev = addState(added);
      added = paths && !prev.broad ? { broad: false, paths: [...prev.paths, ...paths] } : true;
      continue;
    }
    if (sub !== 'commit') continue;
    commits.push({ start: cmd.start, ...commitArgsScope(w.slice(k + 1), added) });
  }
  return commits;
}
