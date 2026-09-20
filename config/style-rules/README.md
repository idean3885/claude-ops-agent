# 한국어 문서 규칙

모든 한국어 문서(블로그 · 위키 · 이슈 · PoC · 데일리로그 · 동료리뷰 · 성과평가)의 단일 출처다. 세션 시작 시 `~/.claude/ops-agent/style-rules/` 로 미러되고 그 디렉토리의 `VERSION` 이 규칙 버전이다. 규칙을 고칠 때는 미러가 아니라 이 디렉토리를 고친다.

| 파일 | 역할 |
|------|------|
| `base/purpose.md` | 문서의 목적과 범위 (PU1~PU5). 착수 전에 판정하는 유일한 파일 |
| `base/ai-tells.md` | AI 티 분류 (A~K, im-not-ai MIT 차용) |
| `base/readability.md` | 구조 가독성 (P·H·L·C·V·CJ·BQ) |
| `base/tone.md` | 저자 톤 (T1~T23) |
| `base/punctuation.md` | 한국어 구두점 (PN1~PN6) |
| `base/length.md` | 산출물 분량 (LN1~LN2) |
| `base/authoring.md` | `SKILL.md`·`CLAUDE.md`·가이드·provider 정의를 쓰거나 고칠 때 적용 (AU1~AU6, mattpocock/skills MIT 차용) |
| `extensions/profiles.md` | 유형별 적용 대상·적용 강도·합격선 정본 |
| `extensions/{blog,wiki,poc,info,knowledge,issue,deck,architecture,dailylog,peer-review,work-review}.md` | 문서 유형별 고유 규칙 |
| `metrics/` | 정량 지표 정의와 카운터 스크립트 |
| `references/` | 차용한 원문 |

`base/authoring.md` 만 읽는 쪽이 모델이다. 나머지는 사람이 읽는 한국어 산문을 다룬다. `SKILL.md` 처럼 양쪽이 읽는 문서는 두 묶음을 함께 적용하고, 충돌하면 그 문서가 존재하는 이유 쪽인 `authoring` 을 따른다.

표현 가드 훅(`config/forbidden-words.json`)은 이 규칙과 별개로 어휘 패턴만 본다. 동작은 `docs/hooks-config.md`.
