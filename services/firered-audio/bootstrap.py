"""Install the FireRedAudio runtime on the second 5090 (shared with YuE2).

Idempotent: every step skips itself when its output already exists. Uses uv so the
official py3.10/cu128 dependency set stays intact; uv fetches a managed CPython 3.10
(set UV_PYTHON_INSTALL_MIRROR for a domestic mirror if github is slow).

Weights land in AUDIO_STUDIO_ROOT/models/{FireRedAudio,RedAE_decoder} via modelscope
(~29.6GB total; verify sizes on the cubefs volume after download).
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(os.environ.get("AUDIO_STUDIO_ROOT", "/project/daixinliang/audio-studio"))
RUNTIME = Path(os.environ.get("AUDIO_STUDIO_RUNTIME", "/var/tmp/audio-studio"))
CODE = RUNTIME / "firered/FireRedAudio"
ENV = RUNTIME / "firered-env"
BASE_PYTHON = Path(os.environ.get("FIRERED_BASE_PYTHON", "/var/tmp/first-yin/env/bin/python"))
REPO_URL = "https://github.com/FireRedTeam/FireRedAudio"
MODEL_DIR = ROOT / "models/FireRedAudio"
DECODER = ROOT / "models/RedAE_decoder/model.pt"


def run(command, **kwargs):
    print("+ " + " ".join(str(item) for item in command), flush=True)
    subprocess.run([str(item) for item in command], check=True, **kwargs)


def ensure_uv():
    probe = shutil.which("uv")
    if probe:
        return probe
    run([BASE_PYTHON, "-m", "pip", "install", "uv"])
    return str(BASE_PYTHON.parent / "uv")


def main():
    if not BASE_PYTHON.is_file():
        raise SystemExit(f"基础 Python 不存在：{BASE_PYTHON}；请用 FIRERED_BASE_PYTHON 指定")
    uv = ensure_uv()
    for relative in ("models", "jobs", "recover", "inputs", "outputs/firered"):
        (ROOT / relative).mkdir(parents=True, exist_ok=True)
    for relative in ("firered", "cache/cuda", "cache/triton", "cache/torchinductor", "tmp"):
        (RUNTIME / relative).mkdir(parents=True, exist_ok=True)

    if not (CODE / "inference.py").is_file():
        run(["git", "clone", "--depth", "1", REPO_URL, CODE])
    if not (ENV / "bin/python").is_file():
        # pyproject targets py3.10 + cu128; uv downloads the interpreter itself.
        run([uv, "venv", str(ENV), "--python", "3.10"])

    # The repo's uv project binds to UV_PROJECT_ENVIRONMENT so extras land in our env.
    # accel-build (causal-conv1d / flash-attn) is skipped: this machine's nvcc is CUDA 13.0
    # while the official lock pins torch cu128, so source builds fail on mismatch; the
    # flash-linear-attention fallback keeps inference working. Revisit when a cu130 /
    # prebuilt sm_120 wheel is available.
    env = dict(os.environ, UV_PROJECT_ENVIRONMENT=str(ENV))
    run([uv, "sync", "--extra", "accel", "--group", "tools"], cwd=CODE, env=env)
    # Service deps + torchcodec's dlopen needs (npp libs) live outside the repo lock.
    run([uv, "pip", "install", "--python", str(ENV / "bin/python"), "fastapi", "uvicorn", "nvidia-npp-cu12"])

    if not (MODEL_DIR / "config.json").is_file() or not DECODER.is_file():
        run([uv, "pip", "install", "--python", str(ENV / "bin/python"), "modelscope"])
        # modelscope has no __main__; use the console entry point.
        run([ENV / "bin/modelscope", "download", "--model", "FireRedTeam/FireRedAudio",
             "--local_dir", str(ROOT / "models")])
    missing = [name for name, present in (("主模型", (MODEL_DIR / "config.json").is_file()), ("RedAE 解码器", DECODER.is_file())) if not present]
    if missing:
        raise SystemExit("权重下载不完整：" + "、".join(missing))

    if not shutil.which("ffmpeg") and not (RUNTIME / "ffmpeg/bin/ffmpeg").is_file():
        raise SystemExit("未找到 ffmpeg；请安装（apt install ffmpeg 或放入 $AUDIO_STUDIO_RUNTIME/ffmpeg/bin）")

    token = ROOT / "recover/firered-api.token"
    if not token.is_file():
        import secrets
        token.write_text(secrets.token_urlsafe(32) + "\n", encoding="utf-8")
        token.chmod(0o600)
    print("FireRedAudio runtime ready: " + str(ENV / "bin/python"))


if __name__ == "__main__":
    main()
