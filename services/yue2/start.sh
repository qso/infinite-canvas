#!/usr/bin/env bash
set -euo pipefail
export AUDIO_STUDIO_ROOT="${AUDIO_STUDIO_ROOT:-/project/daixinliang/audio-studio}"
export AUDIO_STUDIO_RUNTIME="${AUDIO_STUDIO_RUNTIME:-/var/tmp/audio-studio}"
export PYTHONNOUSERSITE=1
export TORCH_DEVICE_BACKEND_AUTOLOAD=0
unset PYTHONPATH PYTHONHOME
export HF_HUB_OFFLINE=1
export CUDA_CACHE_PATH="$AUDIO_STUDIO_RUNTIME/cache/cuda"
export TRITON_CACHE_DIR="$AUDIO_STUDIO_RUNTIME/cache/triton"
export TORCHINDUCTOR_CACHE_DIR="$AUDIO_STUDIO_RUNTIME/cache/torchinductor"
export TMPDIR="$AUDIO_STUDIO_RUNTIME/tmp"
mkdir -p "$TMPDIR" "$CUDA_CACHE_PATH" "$TRITON_CACHE_DIR" "$TORCHINDUCTOR_CACHE_DIR" "$AUDIO_STUDIO_RUNTIME/service"
if [[ ! -x "$AUDIO_STUDIO_RUNTIME/env/bin/python" ]]; then
    printf 'YuE2 runtime missing; restore the saved runtime archive or run bootstrap.py with Python 3.13.\n' >&2
    exit 1
fi
cp "$AUDIO_STUDIO_ROOT/services/yue2/api.py" "$AUDIO_STUDIO_RUNTIME/service/api.py"
exec "$AUDIO_STUDIO_RUNTIME/env/bin/python" -m uvicorn api:app --app-dir "$AUDIO_STUDIO_RUNTIME/service" --host 127.0.0.1 --port 8190 --no-access-log
