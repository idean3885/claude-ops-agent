---
name: transcribe
description: 녹음 파일에서 대화록 원문을 추출한다. 타임스탬프가 붙은 .vtt 와 평문 .txt 를 남기고 해석·요약은 하지 않는다. 트리거 "녹음", "대화록", "녹취", "받아쓰기", "원문 추출", "transcribe".
trigger: ["녹음", "대화록", "녹취", "받아쓰기", "원문 추출", "transcribe"]
requires:
  - kind: command
    name: ffmpeg
    check: command -v ffmpeg
    install: brew install ffmpeg
    why: 1단계 음성 변환
  - kind: command
    name: whisper-cli
    check: command -v whisper-cli
    install: brew install whisper-cpp
    why: 2단계 추출
  - kind: command
    name: 모델 파일 ggml-large-v3-turbo.bin
    check: test -f "${WHISPER_MODEL:-$HOME/.cache/whisper-models/ggml-large-v3-turbo.bin}"
    install: mkdir -p ~/.cache/whisper-models && curl -L -o ~/.cache/whisper-models/ggml-large-v3-turbo.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
    why: 2단계 추출. 경로는 WHISPER_MODEL 로 바꾼다
---

# 대화록 원문 추출

녹음 파일 하나를 받아 대화록 원문을 남긴다. 추출까지만 하고 해석은 하지 않는다.

진입하기 전에 `requires:` 를 확인한다. 미충족이면 [`bootstrap`](../bootstrap/SKILL.md) 의 미충족 보고를 내고 멈춘다.

## 경계

| 이 스킬 | 소비 프로젝트 |
|---------|---------------|
| 음성 → 원문 `.vtt` · `.txt` | 회의록 가공 · 요약 · 결정 추출 |
| 용어 목록을 받는 입력 자리 | 용어 목록 자체 (도메인 · 제품명 · 사람 이름) |

어떤 회의인지에 따라 알아야 할 용어와 업무가 다르다. 추출은 어느 회의에나 같고, 이해는 회의마다 다르다.

음성은 외부 서비스로 보내지 않는다. 회의 녹음에는 공개하지 않을 내용이 섞인다.

## 실행

```bash
MODEL="${WHISPER_MODEL:-$HOME/.cache/whisper-models/ggml-large-v3-turbo.bin}"
ffmpeg -y -i <원본> -ar 16000 -ac 1 -c:a pcm_s16le <이름>.wav
whisper-cli -m "$MODEL" -f <이름>.wav -l ko -otxt -ovtt -of <출력경로>/<이름> -pp [--prompt "<용어 목록>"]
```

| 단계 | 산출 |
|------|------|
| 1. 변환 | 16kHz 모노 wav. whisper 입력 규격이다 |
| 2. 추출 | `<이름>.vtt` (타임스탬프) · `<이름>.txt` (평문) |
| 3. 정리 | 중간 wav 를 지운다. 음성 원본은 옮기거나 지우지 않는다 |

출력 경로는 소비 프로젝트가 정한다. 정하지 않았으면 원본 옆에 둔다. Apple Silicon 기준 51분 녹음에 약 9분 걸린다. 다른 기기에서는 몇 배 느려진다.

길면 백그라운드로 실행하고 끝나면 알린다. 기다리는 동안 다른 일을 막지 않는다.

## 원문을 고치지 않는다

추출 결과는 화자 구분이 없고 받아쓰기 오류가 섞인다. 그 파일은 그대로 두고, 교정 · 해석은 별도 파일에 쓴다. 원문을 고치면 무엇이 들렸고 무엇을 추정했는지 나중에 구분되지 않는다.

## 정확도를 올리는 입력 (권장)

넘기지 않아도 끝까지 실행된다. 넘기면 틀리는 곳이 줄어든다.

| 입력 | 효과 | 어디서 오는가 |
|------|------|---------------|
| `--prompt "<용어 목록>"` | 고유명사 · 약어 · 영어가 섞인 기술 용어의 오인식이 줄어든다 | 소비 프로젝트의 용어집 · 참석자 이름 · 안건 |

용어 목록은 쉼표로 이어 쓴 짧은 문장으로 둔다. 길면 잘린다 (`n_text_ctx/2` 토큰).

소비 프로젝트에 용어집이 있으면 호출자는 그것을 먼저 찾아 넘긴다. 없으면 없이 실행하고, 결과에서 반복해 틀린 단어를 용어집 후보로 보고한다.
