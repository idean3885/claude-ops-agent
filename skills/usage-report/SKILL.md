---
name: usage-report
description: 모든 추적된 작업의 비교 대시보드를 표시합니다. 트리거 "사용량 리포트", "report", "대시보드".
---

# usage:report

모든 추적된 작업의 비용을 비교하는 대시보드를 출력한다.

## Trigger

- "usage report"
- "usage dashboard"
- "작업 비교"

## Parameters

- **filter** (optional): "active", "completed", "all" (default: "all")
- **sort** (optional): "cost", "date", "efficiency" (default: "date")

## Procedure

### 1. Load all tasks

```bash
cat "$HOME/.claude/usage-tracker/tasks.json"
```

### 2. Aggregation

두 모드를 순서대로 시도한다.

**Mode A — cwd-based (default).** task 의 `bindings[].cwd` 가 있으면 적용된다. worktree-per-task 환경에서 ticket 단위로 분리된 정확한 비용을 얻는다.

1. `cwd → taskId` 매핑 테이블을 만든다 (`tasks[*].bindings[*].cwd`)
2. `~/.claude/projects/*/*.jsonl` 의 모든 trace 를 순회하면서 `type == "assistant"` entry 만 추출
3. 각 entry 의 `cwd` 필드로 매핑 테이블 조회 → 해당 taskId 의 token / cost 누적
4. cost = 모델별 단가 × (input + output + cache_creation + cache_read)

알고리즘과 sample python 은 [docs/usage-cwd-aggregation.md](../../docs/usage-cwd-aggregation.md) 참조.

**Mode B — ccusage fallback.** `bindings[].cwd` 가 없는 legacy task 한정.

```bash
ccusage session --since {earliest task startedAt as YYYYMMDD} --json --breakdown
```

- task 의 `bindings[].project` 와 ccusage 의 `sessionId` 를 매칭
- 같은 parent project 의 여러 ticket 은 분리되지 않으므로 합산 결과만 표시 + 경고 출력

### 3. Output comparison table

```
[Usage Tracker] Dashboard

| Task | Approach | Cost | Tokens | Sessions | Days | $/Day | Status |
|------|----------|------|--------|----------|------|-------|--------|
| {label} | {approach} | ${cost} | {tokens} | {count} | {days} | ${perDay} | {status} |

Total tracked cost: ${totalCost}
```

### 4. Approach comparison (if multiple approaches exist)

```
[Approach Comparison]
| Approach | Avg $/Task | Avg Tokens | Avg Sessions | Tasks |
|----------|-----------|------------|-------------|-------|
| manual   | ${avg}    | {avg}      | {avg}       | {n}   |
| autopilot| ${avg}    | {avg}      | {avg}       | {n}   |
```

이 비교가 플러그인의 핵심 가치 -- 워크플로우 변경이 실제로 효율적인지 데이터로 증명한다.
