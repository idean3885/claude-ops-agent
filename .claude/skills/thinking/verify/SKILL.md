# Verify Skill

3-Layer 정합성 검증 워크플로우

## 역할

의사결정이나 설계의 정합성을 Philosophy(사상) → Strategy(전략) → Tactics(전술) 3계층으로 검증한다. Devil's Advocate(악마의 대변인) 기법으로 자동 반론을 생성하여 약점을 탐색하고, Go/No-Go 판정을 내린다.

## 트리거

- "verify", "검증", "정합성"

## 워크플로우

1. **검증 대상 파악**: 사용자에게 검증할 결정/설계를 확인한다.
   - 관련 문서(ADR, 명세 등)가 있으면 함께 읽는다.
2. **3-Layer 정합성 분석**:
   | 계층 | 질문 | 검증 관점 |
   |------|------|-----------|
   | Philosophy (사상) | "왜 이것을 하는가?" | 프로젝트의 핵심 가치, 원칙과 부합하는가 |
   | Strategy (전략) | "어떤 방향으로 하는가?" | 기술 전략, 아키텍처 방향과 일관되는가 |
   | Tactics (전술) | "구체적으로 어떻게 하는가?" | 구현 방식이 전략을 올바르게 실현하는가 |
3. **계층 간 정합성 확인**:
   - Philosophy ↔ Strategy: 전략이 사상을 올바르게 반영하는가
   - Strategy ↔ Tactics: 전술이 전략과 일관되는가
   - Philosophy ↔ Tactics: 전술이 사상을 위배하지 않는가
4. **Devil's Advocate**: 각 계층에 대해 반론을 1개 이상 생성한다.
5. **Go/No-Go 판정**: 분석 결과를 종합하여 판정한다.
6. **사용자 보고**: 결과를 제시한다.

## 출력 형식

```markdown
## 검증 결과: {대상}

### 3-Layer 분석

| 계층 | 판정 | 요약 |
|------|------|------|
| Philosophy | PASS/WARN/FAIL | ... |
| Strategy | PASS/WARN/FAIL | ... |
| Tactics | PASS/WARN/FAIL | ... |

### 계층 간 정합성

| 관계 | 판정 | 근거 |
|------|------|------|
| Philosophy ↔ Strategy | ALIGNED/MISALIGNED | ... |
| Strategy ↔ Tactics | ALIGNED/MISALIGNED | ... |
| Philosophy ↔ Tactics | ALIGNED/MISALIGNED | ... |

### Devil's Advocate

| # | 반론 | 심각도 | 대응 |
|---|------|--------|------|
| 1 | ... | HIGH/MEDIUM/LOW | ... |

### 판정

**Go / No-Go / 조건부 Go**

사유: ...
```

## 사이클 연계

- `/github-pr` 연계: PR 생성 시 검증 결과를 PR 본문에 첨부할 수 있다.
- `/decision-record` 연계: ADR의 파기 조건을 검증 항목에 포함할 수 있다.

## 규칙

- 판정 기준:
  - **Go**: 3-Layer 모두 PASS, 정합성 모두 ALIGNED
  - **조건부 Go**: WARN이 있으나 FAIL 없음
  - **No-Go**: FAIL이 1개 이상 또는 MISALIGNED가 2개 이상
- Devil's Advocate는 계층당 최소 1개의 반론을 생성한다
- 검증 결과는 마크다운으로 출력하여 Git 추적 가능하게 한다
- 검증은 제안이며, 최종 판단은 사용자가 한다
