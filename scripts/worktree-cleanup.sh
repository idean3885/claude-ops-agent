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

STATE_FILE="${1:?state-file 경로 필수}"

if [ ! -f "$STATE_FILE" ]; then
  echo "{\"status\": \"error\", \"message\": \"상태 파일 없음: $STATE_FILE\"}" >&2
  exit 1
fi

# 프로젝트 루트 감지: state 파일 디렉토리 → 현재 작업 디렉토리 순서로 탐색
# (스크립트 경로는 플러그인 캐시에 있어 기준이 될 수 없음)
STATE_DIR="$(cd "$(dirname "$STATE_FILE")" && pwd)"
PROJECT_ROOT="$(find_project_root "$STATE_DIR")"
[ -z "$PROJECT_ROOT" ] && PROJECT_ROOT="$(find_project_root "$(pwd)")"
if [ -z "$PROJECT_ROOT" ]; then
  echo '{"status": "error", "message": ".devex/project.json을 찾을 수 없음"}' >&2
  exit 1
fi

VCS_XML="$PROJECT_ROOT/.idea/vcs.xml"

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
    # bare clone은 직후 step 3에서 통째로 삭제되므로 ancestry 기반 안전 삭제(-d)가 의미 없다.
    # bare HEAD가 default branch(main)인 반면 PR base가 release/* 등 다른 브랜치이면
    # 머지가 정상이어도 fully-merged 판정에 실패해 not-fully-merged false negative가 발생한다.
    # bare clone에 한해 -D로 강제 삭제하고, 일반 레포는 안전 삭제 -d를 유지한다.
    if git_dir:
        is_bare = git_dir.endswith(".git")
        delete_flag = "-D" if is_bare else "-d"
        r = subprocess.run(
            ["git", "branch", delete_flag, branch],
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

# 4.5. 고아 bare repo sweep
# 다른 org-flow state 파일이 참조하는 레포는 보존
state_dir = os.path.dirname(state_file) if os.path.dirname(state_file) else "."
repos_in_use = set()
if os.path.isdir(state_dir):
    for sf in os.listdir(state_dir):
        if sf.startswith("org-flow-") and sf.endswith(".json"):
            sf_path = os.path.join(state_dir, sf)
            if sf_path == state_file:
                continue
            try:
                with open(sf_path) as f:
                    s = json.load(f)
                for rn in s.get("repos", {}):
                    repos_in_use.add(rn)
            except Exception:
                pass

for entry in os.listdir(project_root):
    if not entry.endswith(".git"):
        continue
    bare_path = os.path.join(project_root, entry)
    if not os.path.isdir(bare_path):
        continue
    # .git 디렉토리(일반 레포)가 아닌 bare clone만 대상
    head_file = os.path.join(bare_path, "HEAD")
    if not os.path.isfile(head_file):
        continue
    repo_name = entry[:-4]  # .git 접미사 제거
    if repo_name in repos_in_use:
        continue  # 다른 티켓에서 사용 중

    # 활성 워크트리 확인
    r = subprocess.run(
        ["git", "worktree", "list", "--porcelain"],
        cwd=bare_path, capture_output=True, text=True
    )
    wt_paths = [
        line.split(" ", 1)[1]
        for line in r.stdout.splitlines()
        if line.startswith("worktree ") and line.split(" ", 1)[1] != bare_path
    ]

    # 고아 워크트리 제거
    for wt in wt_paths:
        try:
            subprocess.run(
                ["git", "worktree", "remove", wt, "--force"],
                cwd=bare_path, capture_output=True, text=True
            )
        except Exception:
            pass
        if os.path.exists(wt):
            shutil.rmtree(wt, ignore_errors=True)

    # bare repo 삭제
    shutil.rmtree(bare_path, ignore_errors=True)
    if not os.path.exists(bare_path):
        removed.append({"repo": repo_name, "git_dir": entry, "status": "orphan_cleaned"})

# 4.6. 고아 워크트리 디렉토리 정리 (git 링크 없는 잔존 디렉토리)
if os.path.isdir(worktree_root):
    for repo_dir_name in os.listdir(worktree_root):
        repo_wt_dir = os.path.join(worktree_root, repo_dir_name)
        if not os.path.isdir(repo_wt_dir):
            continue
        git_link = os.path.join(repo_wt_dir, ".git")
        # .git 파일이 없거나, 링크 대상 bare repo가 사라졌으면 고아
        is_orphan = False
        if not os.path.exists(git_link):
            is_orphan = True
        elif os.path.isfile(git_link):
            with open(git_link) as f:
                gitdir_line = f.read().strip()
            if gitdir_line.startswith("gitdir: "):
                target = gitdir_line[8:]
                if not os.path.isdir(target):
                    is_orphan = True
        if is_orphan:
            shutil.rmtree(repo_wt_dir, ignore_errors=True)
            if not os.path.exists(repo_wt_dir):
                removed.append({"dir": repo_dir_name, "status": "orphan_dir_cleaned"})

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

# 6.5. 빈 worktrees 루트 정리
if os.path.isdir(worktree_root) and not os.listdir(worktree_root):
    os.rmdir(worktree_root)

# --- 불변식 검증 ---
violations = []
for repo_name, repo_info in repos.items():
    worktree_abs = os.path.join(project_root, repo_info["worktree"])
    if os.path.exists(worktree_abs):
        violations.append(f"잔존 워크트리: {repo_info['worktree']}")

# bare repo 잔존 확인
for entry in os.listdir(project_root):
    if entry.endswith(".git") and os.path.isdir(os.path.join(project_root, entry)):
        bare_path = os.path.join(project_root, entry)
        head_file = os.path.join(bare_path, "HEAD")
        if os.path.isfile(head_file):
            repo_name = entry[:-4]
            if repo_name not in repos_in_use:
                violations.append(f"잔존 bare repo: {entry}")

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
