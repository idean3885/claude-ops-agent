---
name: usage-checkpoint
description: Mark a checkpoint in the active task to segment usage by work phase. 트리거 "체크포인트", "checkpoint", "사용량 분기".
---

# usage:checkpoint

Mark a checkpoint to split usage into segments. Each checkpoint captures cumulative usage at that point; the difference between consecutive checkpoints becomes the segment usage.

## Trigger

- "usage checkpoint {label}"
- "체크포인트 {label}"
- "구간 표시"

## Parameters

- **label** (required): Segment name (e.g., "Step 4 C-001 작성", "BE 교차검증")
- **taskId** (optional): Task to checkpoint. If omitted and only one active task, uses that one.

## Procedure

### 1. Load tasks and identify target

```bash
cat "$HOME/.claude/usage-tracker/tasks.json"
```

Find target task (active only). If ambiguous, list and ask.

### 2. Query current cumulative usage

```bash
ccusage session --since {task.startedAt as YYYYMMDD} --json --breakdown
```

Match sessions by task's binding projects. Calculate cumulative totals:
- **cumulativeTokens**: sum of totalTokens across matched sessions
- **cumulativeCost**: sum of totalCost

### 3. Calculate segment usage

If previous checkpoints exist, segment = current cumulative - last checkpoint cumulative.
If no previous checkpoints, segment = current cumulative - 0 (i.e., from task start).

```
segmentTokens = cumulativeTokens - lastCheckpoint.cumulativeTokens (or 0)
segmentCost = cumulativeCost - lastCheckpoint.cumulativeCost (or 0)
```

### 4. Write checkpoint to tasks.json

Add to the task's `checkpoints` array (create if not exists):

```json
{
  "checkpoints": [
    {
      "label": "{label}",
      "createdAt": "{ISO timestamp}",
      "cumulativeTokens": 12345,
      "cumulativeCost": 1.23,
      "segmentTokens": 3456,
      "segmentCost": 0.45
    }
  ]
}
```

### 5. Output

```
[Usage Tracker] Checkpoint marked
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Task: {label}
Checkpoint: {checkpoint.label}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
| Metric          | Segment      | Cumulative   |
|-----------------|--------------|--------------|
| Tokens          | {segTokens}  | {cumTokens}  |
| Cost            | ${segCost}   | ${cumCost}   |
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Checkpoints so far: {count}
```
