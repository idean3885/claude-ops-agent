# Changelog

이 프로젝트의 주요 변경사항을 기록합니다.

형식: [Semantic Versioning](https://semver.org/)

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
