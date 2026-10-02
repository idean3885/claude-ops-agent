/**
 * build-guard-rules.mjs — 모듈 빌드 스크립트에 라이브러리 좌표가 더해지는 편집을 찾는다.
 *
 * 레포가 빌드 설정을 계층 스크립트(`gradle/*.gradle`)로 묶어 두면, 모듈 `build.gradle` 에는
 * 계층 적용과 모듈 간 의존만 남는다. 라이브러리 한 줄을 모듈에 직접 더하면 그 모듈만
 * 다른 버전·다른 구성으로 갈라지고, 번들을 고칠 때 그 모듈이 빠진다. 실측에서 이미
 * 번들이 올리는 라이브러리를 모듈에 중복 선언한 채 리뷰까지 갔다 (#574).
 *
 * 판정은 순수 함수다. 파일 시스템은 호출자가 읽어 넘긴다.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';

const BUILD_SCRIPT = /^build\.gradle(?:\.kts)?$/;
const SETTINGS = ['settings.gradle', 'settings.gradle.kts'];
const DEP_CONFIG = String.raw`(?:implementation|api|compileOnly|compileOnlyApi|runtimeOnly|testImplementation|testCompileOnly|testRuntimeOnly|annotationProcessor|testAnnotationProcessor|kapt|ksp|developmentOnly)`;
// 문자열 좌표 "group:artifact[:version]" 만 본다. project(':x') 와 platform(...) 은 모듈 간 의존이라 통과.
// 설정 이름과 좌표 사이의 공백에 개행이 들어가도 잡는다. Kotlin DSL 은 괄호 안 줄바꿈을 허용한다.
const LIB_COORD = new RegExp(String.raw`^[ \t]*${DEP_CONFIG}\s*\(?\s*["'][^"'\s]+:[^"'\s]+["']`, 'gm');

/** 가장 가까운 settings.gradle 이 있는 디렉토리. 없으면 null. */
export function findGradleRoot(startDir) {
  let dir = resolve(startDir);
  for (let i = 0; i < 12; i++) {
    if (SETTINGS.some(s => existsSync(join(dir, s)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 레포가 계층 스크립트 번들을 쓰는가 — `<root>/gradle/` 아래 `.gradle` 파일이 하나라도 있으면 그렇다. */
export function usesBundles(root) {
  const dir = join(root, 'gradle');
  if (!existsSync(dir)) return false;
  const walk = (d, depth) => {
    if (depth > 2) return false;
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory() && walk(p, depth + 1)) return true;
      if (st.isFile() && name.endsWith('.gradle')) return true;
    }
    return false;
  };
  return walk(dir, 0);
}

/** 모듈 빌드 스크립트인가 — 루트 build.gradle 과 `gradle/` 아래 번들은 제외한다. */
export function isModuleBuildScript(filePath, root) {
  if (!BUILD_SCRIPT.test(basename(filePath))) return false;
  const abs = resolve(filePath);
  if (dirname(abs) === resolve(root)) return false;
  return !abs.startsWith(resolve(root, 'gradle') + '/');
}

/** 전체 본문의 라이브러리 좌표 선언. 선언이 여러 줄에 걸치면 그 전체를 하나로 돌려준다. */
export function findLibraryCoordinates(lines) {
  const text = lines.join('\n');
  return [...text.matchAll(LIB_COORD)].map(m => m[0].replace(/\s+/g, ' ').trim());
}

/**
 * 편집 하나를 판정한다.
 * @param {{filePath:string, oldText:string, newText:string}} change
 * @returns {{blocked:boolean, hits:string[], root:string|null}}
 */
export function scanBuildScriptChange(change) {
  const root = findGradleRoot(dirname(resolve(change.filePath)));
  if (!root) return { blocked: false, hits: [], root: null };
  if (!isModuleBuildScript(change.filePath, root)) return { blocked: false, hits: [], root };
  if (!usesBundles(root)) return { blocked: false, hits: [], root };
  const before = new Set(findLibraryCoordinates((change.oldText || '').split('\n')));
  const hits = findLibraryCoordinates((change.newText || '').split('\n')).filter(hit => !before.has(hit));
  return { blocked: hits.length > 0, hits, root };
}

/** 편집 하나를 본문에 적용한다. old_string 이 비면 새 파일이거나 덧붙임이라 그대로 더한다. */
function applyEdit(text, edit) {
  const from = edit.old_string || '';
  const to = edit.new_string || '';
  if (!from) return text + to;
  return edit.replace_all ? text.split(from).join(to) : text.replace(from, () => to);
}

/**
 * 도구 입력(Write · Edit · MultiEdit)을 편집 목록으로 편다.
 * 빌드 스크립트일 때만 디스크를 읽는다. 모든 편집에서 대상 파일을 읽으면 가드와 무관한 편집에 IO 가 붙는다.
 * Edit 는 교체 문자열이 줄 단위가 아니라, 파일에 교체를 적용한 전체 본문을 전후로 비교한다.
 */
export function changesOf(toolName, toolInput, readFile = p => (existsSync(p) ? readFileSync(p, 'utf8') : '')) {
  const filePath = toolInput && toolInput.file_path;
  if (!filePath || !BUILD_SCRIPT.test(basename(filePath))) return [];
  const oldText = readFile(filePath);
  let newText;
  if (toolName === 'Write') newText = toolInput.content || '';
  else if (toolName === 'Edit') newText = applyEdit(oldText, toolInput);
  else if (toolName === 'MultiEdit') newText = (toolInput.edits || []).reduce(applyEdit, oldText);
  else return [];
  return [{ filePath, oldText, newText }];
}
