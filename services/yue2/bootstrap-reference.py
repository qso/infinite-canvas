import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path(os.environ.get("AUDIO_STUDIO_ROOT", "/project/daixinliang/audio-studio"))
RUNTIME = Path(os.environ.get("AUDIO_STUDIO_RUNTIME", "/var/tmp/audio-studio"))
SOURCE = Path(__file__).resolve().parent
HUB = os.environ.get("HF_ENDPOINT", "https://hf-mirror.com").rstrip("/")
INDEX = os.environ.get("PIP_INDEX_URL", "https://pypi.tuna.tsinghua.edu.cn/simple")


def run(args, **kwargs):
    print("RUN", " ".join(map(str, args)), flush=True)
    subprocess.run(list(map(str, args)), check=True, **kwargs)


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def download(url, target, expected):
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_file() and (expected is None or digest(target) == expected):
        return
    temporary = target.with_name(target.name + ".reference-download")
    aria = RUNTIME / "tools/usr/bin/aria2c"
    if aria.is_file() and expected:
        env = dict(os.environ, LD_LIBRARY_PATH=str(RUNTIME / "tools/usr/lib/x86_64-linux-gnu"))
        run([aria, "--console-log-level=warn", "--download-result=hide", "--file-allocation=none", "--max-connection-per-server=16", "--split=16", "--max-tries=1", "--allow-overwrite=true", "--auto-file-renaming=false", "--dir", target.parent, "--out", temporary.name, url], env=env)
    else:
        run(["curl", "--fail", "--silent", "--show-error", "--location", "--output", temporary, url])
    if expected and digest(temporary) != expected:
        raise RuntimeError("Downloaded file failed SHA256: " + str(target))
    temporary.replace(target)


if not ROOT.is_dir() or not RUNTIME.is_dir():
    raise RuntimeError("Install the base YuE2 service first")
for name in ("analyses", "inputs", "models"):
    (ROOT / name).mkdir(exist_ok=True)
(RUNTIME / "reference-downloads").mkdir(exist_ok=True)
env = dict(os.environ, PYTHONNOUSERSITE="1", TORCH_DEVICE_BACKEND_AUTOLOAD="0", PIP_CACHE_DIR=str(RUNTIME / "cache/pip"), TMPDIR=str(RUNTIME / "tmp"))
env.pop("PYTHONPATH", None)
env.pop("PYTHONHOME", None)

python11 = next((RUNTIME / "python").glob("cpython-3.11*/bin/python3.11"), None)
if python11 is None:
    run(["uv", "python", "install", "3.11", "--install-dir", RUNTIME / "python", "--no-bin", "--cache-dir", RUNTIME / "cache/uv"], env=env)
    python11 = next((RUNTIME / "python").glob("cpython-3.11*/bin/python3.11"))
sheetsage = RUNTIME / "sheetsage-env"
if not (sheetsage / "bin/python").is_file():
    run([python11, "-m", "venv", sheetsage], env=env)

wheels = RUNTIME / "reference-downloads"
torch = wheels / "torch-2.8.0+cu128-cp311-cp311-manylinux_2_28_x86_64.whl"
download("https://mirror.nju.edu.cn/pytorch/whl/cu128/" + torch.name.replace("+", "%2B"), torch, "039b9dcdd6bdbaa10a8a5cd6be22c4cb3e3589a341e5f904cbb571ca28f55bed")
torchaudio = wheels / "torchaudio-2.8.0+cu128-cp311-cp311-manylinux_2_28_x86_64.whl"
download("https://mirror.nju.edu.cn/pytorch/whl/cu128/" + torchaudio.name.replace("+", "%2B"), torchaudio, "f4409df567d0723a7a3a89d32c7552a17e0ff6f137ea26a0d268c665259b2995")
run([sheetsage / "bin/python", "-m", "pip", "install", torch, torchaudio, "-r", SOURCE / "requirements-sheetsage.txt", "--index-url", INDEX], env=env)
ffmpeg = RUNTIME / "ffmpeg"
if not (ffmpeg / "bin/ffmpeg").is_file():
    run(["conda", "create", "-y", "--override-channels", "-p", ffmpeg, "-c", "https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge", "ffmpeg=6.1"], env=env)

flamingo = RUNTIME / "flamingo-env"
if not (flamingo / "bin/python").is_file():
    run([sys.executable, "-m", "venv", flamingo], env=env)
run([flamingo / "bin/python", "-m", "pip", "install", RUNTIME / "downloads/torch-2.10.0+cu130-cp313-cp313-manylinux_2_28_x86_64.whl", "-r", SOURCE / "requirements-flamingo.txt", "--index-url", INDEX], env=env)

models = (
    ("m-a-p/SheetSage2", "32c7c7473e7b59e1ed36bd8a8fefbd11ae8d468a", "SheetSage2", "b235f68091a5f5b644000f2b5acb57d1e70432aca2b34ab1b9cf27236e1f4274"),
    ("m-a-p/MERT-v2-FullSong", "d8ba1c745e733b3908ce6ad16ebeb17ac7600a42", "MERT-v2-FullSong", "e6dd2ab187d6dd62b6521cd7d8f932e237acf0c5757745a7232082e28391350d"),
    ("nvidia/music-flamingo-2601-hf", "6b5be086d52f65a1e204cb0faf70bf54e2741ecd", "MusicFlamingo", "4da26452d3978503fb064023a69f7867a1f235a2a5a89d3d9146ebf2e04eb15b"),
)
for repo, revision, name, weights_hash in models:
    print("MODEL", repo, revision, flush=True)
    manifest_path = wheels / (name + "-files.json")
    download(f"{HUB}/api/models/{repo}/tree/{revision}", manifest_path, None)
    files = json.loads(manifest_path.read_text())
    folder = ROOT / "models" / name
    folder.mkdir(exist_ok=True)
    for item in files:
        filename = item["path"]
        if item["type"] != "file" or not (filename.endswith((".py", ".json", ".jinja", ".safetensors")) or filename == "LICENSE"):
            continue
        expected = weights_hash if filename == "model.safetensors" else item.get("lfs", {}).get("oid")
        target = folder / filename
        if target.is_file() and (not expected or target.stat().st_size == item["size"] and digest(target) == expected):
            continue
        staged = wheels / name / filename
        download(f"{HUB}/{repo}/resolve/{revision}/{filename}", staged, expected)
        if staged.stat().st_size != item["size"]:
            raise RuntimeError("Unexpected model size: " + filename)
        temporary = target.with_name(target.name + ".copying")
        with staged.open("rb") as source, temporary.open("wb") as output:
            shutil.copyfileobj(source, output, length=1024 * 1024)
            output.flush()
            os.fsync(output.fileno())
        temporary.replace(target)
        if expected:
            time.sleep(30)
            if target.stat().st_size != item["size"] or digest(target) != expected:
                raise RuntimeError("Persistent model integrity failed: " + name)
    (folder / "revision.txt").write_text(revision + "\n")
    (folder / "integrity.json").write_text(json.dumps({"revision": revision, "sha256": weights_hash}))

for name, python in (("sheetsage", sheetsage / "bin/python"), ("flamingo", flamingo / "bin/python")):
    with (ROOT / "recover" / (name + "-requirements-lock.txt")).open("w") as output:
        run([python, "-m", "pip", "freeze"], stdout=output, env=env)
print("Reference model runtimes and full weights installed", flush=True)
