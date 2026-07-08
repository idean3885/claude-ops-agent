---
name: setup
description: ops-agent provider 등록·상태 조회·overlay 설정. 이슈 트래커 provider(github 등) 추가 및 host별 오버레이 구성. 트리거 "setup", "설정", "provider 등록", "프로바이더".
---

# Setup Skill

provider 등록 및 프로젝트 설정 워크플로우

## 트리거

- "setup", "설정", "provider 등록", "프로바이더"

## 서브커맨드

### `/setup provider`

새로운 이슈 트래커 provider를 등록한다.

**워크플로우**:

1. provider 이름 질문 → `{name}`
2. 호스트 패턴 질문 → `{hostPattern}` (git remote host와 매칭할 문자열)
3. 인증 방식 질문:
   - CLI 도구 (예: `gh`)
   - 환경 변수 (예: `~/.claude/ops-agent/.env`의 토큰)
4. 이슈 API 가이드 유무 질문:
   - 있으면 참조하여 provider.md 생성
   - 없으면 `providers/PROVIDER.md` 템플릿 기반으로 빈 구조 생성
5. `~/.claude/ops-agent/providers/{name}.md` 생성
6. 필요 시 `~/.claude/ops-agent/overlays/{hostPattern}.json` 생성
7. "다음 세션부터 {hostPattern} 레포에서 자동 인식됩니다. `/reload-plugins`로 즉시 반영도 가능합니다."

### `/setup status`

현재 감지된 provider와 설정 상태를 표시한다.

**표시 항목**:
- 현재 provider (name, source)
- overlay 로드 여부
- `~/.claude/ops-agent/` 디렉토리 구조
- 등록된 provider 목록

### `/setup overlay`

현재 provider의 overlay 설정을 생성/수정한다.

**워크플로우**:

1. 현재 provider 확인
2. `~/.claude/ops-agent/overlays/{hostPattern}.json` 읽기 (없으면 빈 객체)
3. 설정할 항목 질문 (태그, CC, 마일스톤, 담당자 등)
4. overlay 파일 생성/수정
5. `/reload-plugins`로 반영 안내

## 디렉토리 구조 안내

```
~/.claude/ops-agent/
├── providers/          # 커스텀 provider 정의
│   └── {name}.md
├── overlays/           # host별 오버레이 설정
│   └── {hostPattern}.json
└── .env                # 시크릿 (토큰 등)
```

## 규칙

- provider 등록은 사용자 입력 기반 (자동 생성하지 않음)
- 기존 provider 덮어쓰기 시 사용자 확인
- `.env` 파일에 시크릿 직접 기록하지 않음 (경로만 안내)
