#!/bin/bash
# org-flow: 워크트리 제거 + bare clone 정리 + vcs.xml 정리 + 상태 파일 삭제
#
# 리모트 원소스 전략: 워크트리 제거 후 해당 레포에 다른 활성 워크트리가 없으면
# bare clone도 삭제한다. 로컬에 레포 흔적을 남기지 않는다.
#
# 사용법: ./worktree-cleanup.sh <state-file>
#   state-file: .omc/state/org-flow-{ticket}.json
#
# 출력: JSON (status, removed[], failed[], state_deleted)

set -euo pipefail

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
STATE_FILE="${1:?state-file 경로 필수}"

if [ ! -f "$STATE_FILE" ]; then
  echo "{\"status\": \"error\", \"message\": \"상태 파일 없음: $STATE_FILE\"}" >&2
  exit 1
fi

RESULT=$(python3 << PYEOF
import json, subprocess, os, sys, shutil

project_root = "$PROJECT_ROOT"
vcs_xml = "$VCS_XML"
state_file = "$STATE_FILE"

with open(state_file) as f:
    state = json.load(f)

ticket = state["ticket"]
repos = state["repos"]

removed = []
failed = []


def resolve_git_dir(repo_name):
    """레포의 git 디렉토리를 찾는다. bare(.git/) 또는 일반 모두 지원."""
    bare_dir = os.path.join(project_root, f"{repo_name}.git")
    normal_dir = os.path.join(project_root, repo_name)
    if os.path.isdir(bare_dir):
        return bare_dir
    if os.path.isdir(normal_dir):
        return normal_dir
    return None


for repo_name, repo_info in repos.items():
    branch = repo_info["branch"]
    worktree_rel = repo_info["worktree"]
    worktree_abs = os.path.join(project_root, worktree_rel)

    git_dir = resolve_git_dir(repo_name)

    # 1. 워크트리 제거
    if os.path.exists(worktree_abs) and git_dir:
        try:
            subprocess.run(
                ["git", "worktree", "remove", worktree_abs, "--force"],
                cwd=git_dir, capture_output=True, text=True
            )
        except Exception:
            pass

        if os.path.exists(worktree_abs):
            shutil.rmtree(worktree_abs, ignore_errors=True)

    # 2. 로컬 브랜치 삭제
    if git_dir:
        r = subprocess.run(
            ["git", "branch", "-d", branch],
            cwd=git_dir, capture_output=True, text=True
        )
        if r.returncode == 0:
            removed.append({"repo": repo_name, "branch": branch, "status": "removed"})
        else:
            if "not found" in r.stderr or "error" not in r.stderr.lower():
                removed.append({"repo": repo_name, "branch": branch, "status": "already_gone"})
            else:
                failed.append({"repo": repo_name, "error": r.stderr.strip()})
    else:
        removed.append({"repo": repo_name, "branch": branch, "status": "no_git_dir"})

    # 3. bare clone 정리: 다른 활성 워크트리가 없으면 삭제
    if git_dir:
        r = subprocess.run(
            ["git", "worktree", "list", "--porcelain"],
            cwd=git_dir, capture_output=True, text=True
        )
        wt_paths = [
            line.split(" ", 1)[1]
            for line in r.stdout.splitlines()
            if line.startswith("worktree ") and line.split(" ", 1)[1] != git_dir
        ]
        if not wt_paths:
            shutil.rmtree(git_dir, ignore_errors=True)
            removed.append({"repo": repo_name, "git_dir": os.path.basename(git_dir), "status": "clone_deleted"})

# 4. 빈 워크트리 디렉토리 정리
worktree_root = os.path.join(project_root, "worktrees")
if os.path.isdir(worktree_root):
    for repo_dir_name in os.listdir(worktree_root):
        repo_wt_dir = os.path.join(worktree_root, repo_dir_name)
        if os.path.isdir(repo_wt_dir) and not os.listdir(repo_wt_dir):
            os.rmdir(repo_wt_dir)

# 5. vcs.xml 정리
vcs_removed = 0
if os.path.isfile(vcs_xml):
    with open(vcs_xml) as f:
        lines = f.readlines()

    new_lines = []
    for line in lines:
        if f"feature-{ticket}" in line or f"feature/{ticket}" in line:
            vcs_removed += 1
            continue
        new_lines.append(line)

    if vcs_removed > 0:
        with open(vcs_xml, "w") as f:
            f.writelines(new_lines)

# 6. 상태 파일 삭제
state_deleted = False
if os.path.isfile(state_file):
    os.remove(state_file)
    state_deleted = True

# --- 불변식 검증 ---
violations = []
for repo_name, repo_info in repos.items():
    worktree_abs = os.path.join(project_root, repo_info["worktree"])
    if os.path.exists(worktree_abs):
        violations.append(f"잔존 워크트리: {repo_info['worktree']}")

result = {
    "status": "error" if violations else "ok",
    "removed": removed,
    "failed": failed,
    "vcs_mappings_removed": vcs_removed,
    "state_deleted": state_deleted,
    "violations": violations,
}
print(json.dumps(result, ensure_ascii=False))
PYEOF
)

echo "$RESULT"
echo "$RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(1 if d['status']=='error' else 0)"
