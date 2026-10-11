"""Install an isolated YuE2 runtime without changing the machine's existing environment."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from urllib.parse import unquote, urlparse

ROOT = Path(os.environ.get("AUDIO_STUDIO_ROOT", "/project/daixinliang/audio-studio"))
RUNTIME = Path(os.environ.get("AUDIO_STUDIO_RUNTIME", "/var/tmp/audio-studio"))
SOURCE = Path(__file__).resolve().parent
MODEL_REVISION = "8f24312f187763b9854adeec87e437e2b03bbff1"
VAE_REVISION = "152733a19ad43aa67e367f9b5503ef8075bb5126"
WHEEL = "yue2_infer-0.1.5-py3-none-any.whl"
WHEEL_HASH = "8801e2c0d969db02df78d2994150b4ccd86077d87c24fdb8509b1f6f31462641"
HUB_ENDPOINT = os.environ.get("HF_ENDPOINT", "https://huggingface.co").rstrip("/")
PYPI_INDEX = os.environ.get("PIP_INDEX_URL", "https://pypi.org/simple")
TORCH_URL = os.environ.get("YUE2_TORCH_URL", "https://download-r2.pytorch.org/whl/cu130/torch-2.10.0%2Bcu130-cp313-cp313-manylinux_2_28_x86_64.whl")
TORCH_HASH = "7e0d9922e9e91f780b2761a0c5ebac3c15c9740bab042e1b59149afa6d6474eb"


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def download(url, path, expected_hash=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_file() and (expected_hash is None or digest(path) == expected_hash):
        return
    temporary = path.with_name(path.name + ".download")
    print("Downloading " + path.name, flush=True)
    subprocess.run(["curl", "--fail", "--location", "--silent", "--show-error", "--output", str(temporary), url], check=True)
    if expected_hash is not None and digest(temporary) != expected_hash:
        raise RuntimeError("SHA256 mismatch: " + path.name)
    temporary.replace(path)


if sys.version_info[:2] != (3, 13):
    raise RuntimeError("Use the machine's verified Python 3.13 interpreter")
if not ROOT.parent.is_dir() or not os.access(ROOT.parent, os.W_OK):
    raise RuntimeError("Confirm the persistent volume and permissions before installing")
for relative in ("models", "outputs", "jobs", "recover"):
    (ROOT / relative).mkdir(parents=True, exist_ok=True)
ROOT.chmod(0o700)
for relative in ("downloads", "cache/pip", "cache/huggingface", "cache/cuda", "cache/triton", "tmp", "service"):
    (RUNTIME / relative).mkdir(parents=True, exist_ok=True)

environment = RUNTIME / "env"
if not (environment / "bin/python").exists():
    subprocess.run([sys.executable, "-m", "venv", str(environment)], check=True)
python = str(environment / "bin/python")
env = dict(os.environ, PYTHONNOUSERSITE="1", TORCH_DEVICE_BACKEND_AUTOLOAD="0", PIP_CACHE_DIR=str(RUNTIME / "cache/pip"), TMPDIR=str(RUNTIME / "tmp"))
env.pop("PYTHONPATH", None)
env.pop("PYTHONHOME", None)
wheel = RUNTIME / "downloads" / WHEEL
download(f"{HUB_ENDPOINT}/m-a-p/YuE2-3B/resolve/{MODEL_REVISION}/{WHEEL}", wheel, WHEEL_HASH)
torch_wheel = RUNTIME / "downloads" / unquote(Path(urlparse(TORCH_URL).path).name)
download(TORCH_URL, torch_wheel, TORCH_HASH)
subprocess.run([python, "-m", "pip", "install", str(torch_wheel), "--index-url", PYPI_INDEX], check=True, env=env)
subprocess.run([python, "-m", "pip", "install", "-r", str(SOURCE / "requirements.txt"), str(wheel), "--index-url", PYPI_INDEX], check=True, env=env)

models = (
    ("YuE2-3B", MODEL_REVISION, ["config.json", "generation_config.json", "modeling_yue2.py", "qwen.tiktoken", "yue2_generation_config.json", "weights_manifest.json", "LICENSE", "model.safetensors"]),
    ("YuE2-Vae", VAE_REVISION, ["config.json", "modeling_vae.py", "weights_manifest.json", "LICENSE", "model.safetensors"]),
)
for name, revision, files in models:
    destination = ROOT / "models" / name
    stage = RUNTIME / "downloads" / name
    destination.mkdir(parents=True, exist_ok=True)
    stage.mkdir(parents=True, exist_ok=True)
    base = f"{HUB_ENDPOINT}/m-a-p/{name}/resolve/{revision}/"
    download(base + "weights_manifest.json", stage / "weights_manifest.json")
    manifest = json.loads((stage / "weights_manifest.json").read_text())["files"]
    for filename in files:
        expected = manifest.get(filename)
        target = destination / filename
        if expected and target.is_file() and target.stat().st_size == expected["bytes"] and digest(target) == expected["sha256"]:
            continue
        download(base + filename, stage / filename, expected["sha256"] if expected else None)
        if expected and (stage / filename).stat().st_size != expected["bytes"]:
            raise RuntimeError("Unexpected model size: " + name)
        partial = destination / (filename + ".copying")
        with (stage / filename).open("rb") as source, partial.open("wb") as output:
            shutil.copyfileobj(source, output, length=1024 * 1024)
            output.flush()
            os.fsync(output.fileno())
        partial.replace(target)
        if expected:
            time.sleep(30)
            if target.stat().st_size != expected["bytes"] or digest(target) != expected["sha256"]:
                raise RuntimeError("Persistent model integrity failed: " + name)
    (destination / "revision.txt").write_text(revision + "\n")

with (ROOT / "recover/requirements-lock.txt").open("w") as output:
    subprocess.run([python, "-m", "pip", "freeze"], stdout=output, check=True, env=env)
(ROOT / "recover/runtime.json").write_text(json.dumps({
    "python": sys.version, "base_interpreter": sys.executable, "runtime": str(environment),
    "torch": "2.10.0+cu130", "model_revision": MODEL_REVISION, "vae_revision": VAE_REVISION,
    "inference_wheel": WHEEL, "inference_sha256": digest(wheel),
    "model_dtype": "bfloat16", "vae_dtype": "float32", "quantization": "none",
}, ensure_ascii=False, indent=2) + "\n")
print("YuE2 isolated runtime and complete models installed", flush=True)
