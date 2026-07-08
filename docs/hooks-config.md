# hook·설정 레퍼런스

README 의 [3. 규칙 자동 적용](../README.md#3-규칙-자동-적용) 에서 요약한 hook 의 설정 상세와 플러그인 자체 관리 동작입니다. 설계 배경은 [design-philosophy.md](design-philosophy.md) 를 참조하세요.

## 표현 가드 룰

금지 표현(과장형 형용사·보고서체·근거 없는 단언·번역투 등)을 응답 출력 직전에 막거나 자동으로 고쳐 쓰지 않습니다. UserPromptSubmit 가 룰을 사전 주입하고, Stop 이 직전 응답 위반을 사후 통지합니다. 따라서 출력 직전 패턴 자가 대조는 어시스턴트의 의무이며, hook 은 이를 돕는 사전 가이드·사후 통지 역할입니다.

룰은 `config/style-rules/base/ai-tells.md` 의 카테고리 ID(`taxonomyId`)와 1:1 매핑되어, 패턴이 왜 존재하는지 역추적됩니다.

| 위치 | 역할 |
|------|------|
| `config/forbidden-words.json` | 기본 룰 (표현 가드 패턴) |
| `~/.claude/forbidden-words.local.json` | 사용자 추가 룰 (선택, 머지됨) |

룰 추가는 JSON 에 객체 하나만 더하면 즉시 반영됩니다(Python 정규식).

```json
{ "pattern": "포괄적|체계적", "replacement": "구체 표현 (무엇을/어떻게)", "reason": "AI 슬롭 (추상적 과장 형용사)" }
```

신규 패턴은 먼저 `base/ai-tells.md` 분류 체계에 카테고리 ID 를 부여하고, S1 으로 판정될 때 등록합니다.

## content-verify 자동 점검 (opt-in)

문서 편집(Edit/Write) 직후 content-verify 관점(AI 티·가독성·톤·구두점) 자가 점검을 유도하는 PostToolUse hook 입니다. 프로젝트 루트에 마커 파일(`.ops-agent/content-verify.json`)이 있을 때만 작동합니다.

```json
{
  "include": ["**/*.md", "resume/*.html"],
  "exclude": ["node_modules/**", "CHANGELOG.md"],
  "note": "프로젝트별 추가 안내 (선택, 리마인더에 함께 출력)"
}
```

- `include` 생략 시 기본값은 `["**/*.md"]` 입니다.
- em dash·AI 슬롭 표현은 hook 이 기계 검출해 즉시 플래그합니다.
- 도메인 특화 검증(예: 이력서 ATS·PDF 동기)은 소비 레포의 프로젝트 스코프 hook 으로 별도 구성합니다.

## 플러그인 자체 관리

SessionStart 훅이 플러그인 캐시 상태를 확인해 자동 복구합니다.

| 기능 | 동작 |
|------|------|
| git 자동 복원 | `.git` 없으면 자동 init + fetch |
| 버전 자동 동기화 | VERSION ↔ 캐시 디렉토리명 불일치 시 자동 갱신 |
| git identity 자동 설정 | 플러그인 리모트 호스트의 provider identity 로 자동 설정 |
| 구버전 정리 | 캐시 내 이전 버전 디렉토리 자동 삭제 |
