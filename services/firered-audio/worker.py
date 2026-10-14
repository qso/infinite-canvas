#!/usr/bin/env python
"""Run one FireRedAudio task in a fresh process (api.py spawns us per task).

argv: worker.py <task.json> <workdir> [--primary <path>] [--understand <json list>]

Stages are printed as {"stage": ...} JSON lines on stdout; the final result is
written to <workdir>/result.json. Loading 21-30GB of weights from the page cache
takes tens of seconds; that is the price of exclusive per-task VRAM on the shared
5090 (YuE2 unloads between its jobs the same way).
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(os.environ.get("AUDIO_STUDIO_ROOT", "/project/daixinliang/audio-studio"))
MODEL_PATH = ROOT / "models/FireRedAudio"
DECODER_PATH = ROOT / "models/RedAE_decoder/model.pt"
MAX_MINUTES = float(os.environ.get("FIRERED_MAX_MINUTES", "10"))


def stage(name):
    print(json.dumps({"stage": name}), flush=True)


def transcode_to_wav(source: Path, target: Path):
    """Any container ffmpeg reads -> 24kHz mono wav; enforces the task's duration cap."""
    command = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(source), "-t", str(int(MAX_MINUTES * 60)),
               "-ar", "24000", "-ac", "1", str(target)]
    subprocess.run(command, check=True)
    return target


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("task_file", type=Path)
    parser.add_argument("workdir", type=Path)
    parser.add_argument("--primary", type=Path, default=None)
    parser.add_argument("--understand", type=str, default="[]")
    args = parser.parse_args()
    task = json.loads(args.task_file.read_text(encoding="utf-8"))
    workdir = args.workdir
    primary = args.primary
    understand_inputs = [Path(item) for item in json.loads(args.understand)]
    workdir.mkdir(parents=True, exist_ok=True)
    kind = task["type"]

    # ffmpeg first: cheap, and a bad upload fails before the model ever loads.
    stage("transcoding")
    if kind in ("tts", "edit", "edit_acoustic") and primary:
        primary = transcode_to_wav(primary, workdir / "input.wav")
    understand_inputs = [transcode_to_wav(item, workdir / f"audio-{index}.wav")
                         for index, item in enumerate(understand_inputs)]

    stage("loading_model")
    code_dir = os.environ.get("FIRERED_CODE_DIR")
    if code_dir:
        sys.path.insert(0, code_dir)
    from inference import FireRedAudioInference, set_seed  # noqa: E402
    from fireredaudio.utils.audio import GENERATION_SAMPLE_RATE  # noqa: E402
    import torch  # noqa: E402
    import torchaudio  # noqa: E402

    if task.get("seed") is not None:
        set_seed(int(task["seed"]))
    needs_decoder = kind in ("tts", "edit", "edit_acoustic")
    engine = FireRedAudioInference(
        model_path=str(MODEL_PATH),
        vae_decoder_path=str(DECODER_PATH) if needs_decoder else None,
        device="cuda:0",
    )

    def save_audio(result, name="audio.wav"):
        output = workdir / name
        torchaudio.save(str(output), result.audio.cpu(), sample_rate=GENERATION_SAMPLE_RATE)
        return output

    if kind in ("asr", "understand"):
        stage("reasoning")
        prompt = task.get("prompt") or "Transcribe speech to text."
        response = engine.understand([str(path) for path in understand_inputs], prompt,
                                     task="asr" if kind == "asr" else "understand",
                                     enable_thinking=bool(task.get("thinking")), max_new_tokens=4096)
        result = {"text": response.answer, "reasoning": response.reasoning}
    elif kind == "tts":
        if task.get("mode") == "design":
            stage("synthesizing")
            response = engine.voice_design(instruction=task["voice_description"], text=task["text"])
        else:
            transcript = (task.get("prompt_transcript") or "").strip()
            if not transcript:
                # The model transcribes its own cloning reference; no extra round trip.
                stage("transcribing_reference")
                transcript = engine.understand(str(primary), "Transcribe speech to text.", task="asr").answer.strip()
                if not transcript:
                    raise RuntimeError("参考音频转写为空，无法克隆；请更换参考音频")
            stage("synthesizing")
            response = engine.tts(prompt_text=transcript, prompt_audio=str(primary),
                                  target_text=task["text"], language=task.get("language", "zh"))
        stage("saving")
        output = save_audio(response)
        result = audio_result(output, {"used_transcript": task.get("prompt_transcript") or None})
    elif kind == "edit":
        stage("synthesizing")
        response = engine.edit(str(primary), task["instruction"], edit_type="semantic")
        stage("saving")
        output = save_audio(response)
        result = audio_result(output, {"edited_text": response.text})
    elif kind == "edit_acoustic":
        # Fixed trained templates; one parameter per edit, chained in-process.
        chain = []
        if task.get("pitch") is not None and task["pitch"] != 0:
            pitch = int(task["pitch"])
            # Trained template: signed N, e.g. "shift the pitch by -3 steps".
            chain.append(f"shift the pitch by {pitch} step{'s' if abs(pitch) != 1 else ''}")
        if task.get("speed") is not None:
            chain.append(f"adjust the speed to {float(task['speed']):.1f}")
        if task.get("volume") is not None:
            chain.append(f"adjust the volume to {float(task['volume']):.1f}")
        if not chain:
            raise RuntimeError("没有需要执行的声学调整")
        source = primary
        for index, instruction in enumerate(chain):
            stage("synthesizing")
            response = engine.edit(str(source), instruction, edit_type="acoustic")
            stage("saving")
            source = save_audio(response, f"audio-{index}.wav")
        output = source
        result = audio_result(output, {"applied": chain})
    else:
        raise RuntimeError("未知任务类型：" + str(kind))

    (workdir / "result.json").write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    del engine
    torch.cuda.empty_cache()


def audio_result(output: Path, extra: dict) -> dict:
    # Stdlib wave reader: torchaudio.info drags in backend libs that may not resolve here.
    frames, sample_rate = None, None
    try:
        import wave
        with output.open("rb") as stream:
            frames, sample_rate = stream.getnframes(), stream.getframerate()
    except Exception:
        pass
    duration_ms = round(frames / sample_rate * 1000) if frames and sample_rate else None
    return {"mime_type": "audio/wav", "sample_rate": sample_rate, "duration_ms": duration_ms,
            "bytes": output.stat().st_size, "audio": output.name, **extra}


if __name__ == "__main__":
    main()
