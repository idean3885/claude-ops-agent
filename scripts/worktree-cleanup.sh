#!/bin/bash
# org-flow: 워크트리 제거 + bare clone 정리 + vcs.xml 정리 + 상태 파일 삭제
#
# 리모트 원소스 전략: 워크트리 제거 후 해당 레포에 다른 활성 워크트리가 없으면
# bare clone도 삭제한다. 로컬에 레포 흔적을 남기지 않는다.
#
# 사용법:
#   ./worktree-cleanup.sh <state-file>              # 티켓 단위 정리 (기본)
#     state-file: .omc/state/org-flow-{ticket}.json
#
#   ./worktree-cleanup.sh --sweep-stale [--apply]   # stale state/고아 bare clone 정리
#     --apply 없이 실행하면 dry-run (감지만 출력).
#     --apply 지정 시 stale state 및 고아 bare clone을 실제 제거.
#     stale 판정: state 파일이 참조하는 워크트리 경로가 더 이상 존재하지 않음.
#     고아 bare clone 판정: 활성 워크트리가 없고, stale이 아닌 어떤 state도 참조하지 않음.
#
# 출력: JSON
#   기본 모드: {status, removed[], failed[], state_deleted, violations}
#   sweep 모드: {status, mode:"sweep-stale", apply, stale_states[], orphan_bare_clones[]}

set -euo pipefail

find_project_root() {
  local dir="$1"
  while [ "$dir" != "/" ]; do
    [ -f "$dir/.devex/project.json" ] && echo "$dir" && return
    dir="$(dirname "$dir")"
  done
  echo ""
}

# --- sweep-stale 서브커맨드 ---
if [ "${1:-}" = "--sweep-stale" ]; then
  APPLY="false"
  [ "${2:-}" = "--apply" ] && APPLY="true"

  PROJECT_ROOT="$(find_project_root "$(pwd)")"
  if [ -z "$PROJECT_ROOT" ]; then
    echo '{"status": "error", "message": ".devex/project.json을 찾을 수 없음"}' >&2
    exit 1
  fi

  RESULT=$(APPLY_FLAG="$APPLY" PROJECT_ROOT_ENV="$PROJECT_ROOT" python3 << 'PYEOF'
import json, os, subprocess, shutil

project_root = os.environ["PROJECT_ROOT_ENV"]
apply = os.environ["APPLY_FLAG"] == "true"
state_dir = os.path.join(project_root, ".omc", "state")

stale_states = []  # [{file, ticket, reason, repos_missing[]}]
# state 파일별로 worktree 경로 실존 검증
active_repos = set()  # stale이 아닌 state가 참조하는 repo name
state_repo_map = {}  # state_file -> {repo_name: worktree_abs}

if os.path.isdir(state_dir):
    for sf in sorted(os.listdir(state_dir)):
        if not (sf.startswith("org-flow-") and sf.endswith(".json")):
            continue
        sf_path = os.path.join(state_dir, sf)
        try:
            with open(sf_path) as f:
                s = json.load(f)
        except Exception as e:
            continue
        repos = s.get("repos", {})
        missing = []
        for rn, rinfo in repos.items():
            wt_abs = os.path.join(project_root, rinfo.get("worktree", ""))
            if not os.path.isdir(wt_abs):
                missing.append({"repo": rn, "worktree": rinfo.get("worktree")})
        is_stale = bool(repos) and len(missing) == len(repos)
        if is_stale:
            stale_states.append({
                "file": sf,
                "ticket": s.get("ticket"),
                "reason": "모든 참조 워크트리 부재",
                "repos_missing": missing,
            })
        else:
            for rn in repos:
                active_repos.add(rn)
        state_repo_map[sf_path] = {rn: rinfo.get("worktree") for rn, rinfo in repos.items()}

# 고아 bare clone 판정
orphan_bare_clones = []
for entry in sorted(os.listdir(project_root)):
    if not entry.endswith(".git"):
        continue
    bare_path = os.path.join(project_root, entry)
    if not os.path.isdir(bare_path):
        continue
    if not os.path.isfile(os.path.join(bare_path, "HEAD")):
        continue  # bare가 아님
    repo_name = entry[:-4]
    if repo_name in active_repos:
        continue  # stale 아닌 state가 참조

    # 활성 워크트리 체크
    r = subprocess.run(
        ["git", "worktree", "list", "--porcelain"],
        cwd=bare_path, capture_output=True, text=True
    )
    wt_paths = [
        line.split(" ", 1)[1]
        for line in r.stdout.splitlines()
        if line.startswith("worktree ") and line.split(" ", 1)[1] != bare_path
    ]
    if wt_paths:
        continue  # 활성 워크트리 있음

    orphan_bare_clones.append({"repo": repo_name, "bare": entry})

# apply 모드: 실제 제거
if apply:
    for st in stale_states:
        sf_path = os.path.join(state_dir, st["file"])
        try:
            os.remove(sf_path)
            st["removed"] = True
        except Exception as e:
            st["removed"] = False
            st["error"] = str(e)
    for ob in orphan_bare_clones:
        bare_path = os.path.join(project_root, ob["bare"])
        try:
            shutil.rmtree(bare_path, ignore_errors=True)
            ob["removed"] = not os.path.exists(bare_path)
        except Exception as e:
            ob["removed"] = False
            ob["error"] = str(e)

    # 빈 worktree 레포 디렉토리 정리
    worktree_root = os.path.join(project_root, "worktrees")
    if os.path.isdir(worktree_root):
        for d in os.listdir(worktree_root):
            p = os.path.join(worktree_root, d)
            if os.path.isdir(p) and not os.listdir(p):
                os.rmdir(p)
        if not os.listdir(worktree_root):
            os.rmdir(worktree_root)

result = {
    "status": "ok",
    "mode": "sweep-stale",
    "apply": apply,
    "stale_states": stale_states,
    "orphan_bare_clones": orphan_bare_clones,
}
print(json.dumps(result, ensure_ascii=False))
PYEOF
)
  echo "$RESULT"
  exit 0
fi

# --- 기본: 티켓 단위 정리 ---

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

# 4. 빈 워크트리 디렉토리 정리 — 현재 티켓이 비운 레포 디렉토리만
worktree_root = os.path.join(project_root, "worktrees")
if os.path.isdir(worktree_root):
    for repo_name in repos.keys():
        repo_wt_dir = os.path.join(worktree_root, repo_name)
        if os.path.isdir(repo_wt_dir) and not os.listdir(repo_wt_dir):
            os.rmdir(repo_wt_dir)

# 과거 "4.5 고아 bare repo sweep", "4.6 고아 워크트리 디렉토리 정리" 블록 제거.
# 현재 state에 명시되지 않은 bare repo/워크트리를 "고아"로 판단해 삭제하는 동작이
# 멀티레포 환경에서 다른 티켓·수동 관리 작업까지 휩쓸어 버리는 사고를 유발.
# 정리는 반드시 state에 명시된 레포만 대상으로 한다.

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
# state에 명시된 레포의 워크트리·bare clone만 검증 대상.
# 다른 레포의 잔존은 본 스크립트의 관심사가 아니다.
violations = []
for repo_name, repo_info in repos.items():
    worktree_abs = os.path.join(project_root, repo_info["worktree"])
    if os.path.exists(worktree_abs):
        violations.append(f"잔존 워크트리: {repo_info['worktree']}")
    bare_path = os.path.join(project_root, f"{repo_name}.git")
    if os.path.isdir(bare_path):
        violations.append(f"잔존 bare repo: {repo_name}.git")

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
