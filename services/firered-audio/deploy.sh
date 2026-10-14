#!/usr/bin/env bash
set -euo pipefail
root="${AUDIO_STUDIO_ROOT:-/project/daixinliang/audio-studio}"
runtime="${AUDIO_STUDIO_RUNTIME:-/var/tmp/audio-studio}"
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
python="${FIRERED_BASE_PYTHON:-${YUE2_BASE_PYTHON:-/var/tmp/first-yin/env/bin/python}}"
mkdir -p "$root/services/firered-audio" "$root/recover" "$runtime"
chmod 700 "$root"
if [[ "$source_dir" != "$root/services/firered-audio" ]]; then
    for file in api.py worker.py bootstrap.py start.sh deploy.sh; do
        cp "$source_dir/$file" "$root/services/firered-audio/$file"
    done
fi
export AUDIO_STUDIO_ROOT="$root" AUDIO_STUDIO_RUNTIME="$runtime" FIRERED_BASE_PYTHON="$python"
"$python" "$root/services/firered-audio/bootstrap.py"
chmod 700 "$root/recover"
setsid bash "$root/services/firered-audio/start.sh" </dev/null >>"$runtime/firered-api.log" 2>&1 &
