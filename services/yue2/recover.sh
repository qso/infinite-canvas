#!/usr/bin/env bash
set -euo pipefail
root="${AUDIO_STUDIO_ROOT:-/project/daixinliang/audio-studio}"
runtime="${AUDIO_STUDIO_RUNTIME:-/var/tmp/audio-studio}"
archive="$root/recover/runtime.tar.gz"
if [[ "${1:-}" == "snapshot" ]]; then
    if [[ -e "$archive" ]]; then
        printf 'Snapshot already exists; preserve it before creating a replacement.\n' >&2
        exit 1
    fi
    # The venv depends on first-yin's interpreter and libraries; include the base too.
    tar -czf "$runtime/runtime.tar.gz" --exclude='first-yin/env/pkgs' --exclude='first-yin/env/conda-bld' -C /var/tmp audio-studio/env first-yin/env first-yin/node first-yin/cuda-13.0
    cp "$runtime/runtime.tar.gz" "$archive.copying"
    sha256sum "$runtime/runtime.tar.gz" | cut -d ' ' -f 1 > "$archive.sha256"
    sleep 30
    actual="$(sha256sum "$archive.copying" | cut -d ' ' -f 1)"
    [[ "$actual" == "$(tr -d '\n' < "$archive.sha256")" ]]
    mv "$archive.copying" "$archive"
elif [[ "${1:-}" == "restore" ]]; then
    for target in "$runtime/env" /var/tmp/first-yin/env /var/tmp/first-yin/node /var/tmp/first-yin/cuda-13.0; do
        if [[ -e "$target" ]]; then
            printf 'Refusing to overwrite existing runtime: %s\n' "$target" >&2
            exit 1
        fi
    done
    actual="$(sha256sum "$archive" | cut -d ' ' -f 1)"
    [[ "$actual" == "$(tr -d '\n' < "$archive.sha256")" ]]
    tar -xzf "$archive" -C /var/tmp
else
    printf 'Usage: bash recover.sh snapshot|restore\n' >&2
    exit 1
fi
