# Changelog

이 프로젝트의 주요 변경사항을 기록합니다.

형식: [Semantic Versioning](https://semver.org/)

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
