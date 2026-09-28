---
name: transcribe
description: 녹음 파일에서 대화록 원문을 추출한다. 타임스탬프가 붙은 .vtt 와 평문 .txt, 화자 턴이 붙은 .speakers.txt 를 남기고 해석·요약은 하지 않는다. 트리거 "녹음", "대화록", "녹취", "받아쓰기", "원문 추출", "transcribe".
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
  - kind: command
    name: uv
    check: command -v uv
    install: brew install uv
    why: 3단계 화자 분리. 스크립트 의존(sherpa-onnx)을 uv 가 받는다
  - kind: command
    name: 화자 분리 모델 (pyannote segmentation-3.0 · CAM++)
    check: test -f "${DIARIZE_MODEL_DIR:-$HOME/.cache/sherpa-diarization}/sherpa-onnx-pyannote-segmentation-3-0/model.onnx" && test -f "${DIARIZE_MODEL_DIR:-$HOME/.cache/sherpa-diarization}/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"
    install: D=~/.cache/sherpa-diarization && mkdir -p $D && curl -L https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2 | tar xj -C $D && curl -L -o $D/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx
    why: 3단계 화자 분리. 경로는 DIARIZE_MODEL_DIR 로 바꾼다
---

# 대화록 원문 추출

녹음 파일 하나를 받아 대화록 원문을 남긴다. 추출까지만 하고 해석은 하지 않는다.

진입하기 전에 `requires:` 를 확인한다. 미충족이면 [`bootstrap`](../bootstrap/SKILL.md) 의 미충족 보고를 내고 멈춘다.

## 경계

| 이 스킬 | 소비 프로젝트 |
|---------|---------------|
| 음성 → 원문 `.vtt` · `.txt` | 회의록 가공 · 요약 · 결정 추출 |
| 받아쓴 그대로의 원문 | 용어 교정 (도메인 · 제품명 · 사람 이름) |
| 화자 번호 (`화자00` …) | 번호 → 이름 대응 |

어떤 회의인지에 따라 알아야 할 용어와 업무가 다르다. 추출은 어느 회의에나 같고, 이해는 회의마다 다르다.

음성은 외부 서비스로 보내지 않는다. 회의 녹음에는 공개하지 않을 내용이 섞인다.

## 실행

```bash
MODEL="${WHISPER_MODEL:-$HOME/.cache/whisper-models/ggml-large-v3-turbo.bin}"
ffmpeg -y -i <원본> -ar 16000 -ac 1 -c:a pcm_s16le <이름>.wav
whisper-cli -m "$MODEL" -f <이름>.wav -l ko -mc 0 -t 2 -otxt -ovtt -of <출력경로>/<이름> -pp
uv run ~/.claude/ops-agent/current/skills/transcribe/diarize.py <이름>.wav <출력경로>/<이름>.vtt <화자 수> <출력경로>/<이름>.speakers.txt
```

| 단계 | 산출 |
|------|------|
| 1. 변환 | 16kHz 모노 wav. whisper 입력 규격이다 |
| 2. 추출 | `<이름>.vtt` (타임스탬프) · `<이름>.txt` (평문). `-mc 0` 은 앞 구간 문장을 문맥으로 이어받지 않게 한다 |
| 3. 화자 분리 | `<이름>.speakers.txt`. 원문 큐마다 시간이 가장 많이 겹치는 화자를 붙이고 `[시각] 화자NN:` 턴으로 묶는다. 화자별 발화 시간을 출력한다 |
| 4. 정리 | 중간 wav 를 지운다. 음성 원본은 옮기거나 지우지 않는다 |

출력 경로는 소비 프로젝트가 정한다. 정하지 않았으면 원본 옆에 둔다. Apple Silicon 기준 98분 녹음에 추출 약 5분, 화자 분리 약 12분 걸린다. 다른 기기에서는 몇 배 느려진다.

**화자 수는 실행 전에 묻는다.** 참석자 수에서 말하지 않은 사람을 뺀 값이다. 모르면 참석자 수를 넣는다.

