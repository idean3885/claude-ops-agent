---
name: usage-start
description: 새 작업의 사용량 추적을 시작합니다. 현재 세션을 기록하고 프로젝트+브랜치를 자동 등록합니다. 트리거 "사용량 추적", "추적 시작", "usage-start".
---

# usage:start

Start tracking token usage for a new task.

## Trigger

- "usage start {label}"
- "usage tracking {label}"
- "작업 추적 시작 {label}"

## Parameters

- **label** (required): Human-readable task name (e.g., "GPU Live 프로젝트 CRUD 정책서")
- **approach** (optional): Method being used (e.g., "manual", "workflow-runner", "autopilot"). Default: "manual"
- **tags** (optional): Comma-separated tags for grouping (e.g., "spec,planning")

## Procedure

### 1. Detect current context

```bash
# Get current session ID from the most recent JSONL in this project
PROJECT_PATH=$(pwd | sed "s|$HOME/||" | sed 's|/|-|g' | sed 's|^|-|')
SESSION_ID=$(ls -t ~/.claude/projects/${PROJECT_PATH}/*.jsonl 2>/dev/null | head -1 | xargs basename | sed 's/.jsonl//')

# Get current git branch (if git project)
GIT_BRANCH=$(git branch --show-current 2>/dev/null || echo "none")
```

### 2. Read or create tasks.json

```bash
TRACKER_DIR="$HOME/.claude/usage-tracker"
mkdir -p "$TRACKER_DIR/reports"
cat "$TRACKER_DIR/tasks.json" 2>/dev/null || echo '{"tasks":{}}'
```

### 3. Generate task ID

Create a short, URL-safe ID from the label:
- Lowercase, replace spaces with hyphens
- Max 30 chars
- If duplicate, append `-2`, `-3`, etc.

### 4. Write task entry

Add to tasks.json:

```json
{
  "tasks": {
    "{taskId}": {
      "label": "{label}",
      "approach": "{approach}",
      "tags": ["{tag1}", "{tag2}"],
      "bindings": [
        {
          "project": "{PROJECT_PATH}",
          "branch": "{GIT_BRANCH}"
        }
      ],
      "sessions": [
        {
          "id": "{SESSION_ID}",
          "addedAt": "{ISO timestamp}",
          "auto": false
        }
      ],
      "startedAt": "{ISO timestamp}",
      "status": "active"
    }
  }
}
```

### 5. Report

Output:
```
[Usage Tracker] Task started
- ID: {taskId}
- Label: {label}
- Approach: {approach}
- Session: {SESSION_ID}
- Binding: {project} @ {branch}
```
