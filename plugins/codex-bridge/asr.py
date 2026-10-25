# 「听视频」工具用：本地 whisper 把一段音频转成带时间的文字，结果以 JSON 打到 stdout。
# 用法：python -I asr.py <音频文件> [模型名，默认 small]
import json
import sys

sys.stdout.reconfigure(encoding="utf-8")

import whisper  # noqa: E402

audio = sys.argv[1]
model = whisper.load_model(sys.argv[2] if len(sys.argv) > 2 else "small")
# 先认语种：中文给个简体提示（不给的话常出繁体），别的语种原样转
mel = whisper.log_mel_spectrogram(whisper.pad_or_trim(whisper.load_audio(audio))).to(model.device)
_, probs = model.detect_language(mel)
lang = max(probs, key=probs.get)
result = model.transcribe(
    audio,
    language=lang,
    fp16=False,
    condition_on_previous_text=False,
    initial_prompt="以下是普通话的句子。" if lang == "zh" else None,
)
print(json.dumps({
    "language": lang,
    "segments": [{"s": round(s["start"], 1), "e": round(s["end"], 1), "t": s["text"].strip()} for s in result["segments"]],
}, ensure_ascii=False))