길면 백그라운드로 실행하고 끝나면 알린다. 기다리는 동안 다른 일을 막지 않는다.

## 자원

다른 작업과 같은 기기에서 실행된다. 기기 전체를 점유하지 않는다.

| 규칙 | 근거 (12코어 Apple Silicon, 3분 구간) |
|------|------|
| 받아쓰기는 `-t 2` | 추론은 GPU 가 한다. 스레드 4 와 2 의 소요가 같고(10초 · 9초) CPU 평균은 20% 아래다 |
| 화자 분리는 스레드 2 (`diarize.py` 고정) | CPU 로만 실행되고 코어 2개(200%)를 채운다. 스레드 8 로 둘을 겹치면 기기 전체가 찼다 |
| 한 번에 하나만 | 추출 · 분리 · 다른 녹음 처리를 겹쳐 띄우지 않는다 |

다른 작업이 무거우면 명령 앞에 `taskpolicy -b` 를 붙여 효율 코어로 보낸다. 화자 분리가 5.5배 느려지므로(16초 → 88초) 기본값으로 두지 않는다.

## 원문을 고치지 않는다

추출 결과에는 받아쓰기 오류가 섞이고, 화자 번호는 모델의 추정이다. 그 파일은 그대로 두고, 교정 · 해석은 별도 파일에 쓴다. 원문을 고치면 무엇이 들렸고 무엇을 추정했는지 나중에 구분되지 않는다.

## 옵션 근거

98분 회의 녹음 1건으로 측정했다 (#532).

| 조건 | 반복 루프 | 원문이 빈 구간 | 소요 |
|------|-----------|----------------|------|
| 기본 옵션 | 1,619초 | 24분 | 420초 |
| `-mc 0` | 21초 | 0분 | 276초 |

앞 문장을 이어받으면 한 번 생긴 반복이 뒤 구간으로 번져 원문이 비고, `-mc 0` 은 그 전파를 끊는다.

`--prompt` 로 용어 목록을 넘기는 것은 쓰지 않는다. `-mc 0` 과 함께 쓰면 출력이 바뀌지 않고, 기본 옵션과 함께 쓰면 용어는 나아지지 않고 반복 루프가 새로 생겼다. 용어 교정은 원문을 읽는 소비 프로젝트가 자기 용어집으로 한다.

### 화자 분리

같은 녹음(참석 6명 · 발화자 5명)으로 임베딩 모델 둘을 비교했다 (#540). 분할 모델은 둘 다 pyannote segmentation-3.0 이다.

| 조건 | 소요 | 결과 |
|------|------|------|
| CAM++ zh_en, 화자 수 자동 | 784초 | 485명으로 과분할 |
| **CAM++ zh_en, 화자 수 고정** | **744초** | **발화자 5명이 참석자 확인으로 모두 대응** |
| WeSpeaker VoxCeleb, 화자 수 고정 | 1,850초 | 한 화자에 72분을 몰아 세 사람을 구분하지 못함 |

한국어로 학습한 임베딩 모델이 없어 중국어·영어 모델 가운데 한국어에서 구분되는 것을 골랐다. 알려진 한계는 셋이다.

- 여러 사람의 짧은 맞장구가 한 화자로 묶인다
- 한 턴 안에 다른 사람의 짧은 응답이 섞인다
- 받아쓰기 엔진이 조용한 구간에 만든 반복 문장이 가까운 화자에게 붙는다

번호와 이름의 대응은 발화 문맥으로 사람이 한다. 화자별 대표 발화를 앞뒤와 함께 보이면 음성을 다시 듣는 것보다 빠르다.

VAD(무음 구간 건너뛰기)는 쓰지 않는다. 회의실 녹음 3분 구간에서 받아쓴 글자가 581자에서 217자로 줄었다. 마이크에서 먼 사람의 작은 발화를 비발화로 판정한다 (#532).
