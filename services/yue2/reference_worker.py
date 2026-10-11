import argparse
import json
import os
from pathlib import Path
import sys

parser = argparse.ArgumentParser()
parser.add_argument("operation", choices=("score", "transcribe", "describe", "lyrics"))
parser.add_argument("input")
parser.add_argument("output")
args = parser.parse_args()
ROOT = Path(os.environ.get("AUDIO_STUDIO_ROOT", "/project/daixinliang/audio-studio"))
input_path = Path(args.input)
output_path = Path(args.output)


def report(stage, **extra):
    print(json.dumps({"stage": stage, **extra}), flush=True)


def melody_only_abc(source):
    from music21 import abcFormat

    handler = abcFormat.ABCHandler()
    handler.tokenize(source)
    result, cursor = [], 0
    for token in handler.tokens:
        if not isinstance(token, abcFormat.ABCNote) or '"' not in token.src:
            continue
        start = source.find(token.src, cursor)
        if start < 0:
            raise ValueError("无法定位 ABC 音符，未修改原始乐谱")
        symbols, remaining = token._splitChordSymbols(token.src)
        result.extend((source[cursor:start], remaining))
        cursor = start + len(token.src)
    result.append(source[cursor:])
    return "".join(result)


def run():
    if args.operation == "score":
        score = input_path.read_text(encoding="utf-8")
        if not score.strip():
            raise ValueError("参考音乐没有可复用的乐谱")
        return {"abc_full": score, "abc_melody": melody_only_abc(score), "warnings": []}
    if args.operation == "transcribe":
        import torch

        sys.path.insert(0, str(ROOT / "models"))
        from SheetSage2.modeling_sheetsage2 import SheetSage2Model

        model_dir = ROOT / "models/SheetSage2"
        report("loading_transcriber")
        model = SheetSage2Model.from_pretrained(str(model_dir), local_files_only=True, base_model_path=str(ROOT / "models/MERT-v2-FullSong")).eval().to("cuda")
        result = model.transcribe(str(input_path), progress=lambda item: report("transcribing", details=item), output_dir=str(output_path.parent / "transcription"))
        full = result.get("abc")
        if not full:
            raise ValueError(result.get("abc_error") or "音频转谱没有生成有效 ABC")
        return {"abc_full": full, "abc_melody": melody_only_abc(full), "warnings": result.get("warnings", []) + result.get("diagnostics", []), "duration_seconds": result["duration_seconds"]}
    import numpy as np
    import soundfile as sf
    import subprocess
    import torch
    from transformers import AutoProcessor, MusicFlamingoForConditionalGeneration

    report("loading_listener")
    model_dir = ROOT / "models/MusicFlamingo"
    processor = AutoProcessor.from_pretrained(str(model_dir), local_files_only=True)
    model = MusicFlamingoForConditionalGeneration.from_pretrained(str(model_dir), local_files_only=True, dtype=torch.bfloat16, attn_implementation="sdpa").eval().to("cuda")
    probe = subprocess.run(["ffmpeg", "-v", "error", "-i", str(input_path), "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"], capture_output=True, check=True)
    audio = np.frombuffer(probe.stdout, dtype="<f4").copy()
    maximum = processor.max_audio_len
    if len(audio) > maximum * 16000:
        raise ValueError(f"音乐理解模型最多接收 {maximum // 60} 分钟；请选择较短的参考片段，未截断音频")
    prompt = (
        "Give a concise music-generation style prompt for this audio. Return only comma-separated descriptors for genre, instruments, mood, groove, vocal timbre, and production. Do not discuss duration, structure, lyrics, song titles, artists, exact melody or chord sequences. Do not add an introduction or explanation."
        if args.operation == "describe" else
        "Write only the intelligible sung words in their original language. Do not translate, explain, repeat filler sounds, or invent an ending. Use line breaks between phrases. Stop after the last intelligible word; instrumental passages require no output. Mark an unclear phrase [unclear]. If no intelligible words are sung, output [Instrumental]."
    )
    messages = [{"role": "user", "content": [{"type": "audio", "audio": audio}, {"type": "text", "text": prompt}]}]
    text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    inputs = processor(text=[text], audio=[audio], sampling_rate=16000, return_tensors="pt").to("cuda")
    inputs["input_features"] = inputs["input_features"].to(model.dtype)
    report("describing" if args.operation == "describe" else "extracting_lyrics")
    with torch.inference_mode():
        generated = model.generate(**inputs, do_sample=False, max_new_tokens=model.generation_config.max_new_tokens, repetition_penalty=1.1)
    output_tokens = generated[:, inputs["input_ids"].shape[1]:]
    content = processor.batch_decode(output_tokens, skip_special_tokens=True)[0].strip()
    if not content:
        raise ValueError("音频理解没有返回有效内容")
    warnings = []
    if output_tokens.shape[1] >= model.generation_config.max_new_tokens:
        warnings.append("分析输出达到模型 token 边界，请检查并补全内容")
    return {("style" if args.operation == "describe" else "lyrics"): content, "warnings": warnings, "duration_seconds": len(audio) / 16000}


try:
    result = run()
    temporary = output_path.with_suffix(".tmp")
    temporary.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    temporary.replace(output_path)
    report("analysis_completed")
except Exception as exc:
    print(str(exc), file=sys.stderr, flush=True)
    raise
