# Changelog

이 프로젝트의 주요 변경사항을 기록합니다.

형식: [Semantic Versioning](https://semver.org/)

## [3.8.0] - 2026-03-31

### Fixed
- feat: PR Closes 규칙 추가 — GitHub Issues 사용 시 자동 닫힘

## [3.7.4] - 2026-03-27

### Fixed
- 버전 범프 스크립트 추가 — 4곳 동시 업데이트 강제

## [3.7.3] - 2026-03-27

### Fixed
- issue complete post-action을 provider Extensions 의존으로 통일
- Extensions이 정의되어 있으면 실행, 없으면 스킵

## [3.7.2] - 2026-03-26

### Fixed
- flow 스킬 워크트리 환경 커밋 감지 보정: sibling 공유 커밋 제외, 브랜치 고유 커밋만 카운트
- 이슈 불일치 감지 추가: 다른 이슈 작업 요청 시 워크트리 분기 권장

## [3.7.1] - 2026-03-26

### Added
- flow 스킬에 환경 감지 단계 추가 (상태 감지 전 필수)
  - Base Branch 감지: upstream 추적 → merge-base 최근접 순서로 분기 원점 결정
  - Worktree 감지: git-common-dir vs git-dir 비교로 linked worktree 판별

## [3.7.0] - 2026-03-25

### Changed
- flow 스킬을 Git 상태 기반 디스패처로 전환
  - 순차 7-Phase 파이프라인 → 상태 감지 테이블 (7 우선순위)
  - GATE 3개 → 2개 (머지 승인 제거, 사용자 웹 머지 = 세이프티가드)
  - issue complete 시 머지 체크 1회 (브랜치 삭제 보호)
  - 121줄 → 55줄 컨텍스트 경량화

## [3.6.0] - 2026-03-20

### Added
- PreToolUse 훅으로 세션 컨텍스트 주입 방식 전환
  - SessionStart 훅은 출력 주입을 지원하지 않음 (Claude Code 플랫폼 제약)
  - SessionStart: 사이드이펙트 전담 (버전 동기화, git identity, 캐시 파일 생성)
  - PreToolUse: 캐시 파일을 읽어 `additionalContext`로 주입
  - 버전, provider, Git Identity, 스킬 트리거 매핑이 매 툴 사용 시 컨텍스트에 포함

## [3.5.5] - 2026-03-20

### Fixed
- SessionStart 훅 stdout 출력을 `process.stdout.write` → `console.log`로 변경
  - Claude Code가 줄바꿈으로 출력 완료를 판단하는 것으로 추정
  - OMC bash 훅의 `echo`와 동일하게 줄바꿈 포함 출력

## [3.5.4] - 2026-03-20

### Fixed
- SessionStart 훅 matcher를 `""` → `"*"`로 변경 — 세션 컨텍스트 미주입 근본 원인 해소
  - 빈 문자열 matcher로는 훅이 실행되지만 출력이 세션에 주입되지 않음
  - OMC 플러그인과 동일한 `"*"` 와일드카드 사용

## [3.5.3] - 2026-03-20

### Added
- SessionStart 훅 컨텍스트에 `devex: v{version}` 명시적 출력
  - VERSION 파일 기반으로 실제 버전을 세션 컨텍스트 첫 줄에 주입
  - 디렉토리명과 무관하게 AI가 정확한 버전을 인식

## [3.5.2] - 2026-03-20

### Fixed
- syncPluginVersion에서 디렉토리 리네임 제거
  - 리네임이 Claude Code의 경로 캐싱과 충돌하여 재설치/롤백 유발
  - installed_plugins.json의 version, gitCommitSha만 갱신 (경로 유지)
  - renameSync, dirname import 제거, pluginRoot를 const로 복원

## [3.5.1] - 2026-03-20

### Fixed
- README에서 사내 도메인 유출 제거 (Mermaid 다이어그램 예시를 generic으로 교체)

### Added
- commit 스킬 리뷰에 대외비 검증 단계 추가
  - 퍼블릭 리모트 대상: 사내 도메인, 내부 API URL, 조직명 등 diff 검증
  - 로컬 전용 provider 내용이 퍼블릭 파일에 유입되지 않았는지 확인
  - 리뷰 체크리스트에 대외비 미포함 항목 추가

## [3.5.0] - 2026-03-20

### Changed
- README.md 전면 재작성 — v3.x 플러그인 구조 반영
  - 이슈 사이클 → 이슈 플로우 용어 통일
  - 구버전 스킬명(/github-issue, /github-pr, /implement) 제거
  - setup.sh/템플릿 설치 방식 → 플러그인 마켓플레이스 설치로 전환
  - project-profile 설명 제거 (v3.0.0에서 삭제됨)
  - Provider 시스템, Git Identity, 플러그인 자체 관리 기능 문서화
  - Mermaid 다이어그램 현행화

## [3.4.2] - 2026-03-20

### Fixed
- syncPluginVersion 후 pluginRoot 미갱신으로 cleanupStaleVersions가 새 디렉토리 삭제하는 치명적 버그 수정
  - pluginRoot를 let으로 변경, 리네임 후 즉시 갱신
  - 실행 순서 변경: cleanupStaleVersions → syncPluginVersion (안전한 순서)

## [3.4.1] - 2026-03-20

### Added
- SessionStart 훅에서 플러그인 버전 자동 동기화
  - VERSION 파일과 캐시 디렉토리명 불일치 시 자동 리네임
  - installed_plugins.json의 version, installPath, gitCommitSha 자동 갱신
  - 수동 marketplace update나 재설치 불필요
- SessionStart 훅에서 플러그인 캐시 디렉토리 git identity 자동 설정
  - 플러그인 리모트 호스트의 provider Git Identity 기반
  - 재설치 후에도 올바른 계정으로 자동 커밋 가능

## [3.4.0] - 2026-03-20

### Added
- Git Identity 시스템 — 크리덴셜 기반 커밋 계정 자동 검증
  - Provider에 `## Git Identity` 섹션 추가 (user.name, user.email)
  - SessionStart 훅에서 `gh auth status`로 크리덴셜 계정 감지 후 컨텍스트 주입
  - 커밋/푸시 전 provider의 Git Identity와 repo git config 자동 검증 및 수정
  - 글로벌/로컬 git config에 의존하지 않고 크리덴셜 → identity 매핑으로 계정 오류 원천 차단
- Provider 템플릿(PROVIDER.md)에 Git Identity 섹션 추가

### Fixed
- SessionStart 훅 출력 필드를 `additionalContext` → `message`로 변경 — 세션 복원 시 컨텍스트 미주입 버그 해소
- `ensurePluginGit()`에서 `origin/master` 하드코딩 → 리모트 기본 브랜치 자동 감지로 변경

## [3.3.0] - 2026-03-19

### Added
- SessionStart 훅에서 스킬 트리거 매핑을 additionalContext로 주입
  - 프로젝트 enabledPlugins 설정과 무관하게 스킬 동작 보장
  - 어떤 디렉토리에서든 자연어로 스킬 트리거 가능
  - 디스크 쓰기 없음 — 세션 메모리에만 존재

### Fixed
- provider 감지 regex 수정 — 마크다운 테이블 형식 hostPattern 파싱 실패 해소

## [3.2.2] - 2026-03-19

### Fixed
- .claude/ 디렉토리를 .gitignore에 추가하여 플러그인 캐시에서 제외
  - 플러그인 캐시에 .claude/skills/가 존재하면 Claude Code가 plugin.json의 skills 등록을 무시하는 문제 해소
  - devex 스킬(issue, commit, pr, flow, spec, setup)이 세션 스킬 목록에 정상 노출되도록 수정

## [3.2.1] - 2026-03-18

### Added
- SessionStart 훅에서 이전 버전 캐시 디렉토리 자동 정리
  - marketplace update 후 잔여 버전 디렉토리 누적 방지

## [3.2.0] - 2026-03-18

### Added
- 릴리스 자동화 워크플로우 (`release.yml`) — main 브랜치 VERSION 변경 시 태그 + GitHub Release 자동 생성
- CHANGELOG에서 해당 버전 섹션을 자동 추출하여 릴리스 노트 생성

### Fixed
- master/main 브랜치 분리로 인한 v3.0.0~v3.1.1 미배포 해소
- 자기 참조 auto-update PR 정리 (#35, #38, #46)
- 스테일 브랜치 정리 (master, chore/devex-update-*)
- 커밋 히스토리 author 정보 정규화

## [3.1.1] - 2026-03-18

### Fixed
- issue 스킬에 provider 참조 필수 규칙 강제 — API 추측 호출 방지
- provider 파일 미참조 시 API 호출 금지 명시
- 본문 업데이트 시 기존 cc·태그 보존 필수 규칙 추가
- workflow.json currentIssue 제거 단계 추가

## [3.1.0] - 2026-03-18

### Added
- `/issue` 서브커맨드 확장 — create/start/complete 이슈 생애주기 전체 관리
- 코드 없는 이슈 지원 — start 시 브랜치 생성 선택 (조사/문서 이슈 대응)
- github provider에 이슈 start/complete 생애주기 추가
- SessionStart 훅에서 plugin git 자동 복원 (marketplace update 후 수동 절차 불필요)
- marketplace.json에 repository.url 추가

### Removed
- `/implement` 스킬 제거 — 프로젝트별 구현 스킬 + cross-verify 구현축으로 대체

### Changed
- 플러그인명 `devex`로 통일 (plugin.json + marketplace.json)

## [3.0.0] - 2026-03-18

### Breaking Changes
- 이슈 사이클 → 이슈 플로우(issue flow) 용어 전환
- `/cycle` → `/flow`, `/github-issue` → `/issue`, `/github-pr` → `/pr` 스킬 리네이밍
- `/implement` 스킬 제거 — 프로젝트별 구현 스킬 + cross-verify 구현축으로 대체
- Provider 추상화 도입 — 플랫폼별 이슈 동작을 provider로 분리

### Added
- `providers/` 디렉토리 — PROVIDER.md 템플릿 + github.md 기본 내장
- `/setup` 스킬 — provider 등록, 상태 확인, overlay 설정
- `/issue` 서브커맨드 확장 — create/start/complete 이슈 생애주기 전체 관리
- 코드 없는 이슈 지원 — start 시 브랜치 생성 선택, 조사/문서 이슈 대응
- SessionStart 훅에서 git remote host 기반 provider 자동 감지
- 로컬 provider 시스템 (`~/.claude/devex/providers/`, `~/.claude/devex/overlays/`)

### Changed
- github provider에 이슈 start/complete 생애주기 추가
- plugin.json + marketplace.json 플러그인명 `devex`로 통일
- CLAUDE.md 전면 갱신 (이슈 플로우 용어, provider 시스템 설명)

## [2.0.0] - 2026-03-08

### Breaking Changes
- `/post` 스킬을 배포 범위에서 제거 (신규 설치 시 미포함)
  - post는 블로그 레포 전용 보조 도구로, 범용 DevEx 플러그인의 core 범위 밖
  - 기존 설치 레포는 `--update` 시 삭제되지 않음 (수동 삭제 필요)
  - core 스킬 9종 확정: 이슈 사이클 6종 + thinking 3종

### Changed
- cycle 스킬에서 spec/implement 의존성 제거 (플랜 기반 구현으로 단순화)
- cycle 스킬 인라인 중복 제거: 명시적 파일 경로 위임으로 전환
  - github-issue, commit, github-pr 규칙을 인라인 재작성 → Read 위임
  - 단일 진실 원천(single source of truth) 확보
- README cycle 다이어그램 "명세 + 구현" → "구현" 동기화

## [1.5.0] - 2026-02-19

### Added
- `/post` 스킬에 비평가 검토 단계(Phase 4) 추가
  - 품질 기준 5개: 주제 선명도, 분량 적절성, 톤 적합성, 저자 관점, 중복 여부
  - 가독성 기준 7개 (A4 PDF 최적화): 문단 단위, 문단 길이, 주제문 선행, 단문 문단, 열거 vs 산문, 코드 블록, 산문 연속
  - 문단 분리 판단 기준: 연관 문장의 문단 유지/분리 테스트
  - 근거: Google/Microsoft Style Guide, NN/G, WCAG CJK 권장사항

## [1.4.0] - 2026-02-18

### Added
- 사이클/이슈 브랜치 생성 시 워크트리 우선 안내
  - 워크트리(권장): 로컬 상태 보존, 별도 디렉토리에서 작업
  - 직접 체크아웃: uncommitted changes 확인 후 전환
  - Phase 7 정리 단계에 워크트리/체크아웃 분기 추가

## [1.3.1] - 2026-02-18

### Changed
- README 가독성 개선: 독립 문장 개행 분리, blockquote 한 줄 통합 (업계 관례 기반)

## [1.3.0] - 2026-02-18

### Added
- Thinking 스킬 3종: `/decision-record`, `/verify`, `/dependency-map`
  - `/decision-record`: MADR 기반 아키텍처 의사결정 기록 (파기 조건 포함)
  - `/verify`: 3-Layer(Philosophy → Strategy → Tactics) 정합성 검증 + Devil's Advocate
  - `/dependency-map`: Mermaid 의존성 맵 생성 및 변경 영향도 분석
- 프로젝트 설명 업데이트: 자연어 호출 중심, 기본 가이드라인 + 오버라이드 자유도 사상 반영
- `skills/thinking/` 디렉토리로 기존 이슈 사이클과 물리적 분리
- setup.sh에 thinking 스킬 설치 포함

## [1.2.2] - 2026-02-15

### Added
- README에 GitHub 인증 설정 가이드 추가 (제로 트러스트 / 클래식 토큰)

## [1.2.1] - 2026-02-15

### Changed
- CLAUDE.md 템플릿 경량화: 스킬과 중복되는 Git Flow, 브랜치 전략, 커밋 컨벤션 상세를 참조 링크로 대체 (228줄 → 172줄)
- 검증 섹션 추가: 자가 검증/비판적 검증 구분 가이드

## [1.2.0] - 2026-02-13

### Added
- `/cycle` 스킬: 전체 이슈 사이클 오케스트레이션
  - 7단계 워크플로우 (이슈 탐색 → 플랜 → 구현 → 리뷰 → PR → 검증 → 머지)
  - 3개 확인 게이트 (플랜 승인, 커밋 승인, 머지 승인)
  - 시스템 리마인더와 무관하게 GATE에서 사용자 응답 대기

## [1.1.0] - 2026-02-12

### Added
- 자동 업데이트 구독 (`setup.sh --subscribe`)
  - GitHub Actions 워크플로우로 매일 09:00 KST 자동 확인
  - 변경 감지 시 PR 자동 생성
- `/github-pr` 스킬: PR 머지 후 타겟 브랜치 이동 및 최신화 단계 추가

### Changed
- README.md 포지셔닝 개선: 프로젝트 설명을 구체화

## [1.0.0] - 2026-02-11

### Added
- 이슈 사이클 스킬 5종: github-issue, spec, implement, commit, github-pr
- 프로젝트 프로필 (`project-profile.md`) 지원: 스킬 동작을 프로젝트에 맞게 오버라이드
  - `/spec`, `/implement` 스킬이 프로필에 따라 동작 조정
- 버전 관리 체계 도입
  - `VERSION` 파일 (semver)
  - `setup.sh` 업데이트 모드 (`--check`, `--update`)
  - 다운스트림 프로젝트 `.devex-version` 기록
- `setup.sh` 설치 스크립트
- CLAUDE.md 템플릿 (AI 협업 가이드)
- README.md 프로젝트 문서
