# /// script
# requires-python = ">=3.10"
# dependencies = ["sherpa-onnx==1.13.8", "soundfile", "numpy"]
# ///
"""화자 분리: wav(16k mono) + 원문 vtt → 화자 턴이 붙은 txt

사용: uv run diarize.py <wav> <vtt> <화자수> <out.txt>
화자 수는 말한 사람 수다. 자동 판별은 한국어에서 과분할한다 (#540).
"""
import os
import re
import sys

import sherpa_onnx
import soundfile as sf

wav, vtt, n, out = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
d = os.environ.get("DIARIZE_MODEL_DIR", os.path.expanduser("~/.cache/sherpa-diarization"))

cfg = sherpa_onnx.OfflineSpeakerDiarizationConfig(
    segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
        pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
            model=f"{d}/sherpa-onnx-pyannote-segmentation-3-0/model.onnx"),
        num_threads=2,  # 스레드 8 은 기기 전체를 점유했다
    ),
    embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(
        model=f"{d}/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx", num_threads=2),
    clustering=sherpa_onnx.FastClusteringConfig(num_clusters=n),
    min_duration_on=0.3,
    min_duration_off=0.5,
)
assert cfg.validate(), "모델 경로를 확인한다"
sd = sherpa_onnx.OfflineSpeakerDiarization(cfg)
audio, sr = sf.read(wav, dtype="float32", always_2d=True)
assert sr == sd.sample_rate, (sr, sd.sample_rate)
segs = [(r.start, r.end, f"{r.speaker:02d}") for r in sd.process(audio[:, 0]).sort_by_start_time()]


def ts(s):
    h, m, sec = s.split(":")
    return int(h) * 3600 + int(m) * 60 + float(sec)


def speaker_for(s, e):
    # 겹침이 가장 큰 화자, 겹침이 없으면 가장 가까운 구간의 화자
    best, ov = None, 0.0
    for a, b, spk in segs:
        o = min(e, b) - max(s, a)
        if o > ov:
            best, ov = spk, o
    return best or min(segs, key=lambda x: min(abs(x[0] - e), abs(x[1] - s)))[2]


lines, prev = [], None
for blk in open(vtt, encoding="utf-8").read().split("\n\n"):
    m = re.search(r"(\d\d:\d\d:\d\d\.\d+) --> (\d\d:\d\d:\d\d\.\d+)", blk)
    text = blk.strip().split("\n")[-1].strip()
    if not m or not text:
        continue
    s, e = ts(m[1]), ts(m[2])
    spk = speaker_for(s, e)
    if spk != prev:
        lines.append(f"\n[{int(s // 3600):02d}:{int(s % 3600 // 60):02d}:{int(s % 60):02d}] 화자{spk}:")
        prev = spk
    lines.append(f"  {text}")
open(out, "w", encoding="utf-8").write("\n".join(lines).lstrip() + "\n")

total = {}
for a, b, spk in segs:
    total[spk] = total.get(spk, 0) + b - a
for spk, t in sorted(total.items(), key=lambda x: -x[1]):
    print(f"화자{spk} {t / 60:.1f}분")
