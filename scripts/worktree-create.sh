#!/bin/bash
# org-flow: clone-on-demand + 워크트리 일괄 생성 + vcs.xml 매핑
#
# 리모트 원소스 전략: 로컬에 베이스 브랜치 디렉토리를 두지 않는다.
# 레포가 없으면 bare clone → worktree 생성. 정리 시 bare clone도 삭제.
#
# 사용법: ./worktree-create.sh <state-file>
#   state-file: .omc/state/org-flow-{ticket}.json
#
# 입력 JSON 구조 (필수 필드):
#   ticket, primaryRepo, repos.{name}.{branch, base, worktree}
#
# 출력: JSON (status, created[], failed[], worktrees[])

set -euo pipefail

# 프로젝트 루트 감지: .devex/project.json이 있는 상위 디렉토리
find_project_root() {
  local dir="$1"
  while [ "$dir" != "/" ]; do
    [ -f "$dir/.devex/project.json" ] && echo "$dir" && return
    dir="$(dirname "$dir")"
  done
  echo ""
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(find_project_root "$SCRIPT_DIR")"
if [ -z "$PROJECT_ROOT" ]; then
  echo '{"status": "error", "message": ".devex/project.json을 찾을 수 없음"}' >&2
  exit 1
fi

VCS_XML="$PROJECT_ROOT/.idea/vcs.xml"
MANIFEST="$PROJECT_ROOT/.devex/project.json"
STATE_FILE="${1:?state-file 경로 필수}"

if [ ! -f "$STATE_FILE" ]; then
  echo "{\"status\": \"error\", \"message\": \"상태 파일 없음: $STATE_FILE\"}" >&2
  exit 1
fi

RESULT=$(python3 << PYEOF
import json, subprocess, os, sys

project_root = "$PROJECT_ROOT"
vcs_xml = "$VCS_XML"
manifest_path = "$MANIFEST"

with open("$STATE_FILE") as f:
    state = json.load(f)

with open(manifest_path) as f:
    manifest = json.load(f)

ticket = state["ticket"]
primary_repo = state["primaryRepo"]

# repos: 상태 파일 우선, 없으면 매니페스트에서 도메인으로 조회
if "repos" in state and state["repos"]:
    repos = state["repos"]
else:
    domain = state.get("domain", "")
    repo_names = manifest.get("domains", {}).get(domain, [])
    if not repo_names:
        print(json.dumps({"status": "error", "message": f"매니페스트에 도메인 {domain} 없음"}))
        sys.exit(1)
    wt_root = manifest.get("worktreeRoot", "worktrees")
    repos = {}
    for name in repo_names:
        repo_cfg = manifest["repos"].get(name, {})
        branch = f"feature/{ticket}"
        repos[name] = {
            "branch": branch,
            "base": repo_cfg.get("base", "main"),
            "worktree": f"{wt_root}/{name}/feature-{ticket}"
        }
    state["repos"] = repos
    with open("$STATE_FILE", "w") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)

created = []
failed = []
worktrees = []


def resolve_git_dir(repo_name):
    """레포의 git 디렉토리를 찾는다. bare(.git/) 또는 일반 모두 지원."""
    bare_dir = os.path.join(project_root, f"{repo_name}.git")
    normal_dir = os.path.join(project_root, repo_name)
    if os.path.isdir(bare_dir):
        return bare_dir
    if os.path.isdir(normal_dir):
        return normal_dir
    return None


def clone_bare(repo_name):
    """매니페스트에서 remote URL을 읽어 bare clone한다."""
    repo_cfg = manifest["repos"].get(repo_name, {})
    remote_url = repo_cfg.get("remote")
    if not remote_url:
        return None, f"매니페스트에 remote URL 없음: {repo_name}"
    bare_dir = os.path.join(project_root, f"{repo_name}.git")
    r = subprocess.run(
        ["git", "clone", "--bare", remote_url, bare_dir],
        capture_output=True, text=True
    )
    if r.returncode != 0:
        return None, f"bare clone 실패: {r.stderr.strip()}"
    return bare_dir, None


for repo_name, repo_info in repos.items():
    branch = repo_info["branch"]
    base = repo_info["base"]
    worktree_rel = repo_info["worktree"]
    worktree_abs = os.path.join(project_root, worktree_rel)

    if os.path.exists(worktree_abs):
        created.append({"repo": repo_name, "status": "exists"})
        worktrees.append(worktree_abs)
        continue

    git_dir = resolve_git_dir(repo_name)
    if git_dir is None:
        git_dir, err = clone_bare(repo_name)
        if err:
            failed.append({"repo": repo_name, "error": err})
            continue

    try:
        subprocess.run(["git", "fetch", "origin"], cwd=git_dir, capture_output=True, check=True)

        if repo_name == primary_repo:
            r_check = subprocess.run(
                ["git", "branch", "--list", branch],
                cwd=git_dir, capture_output=True, text=True
            )
            if r_check.stdout.strip():
                r = subprocess.run(
                    ["git", "worktree", "add", worktree_abs, branch],
                    cwd=git_dir, capture_output=True, text=True
                )
            else:
                r = subprocess.run(
                    ["git", "worktree", "add", worktree_abs, "-b", branch, f"origin/{base}"],
                    cwd=git_dir, capture_output=True, text=True
                )
        else:
            r = subprocess.run(
                ["git", "worktree", "add", worktree_abs, "-b", branch, f"origin/{base}"],
                cwd=git_dir, capture_output=True, text=True
            )

        if r.returncode == 0:
            created.append({"repo": repo_name, "status": "created"})
            worktrees.append(worktree_abs)
        else:
            failed.append({"repo": repo_name, "error": r.stderr.strip()})
    except subprocess.CalledProcessError as e:
        failed.append({"repo": repo_name, "error": str(e)})

# --- vcs.xml 매핑 추가 ---
vcs_added = 0
if os.path.isfile(vcs_xml):
    with open(vcs_xml) as f:
        vcs_content = f.read()

    for wt in worktrees:
        wt_rel = os.path.relpath(wt, project_root)
        mapping = f'    <mapping directory="\$PROJECT_DIR\$/{wt_rel}" vcs="Git" />'
        if wt_rel not in vcs_content:
            vcs_content = vcs_content.replace(
                "</component>",
                f"{mapping}\n  </component>"
            )
            vcs_added += 1

    with open(vcs_xml, "w") as f:
        f.write(vcs_content)

# --- 불변식 검증 ---
violations = []
for repo_name, repo_info in repos.items():
    worktree_abs = os.path.join(project_root, repo_info["worktree"])
    if not os.path.exists(worktree_abs) and repo_name not in [f["repo"] for f in failed]:
        violations.append(f"워크트리 미존재: {repo_info['worktree']}")

result = {
    "status": "error" if violations or failed else "ok",
    "created": created,
    "failed": failed,
    "vcs_mappings_added": vcs_added,
    "violations": violations,
}
print(json.dumps(result, ensure_ascii=False))
PYEOF
)

echo "$RESULT"
echo "$RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(1 if d['status']=='error' else 0)"
