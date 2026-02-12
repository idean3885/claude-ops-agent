# Changelog

이 프로젝트의 주요 변경사항을 기록합니다.

형식: [Semantic Versioning](https://semver.org/)

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
- AOP 기반 프로젝트 프로필 (`project-profile.md`) 지원
  - `/spec`, `/implement` 스킬이 프로필에 따라 동작 조정
- 버전 관리 체계 도입
  - `VERSION` 파일 (semver)
  - `setup.sh` 업데이트 모드 (`--check`, `--update`)
  - 다운스트림 프로젝트 `.devex-version` 기록
- `setup.sh` 설치 스크립트
- CLAUDE.md 템플릿 (AI 협업 가이드)
- README.md 프로젝트 문서
