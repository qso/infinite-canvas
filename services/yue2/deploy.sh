#!/usr/bin/env bash
set -euo pipefail
root="${AUDIO_STUDIO_ROOT:-/project/daixinliang/audio-studio}"
runtime="${AUDIO_STUDIO_RUNTIME:-/var/tmp/audio-studio}"
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
python="${YUE2_BASE_PYTHON:-/var/tmp/first-yin/env/bin/python}"
mkdir -p "$root/services/yue2" "$root/recover" "$runtime"
chmod 700 "$root"
if [[ "$source_dir" != "$root/services/yue2" ]]; then
    for file in api.py requirements.txt bootstrap.py start.sh recover.sh deploy.sh reference_worker.py bootstrap-reference.py requirements-sheetsage.txt requirements-flamingo.txt; do
        cp "$source_dir/$file" "$root/services/yue2/$file"
    done
    mkdir -p "$root/services/yue2/instrumental"
    for file in instrumentalize.py abc_tools.py compile_score.py common.py LICENSE; do
        cp "$source_dir/instrumental/$file" "$root/services/yue2/instrumental/$file"
    done
fi
if [[ ! -e "$root/recover/yue2-api.token" ]]; then
    "$python" -c 'from pathlib import Path; import os,secrets,sys; p=Path(sys.argv[1]); fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600); os.write(fd,(secrets.token_urlsafe(32)+"\n").encode()); os.close(fd)' "$root/recover/yue2-api.token"
fi
chmod 700 "$root/recover"
export AUDIO_STUDIO_ROOT="$root" AUDIO_STUDIO_RUNTIME="$runtime"
"$python" "$root/services/yue2/bootstrap.py"
setsid bash "$root/services/yue2/start.sh" </dev/null >>"$runtime/api.log" 2>&1 &
