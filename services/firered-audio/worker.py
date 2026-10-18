#!/usr/bin/env python
"""FireRedAudio resident inference worker (serve mode; api.py is the only caller).

Protocol: one JSON task per stdin line:
    {"task_file": ..., "workdir": ..., "max_minutes": N,
     "primary": ... | null, "understand": [...]}
Answers: {"stage": ...} progress lines, then exactly one per task:
    {"task_done": {"code": 0}}                     (result in <workdir>/result.json)
    {"task_done": {"code": 1, "error": "..."}}     (traceback tail)

The engine (main model + RedAE decoder, ~21.2GiB) loads once on the first task
and stays resident across tasks. After FIRERED_IDLE_UNLOAD_SECONDS without
work (default 1800, 0 disables) it frees the GPU and reloads on the next task,
so the card is not held forever during long idle periods. stdin EOF means the
service is gone: unload and exit.
"""

import gc
import json
import os
import select
import subprocess
import sys
import time
import traceback
from pathlib import Path

ROOT = Path(os.environ.get("AUDIO_STUDIO_ROOT", "/project/daixinliang/audio-studio"))
MODEL_PATH = ROOT / "models/FireRedAudio"
DECODER_PATH = ROOT / "models/RedAE_decoder/model.pt"
IDLE_UNLOAD_SECONDS = float(os.environ.get("FIRERED_IDLE_UNLOAD_SECONDS", "1800"))

code_dir = os.environ.get("FIRERED_CODE_DIR")
if code_dir:
    sys.path.insert(0, code_dir)
import torch  # noqa: E402
import torchaudio  # noqa: E402
from inference import FireRedAudioInference, set_seed  # noqa: E402
from fireredaudio.utils.audio import GENERATION_SAMPLE_RATE  # noqa: E402

engine = None


def stage(name):
    print(json.dumps({"stage": name}), flush=True)


def finish(code, error=None):
    print(json.dumps({"task_done": {"code": code, "error": error}}), flush=True)


def transcode_to_wav(source: Path, target: Path, max_minutes: float):
    """Any container ffmpeg reads -> 24kHz mono wav; enforces the task's duration cap."""
    command = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(source), "-t", str(int(max_minutes * 60)),
               "-ar", "24000", "-ac", "1", str(target)]
    subprocess.run(command, check=True)
    return target


def get_engine():
    global engine
    if engine is None:
        stage("loading_model")
        # Always construct with the decoder: understanding tasks only pay ~1.4GiB extra,
        # and alternating task types never trigger a full engine rebuild.
        engine = FireRedAudioInference(
            model_path=str(MODEL_PATH),
            vae_decoder_path=str(DECODER_PATH),
            device="cuda:0",
        )
    return engine


def release_engine():
    global engine
    if engine is not None:
        engine = None
        gc.collect()
        torch.cuda.empty_cache()


def save_audio(result, workdir, name="audio.wav"):
    output = workdir / name
    torchaudio.save(str(output), result.audio.cpu(), sample_rate=GENERATION_SAMPLE_RATE)
    return output


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


def run_task(spec: dict):
    task = json.loads(Path(spec["task_file"]).read_text(encoding="utf-8"))
    workdir = Path(spec["workdir"])
    workdir.mkdir(parents=True, exist_ok=True)
    primary = Path(spec["primary"]) if spec.get("primary") else None
    understand_inputs = [Path(item) for item in spec.get("understand", [])]
    max_minutes = float(spec.get("max_minutes", 10))
    kind = task["type"]

    # ffmpeg first: cheap, and a bad upload fails before the model ever loads.
    stage("transcoding")
    if kind in ("tts", "edit", "edit_acoustic") and primary:
        primary = transcode_to_wav(primary, workdir / "input.wav", max_minutes)
    understand_inputs = [transcode_to_wav(item, workdir / f"audio-{index}.wav", max_minutes)
                         for index, item in enumerate(understand_inputs)]

    if task.get("seed") is not None:
        set_seed(int(task["seed"]))
    current = get_engine()

    if kind in ("asr", "understand"):
        stage("reasoning")
        prompt = task.get("prompt") or "Transcribe speech to text."
        response = current.understand([str(path) for path in understand_inputs], prompt,
                                      task="asr" if kind == "asr" else "understand",
                                      enable_thinking=bool(task.get("thinking")), max_new_tokens=4096)
        result = {"text": response.answer, "reasoning": response.reasoning}
    elif kind == "tts":
        if task.get("mode") == "design":
            stage("synthesizing")
            response = current.voice_design(instruction=task["voice_description"], text=task["text"])
        else:
            transcript = (task.get("prompt_transcript") or "").strip()
            if not transcript:
                # The model transcribes its own cloning reference; no extra round trip.
                stage("transcribing_reference")
                transcript = current.understand(str(primary), "Transcribe speech to text.", task="asr").answer.strip()
                if not transcript:
                    raise RuntimeError("参考音频转写为空，无法克隆；请更换参考音频")
            stage("synthesizing")
            response = current.tts(prompt_text=transcript, prompt_audio=str(primary),
                                   target_text=task["text"], language=task.get("language", "zh"))
        stage("saving")
        output = save_audio(response, workdir)
        result = audio_result(output, {"used_transcript": task.get("prompt_transcript") or None})
    elif kind == "edit":
        stage("synthesizing")
        response = current.edit(str(primary), task["instruction"], edit_type="semantic")
        stage("saving")
        output = save_audio(response, workdir)
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
            response = current.edit(str(source), instruction, edit_type="acoustic")
            stage("saving")
            source = save_audio(response, workdir, f"audio-{index}.wav")
        output = source
        result = audio_result(output, {"applied": chain})
    else:
        raise RuntimeError("未知任务类型：" + str(kind))

    (workdir / "result.json").write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    finish(0)


def serve():
    last_activity = time.time()
    while True:
        ready, _, _ = select.select([sys.stdin], [], [], 30)
        now = time.time()
        if ready:
            line = sys.stdin.readline()
            if not line:
                break
            last_activity = now
            try:
                run_task(json.loads(line))
            except Exception:
                finish(1, traceback.format_exc()[-2000:])
            # Idle is measured from the last COMPLETION, so a long task's own
            # runtime never counts toward the unload threshold.
            last_activity = time.time()
            continue
        if IDLE_UNLOAD_SECONDS > 0 and now - last_activity >= IDLE_UNLOAD_SECONDS:
            release_engine()
    release_engine()


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] != "serve":
        raise SystemExit("usage: worker.py serve  (api.py is the only caller)")
    serve()
