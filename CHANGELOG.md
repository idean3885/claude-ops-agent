# Changelog

이 프로젝트의 주요 변경사항을 기록합니다.

형식: [Semantic Versioning](https://semver.org/)

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
