---
name: dbgate
description: 웹 DB 관리 도구(DbGate)를 필요할 때만 로컬에서 띄우고, 접속 목록의 계정 · 폴더 · 읽기 전용을 미리 채워 연다. 탭을 닫으면 스스로 꺼진다. 트리거 "디비 오픈", "DB 오픈", "디비 게이트", "dbgate", "DB 접속 추가", "DB 비밀번호 저장".
trigger: ["디비 오픈", "DB 오픈", "디비 게이트", "dbgate", "DB 접속 추가", "DB 비밀번호 저장"]
requires:
  - kind: command
    name: node
    check: command -v node
    install: brew install node
    why: 서버 실행 전체
  - kind: command
    name: dbgate-serve
    check: command -v dbgate-serve
    install: npm install -g dbgate-serve
    why: 서버 실행 전체
---

# DbGate

사람이 DB 를 눈으로 보는 화면이다. 접속 정보를 손으로 넣지 않고, 서버를 상주시키지 않는다.

이 스킬은 화면을 열고 접속 목록을 맞추는 일만 한다. AI 가 DB 를 조회하는 경로는 이 화면이 아니라 [`db-query`](../db-query/SKILL.md) 다.

진입하기 전에 `requires:` 를 확인한다. 미충족이면 [`bootstrap`](../bootstrap/SKILL.md) 의 미충족 보고를 내고 멈춘다.

## 동작

```text
dbgate ─▶ 서버가 없으면 띄움 (터미널과 떨어진 세션)
            │ 1. 접속 목록 → DbGate 접속 파일에 맞춤 (비밀번호는 쓰지 않음)
            │ 2. k8s 포워딩 접속은 포트포워드를 함께 엶
            │ 3. 127.0.0.1 에서만 받음
          ─▶ 브라우저 탭을 엶 (Orca 터미널이면 오른쪽 탭, 이미 있으면 그 탭)
탭 닫음 ─▶ 연결 없는 상태가 10분 이어지면 서버 · 포트포워드 종료
```

| 성질 | 값 | 이유 |
|------|-----|------|
| 상주 | 하지 않는다. 연결이 없으면 `DBGATE_IDLE_SEC`(기본 600초) 뒤 끈다. | 상주 메모리를 쓰지 않는다. |
| 접속 범위 | 127.0.0.1 만 | dbgate-serve 기본값은 모든 네트워크 주소다. |
| MySQL 암호화 | SSL 사용, 인증서 검증 없음 | SSL 필수 계정이 있다. mysql 명령의 기본과 같다. |
| 읽기 전용 | 목록의 모든 접속 | 화면에서 쓰는 일은 사람이 DbGate 설정을 직접 바꿔서 한다. |
| 비밀번호 | 파일에 쓰지 않고, 서버 메모리에서 접속을 열 때만 넣는다. | DbGate 접속 파일에 남지 않는다. |
| 다시 켠 뒤 예전 탭 | 첫 화면으로 다시 연다. | DbGate 는 켤 때마다 로그인 토큰 키를 새로 만든다. |

## 명령

설치는 실행 파일을 PATH 에 연결하는 것뿐이다. 버전이 바뀌어도 `current` 경로가 따라간다.

```bash
ln -sf ~/.claude/ops-agent/current/skills/dbgate/bin/dbgate ~/.local/bin/dbgate
ln -sf ~/.claude/ops-agent/current/skills/dbgate/bin/dbgate-password ~/.local/bin/dbgate-password
```

| 요청 | 하는 일 | 누가 |
|------|---------|------|
| 「디비 오픈」 | `dbgate` | AI |
| 바로 끄기 | `dbgate stop` | AI |
| 접속 추가 · 이름 변경 · 삭제 | 접속 목록을 고친 뒤 `dbgate stop` → `dbgate` | AI. 값은 사람이 준 것과 소비 환경의 원천에서만 |
| 비밀번호 저장 | `dbgate-password` | 사람. 비밀번호는 AI 를 거치지 않는다. |

포트는 `DBGATE_PORT`(기본 3999), 유휴 확인 간격은 `DBGATE_CHECK_SEC`(기본 30초)로 바꾼다. 접속 목록을 고치면 서버를 다시 켜야 반영된다. 켜는 사이 열려 있던 탭은 `dbgate` 가 첫 화면으로 다시 연다.

## 접속 목록

자리는 `~/.claude/ops-agent/dbgate/connections.json` 이다(`DBGATE_CONNECTIONS` 로 바꾼다). 사내 자산이므로 이 레포에 두지 않고, 소비 환경이 자기 저장소의 파일을 이 자리에 연결한다.

배열 하나이고 항목 하나가 접속 하나다.

| 칸 | 필수 | 담는 것 |
|----|------|---------|
| `id` | ○ | 바뀌지 않는 식별자. DbGate 접속 id 가 된다. |
| `label` | ○ | 화면 이름. 환경을 앞에 붙인다: `[alpha] orders` |
| `folder` | | `프로젝트 / 환경`. 폴더는 프로젝트만 쓴다(DbGate 폴더는 한 단계). |
| `engine` | ○ | `mysql` · `redis` |
| `server` · `port` | ○ | 접속 주소. 터널을 쓰면 터널 안쪽에서 본 주소 |
| `user` | | 계정. 비우면 `userCommand` 출력 |
| `database` | | 기본 스키마 |
| `separator` | | Redis 키 트리 구분자 |
| `keychain` | | 비밀번호를 담은 macOS 키체인 항목 이름. `dbgate-password` 가 만든다. |
| `userCommand` · `passwordCommand` | | 계정 · 비밀번호를 출력하는 셸 명령. 소비 환경의 비밀값 저장소를 잇는 자리 |
| `ssh` | | `{login, host, port, keyfile}`. DbGate 가 SSH 터널을 연다. |
| `forward` | | `{context, namespace, podPrefix, remotePort, localPort}`. 서버와 함께 k8s 포트포워드를 연다. |
| `local` | | 로컬에서 도는 DB. 「포워딩 필요」 표시를 하지 않는다. |
| `removed` | | 지운 접속. 가져오기가 다시 넣지 않도록 남겨 두고 화면에서는 뺀다. |

비밀번호는 `keychain` → `passwordCommand` 순서로 찾는다. `passwordCommand` 는 `userCommand` 계정의 비밀번호라, `user` 를 따로 적은 접속이 다른 계정이면 쓰지 않는다. `userCommand` 없이 `user` 만 있으면 그 `user` 의 비밀번호로 본다. 둘 다 없으면 접속할 때 화면이 묻는다.

이름 뒤 표시는 목록에서 정해진다: `ssh` → ` · SSH 터널`, `forward` → ` · k8s 포워딩`, 주소가 localhost 이고 `local` 이 아니면 ` · 포워딩 필요`.

## 소비 환경이 채우는 것

| 무엇 | 왜 여기 없는가 |
|------|----------------|
| 접속 목록의 내용 | 접속 주소는 그 조직의 자산이다. |
| `userCommand` · `passwordCommand` 가 부르는 저장소 | 비밀값 저장 방식은 환경마다 다르다. |
| 키체인 항목의 값 | 사람이 `dbgate-password` 로 넣는다. |
