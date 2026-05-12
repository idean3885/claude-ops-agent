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

### 2. Query ccusage

```bash
ccusage session --since {earliest task startedAt as YYYYMMDD} --json --breakdown
```

각 task의 sessions 배열에서 session ID를 매칭하여 해당 task에 속하는 비용만 집계한다.

**매칭 로직:**
- task의 bindings[].project와 ccusage의 sessionId를 매칭
- 같은 프로젝트에 여러 작업이 있을 경우, 세션 시작 시간과 task의 sessions[].id로 구분

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
