# 사용자 글로벌 지침

1인 사용자 환경. 자연어 라우팅 + 콘텐츠 SSOT 기반으로 작업한다.

## 자연어 라우팅 정책

스킬을 직접 호출하지 않는다. 자연어로 요청하면 하네스가 스킬 description 의 트리거 키워드를 매칭하여 자동 라우팅한다. 스킬 description 갱신은 각 플러그인 리포에서 한다.

## AI 티·가독성·톤 SSOT

ops-agent 의 `config/style-rules/{base,extensions}/` 가 모든 한국어 문서(블로그·위키·이슈·PoC·데일리로그·동료리뷰·성과평가)의 단일 출처.
세션 시작 시 ops-agent SessionStart hook 이 `~/.claude/ops-agent/style-rules/` 로 미러한다. 외부 소비자는 이 경로를 참조.

| 파일 | 역할 |
|------|------|
| `base/ai-tells.md` | AI 티 분류 (A~J, im-not-ai MIT 차용) |
| `base/readability.md` | 구조 가독성 (P/H/L/C/V/K/B) |
| `base/tone.md` | 저자 톤 (T1~T13) |
| `base/punctuation.md` | 한국어 구두점 (PN1~PN6) |
| `extensions/{blog,wiki,poc,info,knowledge,issue,dailylog,peer-review,work-review}.md` | 문서 유형별 추가 규칙 |

표현 가드 hook(`forbidden-words.json`)은 응답을 출력 직전에 막거나 재작성하지 않는다. UserPromptSubmit 가 금지 표현 룰을 사전 주입하고, Stop 이 직전 응답 위반을 사후 통지한다. 따라서 출력 직전 패턴 자가 대조는 어시스턴트의 의무다. 패턴은 base SSOT 의 카테고리 ID(`taxonomyId`)와 1:1 매핑되어 추적된다. 사용자 추가 룰은 `~/.claude/forbidden-words.local.json` 에 작성하면 머지된다.

## ops-agent 개발 룰

- 워킹 카피: `/Users/nhn/git-project/idean3885/claude-ops-agent/`
- 변경은 워크트리 → `bump-version.sh` 로 버전 범프 → 커밋 → PR → 웹 머지. **main 직접 push 금지**
- 머지 후 `./scripts/post-merge-sync.sh` 로 로컬 캐시 동기 (마켓플레이스 update + 활성 세션 경로 복원)
- 이슈 플로우 필수 — 자식 PR 단위로 분할
- 수동 버전 범프 금지. 반드시 `bump-version.sh` 사용

### 워킹 카피가 없는 경우

`~/.claude/plugins/cache/{plugin}/...` 에서 `.git` 이 없으면 SessionStart hook 이 자동 복원한다. 급한 경우 캐시에서 워크트리를 분기해 작업하되, 반영은 동일하게 PR → 웹 머지로만 한다. 워킹 카피가 있으면 워킹 카피 우선.
