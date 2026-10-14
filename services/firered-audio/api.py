"""FireRedAudio task service.

Shares the second RTX 5090 with the YuE2 music service: every task runs in a fresh
worker subprocess that loads the model, writes the output and exits, so the GPU is
free again between tasks (YuE2 unloads after each job as well). The service itself
never imports torch.

Endpoints (Bearer token, same loopback-only proxy contract as /yue2):
    GET  /health
    POST /v1/firered/audio          raw audio upload -> {id, bytes}   (sha256 dedupe)
    POST /v1/firered/tasks          create task (202) -> task
    GET  /v1/firered/tasks/{id}     task status/stage/result
    GET  /v1/firered/tasks/{id}/content   generated wav
"""

import fcntl
import hashlib
import hmac
import json
import logging
import os
import secrets
import shutil
import sqlite3
import subprocess
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal
from uuid import UUID

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

ROOT = Path(os.environ.get("AUDIO_STUDIO_ROOT", "/project/daixinliang/audio-studio"))
RUNTIME = Path(os.environ.get("AUDIO_STUDIO_RUNTIME", "/var/tmp/audio-studio"))
FIRERED_CODE = RUNTIME / "firered/FireRedAudio"  # GitHub code repo (inference.py, fireredaudio package)
FIRERED_PYTHON = RUNTIME / "firered-env/bin/python"
FIRERED_ENV_PATH_LIB = RUNTIME / "firered-env/lib/python3.10/site-packages"
FIRERED_MODEL = ROOT / "models/FireRedAudio"
FIRERED_DECODER = ROOT / "models/RedAE_decoder/model.pt"
MAX_UNDERSTAND_MINUTES = float(os.environ.get("FIRERED_MAX_UNDERSTAND_MINUTES", "10"))
MAX_EDIT_MINUTES = float(os.environ.get("FIRERED_MAX_EDIT_MINUTES", "30"))
MAX_CLONE_REF_MINUTES = float(os.environ.get("FIRERED_MAX_CLONE_REF_MINUTES", "2"))
SAMPLE_RATE = 24000

logger = logging.getLogger("firered")
security = HTTPBearer(auto_error=False)

# Uploads are stored extension-less (sha256 address, shared scheme with YuE2); the mime
# sidecar lets the worker materialize an extension ffmpeg can probe reliably.
MIME_SUFFIX = {
    "audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/wave": ".wav",
    "audio/webm": ".webm", "video/webm": ".webm", "audio/ogg": ".ogg", "application/ogg": ".ogg",
    "audio/flac": ".flac", "audio/x-m4a": ".m4a", "audio/mp4": ".m4a", "audio/aac": ".aac", "audio/x-aac": ".aac",
}


class FireRedTaskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str
    type: Literal["tts", "edit", "edit_acoustic", "asr", "understand"]
    # tts
    mode: Literal["clone", "design"] | None = None
    text: str | None = None                 # target text to synthesize
    prompt_transcript: str | None = None    # clone reference transcript; empty -> auto ASR
    voice_description: str | None = None    # design mode timbre description
    language: Literal["zh", "en"] = "zh"
    seed: int | None = Field(default=None, ge=0, le=9007199254740991)
    # edit / edit_acoustic / asr / understand
    audio_id: str | None = None             # edit target / tts clone reference
    audio_ids: list[str] | None = None      # asr / understand inputs (multiple allowed)
    instruction: str | None = None          # semantic edit instruction
    speed: float | None = Field(default=None, ge=0.5, le=2.0)
    pitch: int | None = Field(default=None, ge=-6, le=6)
    volume: float | None = Field(default=None, ge=0.3, le=2.0)
    prompt: str | None = None               # understand question (empty -> asr transcription)
    thinking: bool = False                  # understand chain-of-thought

    @field_validator("id")
    @classmethod
    def uuid_id(cls, value):
        return str(UUID(value))

    @field_validator("audio_id")
    @classmethod
    def audio_hash(cls, value):
        if value is not None and (len(value) != 64 or any(char not in "0123456789abcdef" for char in value)):
            raise ValueError("音频编号无效")
        return value

    @model_validator(mode="after")
    def validate_type(self):
        kind, problems = self.type, []
        if kind == "tts":
            if not (self.text or "").strip():
                problems.append("请填写要合成的文本")
            if self.mode is None:
                problems.append("请选择合成模式")
            elif self.mode == "clone" and not self.audio_id:
                problems.append("声音克隆需要连接参考音频")
            elif self.mode == "design" and not (self.voice_description or "").strip():
                problems.append("请填写声音描述")
        elif kind == "edit":
            if not self.audio_id:
                problems.append("语音编辑需要目标音频")
            if not (self.instruction or "").strip():
                problems.append("请填写编辑指令")
        elif kind == "edit_acoustic":
            if not self.audio_id:
                problems.append("声学调节需要目标音频")
            if self.speed == 1:
                self.speed = None
            if self.volume == 1:
                self.volume = None
            if self.pitch == 0:
                self.pitch = None
            if self.speed is None and self.pitch is None and self.volume is None:
                problems.append("请至少调整语速、音调或音量其中一项")
        else:
            if not self.audio_ids:
                problems.append("请提供要识别的音频")
            if kind == "understand" and not (self.prompt or "").strip():
                problems.append("请填写针对音频的问题")
        if problems:
            raise ValueError("；".join(problems))
        return self


def write_json(path: Path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


class FireRedService:
    def __init__(self):
        self.lock = threading.RLock()
        self.wake = threading.Condition(self.lock)
        self.stop = threading.Event()
        self.state = "ready" if (FIRERED_PYTHON.is_file() and (FIRERED_CODE / "inference.py").is_file()
                                 and (FIRERED_MODEL / "config.json").is_file()) else "loading"
        self.error = None
        missing = [name for name, present in (
            ("推理环境", FIRERED_PYTHON.is_file()),
            ("官方代码", (FIRERED_CODE / "inference.py").is_file()),
            ("主模型", (FIRERED_MODEL / "config.json").is_file()),
        ) if not present]
        if missing:
            self.state, self.error = "failed", "FireRedAudio 尚未安装：" + "、".join(missing) + "；请运行 bootstrap.py"
        self.token = os.environ.get("FIRERED_API_TOKEN") or (ROOT / "recover/firered-api.token").read_text().strip()
        if not self.token:
            raise RuntimeError("未配置 FireRedAudio API token")
        ROOT.chmod(0o700)
        RUNTIME.mkdir(parents=True, exist_ok=True)
        self.process_lock = (RUNTIME / "firered.lock").open("a")
        fcntl.flock(self.process_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        (ROOT / "jobs").mkdir(parents=True, exist_ok=True)
        (ROOT / "inputs").mkdir(exist_ok=True)
        (ROOT / "outputs/firered").mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(ROOT / "jobs/firered.sqlite3", check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=DELETE")
        self.db.execute("PRAGMA synchronous=FULL")
        with self.db:
            self.db.execute("""CREATE TABLE IF NOT EXISTS tasks (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
                request TEXT NOT NULL, status TEXT NOT NULL, stage TEXT NOT NULL,
                output TEXT, error TEXT, created_at REAL NOT NULL
            )""")
            # The worker subprocess dies with the service; queued tasks can restart.
            self.db.execute("UPDATE tasks SET status='failed', stage='failed', error='服务曾中断；请使用原参数重新生成' WHERE status='running'")
        self.worker = threading.Thread(target=self.run, name="firered-gpu", daemon=True)
        self.worker.start()

    # ------------------------------------------------------------------ queue
    def get(self, task_id):
        with self.lock:
            row = self.db.execute("SELECT * FROM tasks WHERE id=?", (str(task_id),)).fetchone()
        if row is None:
            raise HTTPException(404, "任务不存在；请保留原请求编号")
        return {
            "id": row["id"], "status": row["status"], "stage": row["stage"],
            "request": json.loads(row["request"]),
            "result": json.loads(row["output"]) if row["output"] else None,
            "error": row["error"],
        }

    def submit(self, request: FireRedTaskRequest):
        payload = json.dumps(request.model_dump(), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        with self.lock:
            row = self.db.execute("SELECT request FROM tasks WHERE id=?", (request.id,)).fetchone()
            if row is not None:
                if FireRedTaskRequest.model_validate_json(row["request"]) != request:
                    raise HTTPException(409, "同一任务编号不能对应不同的参数")
                return self.get(request.id)
            try:
                with self.db:
                    self.db.execute("INSERT INTO tasks(id,request,status,stage,created_at) VALUES(?,?, 'queued','queued',?)",
                                    (request.id, payload, time.time()))
            except sqlite3.Error as exc:
                logger.exception("Could not persist firered request")
                raise HTTPException(503, "任务保存失败；请保留原请求编号重试") from exc
            self.wake.notify()
            return self.get(request.id)

    def update(self, task_id, *, status=None, stage=None, output=None, error=None):
        values = {key: value for key, value in {"status": status, "stage": stage, "output": json.dumps(output) if output is not None else None, "error": error}.items() if value is not None}
        if not values:
            return
        with self.lock, self.db:
            self.db.execute("UPDATE tasks SET " + ",".join(key + "=?" for key in values) + " WHERE id=?", (*values.values(), task_id))

    # ----------------------------------------------------------------- inputs
    def audio_path(self, audio_id: str) -> Path:
        path = ROOT / "inputs" / (audio_id + ".audio")
        if not path.is_file():
            raise HTTPException(404, "音频不存在，请重新上传原文件")
        return path

    def mime_of(self, audio_id: str) -> str:
        sidecar = ROOT / "inputs" / (audio_id + ".mime")
        return sidecar.read_text(encoding="utf-8").strip() if sidecar.is_file() else ""

    def materialize(self, request: FireRedTaskRequest, workdir: Path) -> dict:
        """Hardlink uploads into the task workdir with a decodable suffix."""
        def link(audio_id: str, name: str) -> Path:
            source = self.audio_path(audio_id)
            target = workdir / (name + MIME_SUFFIX.get(self.mime_of(audio_id), ".wav"))
            if target.exists():
                target.unlink()
            try:
                os.link(source, target)
            except OSError:
                shutil.copyfile(source, target)
            return target
        inputs = {}
        if request.audio_id:
            inputs["primary"] = link(request.audio_id, "input")
        if request.audio_ids:
            inputs["understand"] = [link(audio_id, f"understand-{index}") for index, audio_id in enumerate(request.audio_ids)]
        return inputs

    # ----------------------------------------------------------------- worker
    def next_task(self):
        with self.lock:
            row = self.db.execute("SELECT id FROM tasks WHERE status='queued' ORDER BY sequence LIMIT 1").fetchone()
            if row is None:
                return None
            self.update(row["id"], status="running", stage="preparing")
            return self.get(row["id"])

    def run(self):
        while True:
            with self.wake:
                task = self.next_task()
                while task is None and not self.stop.is_set():
                    self.wake.wait()
                    if not self.stop.is_set():
                        task = self.next_task()
            if self.stop.is_set():
                break
            task_id = task["id"]
            workdir = ROOT / "outputs/firered" / task_id
            try:
                workdir.mkdir(parents=True, exist_ok=True)
                request = FireRedTaskRequest.model_validate(task["request"])
                inputs = self.materialize(request, workdir)
                task_file = workdir / "task.json"
                write_json(task_file, request.model_dump())
                caps = {"understand": MAX_UNDERSTAND_MINUTES, "edit": MAX_EDIT_MINUTES, "edit_acoustic": MAX_EDIT_MINUTES,
                        "asr": MAX_UNDERSTAND_MINUTES, "tts": MAX_CLONE_REF_MINUTES}.get(request.type, 10)
                env = dict(os.environ, PYTHONNOUSERSITE="1", TORCH_DEVICE_BACKEND_AUTOLOAD="0", HF_HUB_OFFLINE="1",
                           CUDA_CACHE_PATH=str(RUNTIME / "cache/cuda"), TRITON_CACHE_DIR=str(RUNTIME / "cache/triton"),
                           TORCHINDUCTOR_CACHE_DIR=str(RUNTIME / "cache/torchinductor"), TMPDIR=str(RUNTIME / "tmp"),
                           PATH=str(RUNTIME / "ffmpeg/bin") + ":" + os.environ.get("PATH", ""),
                           # torchcodec needs ffmpeg's libav*.so and the pip nvidia-npp libs at dlopen time.
                           LD_LIBRARY_PATH=":".join(filter(None, [
                               str(RUNTIME / "ffmpeg/lib"),
                               str(FIRERED_ENV_PATH_LIB / "nvidia/npp/lib"),
                               os.environ.get("LD_LIBRARY_PATH", ""),
                           ])),
                           FIRERED_CODE_DIR=str(FIRERED_CODE), FIRERED_MAX_MINUTES=str(caps))
                env.pop("PYTHONPATH", None)
                env.pop("PYTHONHOME", None)
                command = [str(FIRERED_PYTHON), str(ROOT / "services/firered-audio/worker.py"), str(task_file), str(workdir)]
                for name, path in inputs.items():
                    value = [str(item) for item in path] if isinstance(path, list) else str(path)
                    command += [f"--{name}", json.dumps(value)]
                stderr = workdir / "worker.log"
                with stderr.open("w") as log:
                    process = subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=log, text=True, cwd=str(FIRERED_CODE))
                    for line in process.stdout:
                        try:
                            stage = json.loads(line).get("stage")
                        except ValueError:
                            continue
                        if stage:
                            self.update(task_id, stage=stage)
                    code = process.wait()
                if code:
                    detail = (stderr.read_text()[-2000:] if stderr.exists() else "") or "任务失败"
                    if "out of memory" in detail.lower():
                        detail = "显存不足（32G 卡上生成类任务接近上限；请确认音乐服务已空闲后重试）\n" + detail[-600:]
                    self.update(task_id, status="failed", stage="failed", error=detail)
                else:
                    result = json.loads((workdir / "result.json").read_text(encoding="utf-8"))
                    self.update(task_id, status="completed", stage="completed", output=result)
            except Exception as exc:
                logger.exception("FireRed task %s failed", task_id)
                self.update(task_id, status="failed", stage="failed", error=str(exc))

    def close(self):
        with self.wake:
            self.stop.set()
            self.wake.notify()
        self.worker.join()
        self.db.close()
        self.process_lock.close()


@asynccontextmanager
async def lifespan(app):
    app.state.firered = FireRedService()
    try:
        yield
    finally:
        app.state.firered.close()


app = FastAPI(title="FireRedAudio API", lifespan=lifespan)


def authorized(credentials: HTTPAuthorizationCredentials | None = Depends(security)):
    if credentials is None or not hmac.compare_digest(credentials.credentials, app.state.firered.token):
        raise HTTPException(401, "FireRedAudio 服务认证失败", headers={"WWW-Authenticate": "Bearer"})


@app.get("/health")
def health():
    service = app.state.firered
    return {"status": service.state, "model": "FireRedAudio", "sample_rate": SAMPLE_RATE,
            "speech_ready": FIRERED_DECODER.is_file(), "error": service.error,
            "limits": {"understand_minutes": MAX_UNDERSTAND_MINUTES, "edit_minutes": MAX_EDIT_MINUTES, "clone_ref_minutes": MAX_CLONE_REF_MINUTES}}


@app.post("/v1/firered/audio", dependencies=[Depends(authorized)])
async def upload_audio(request: Request):
    if not request.headers.get("content-type", "").startswith(("audio/", "video/webm", "application/octet-stream")):
        raise HTTPException(415, "请上传音频文件")
    temporary = ROOT / "inputs" / (str(UUID(bytes=secrets.token_bytes(16))) + ".uploading")
    digest = hashlib.sha256()
    mime = (request.headers.get("content-type") or "").split(";")[0].strip()
    size = 0
    try:
        with temporary.open("wb") as stream:
            async for chunk in request.stream():
                digest.update(chunk)
                stream.write(chunk)
                size += len(chunk)
            stream.flush()
            os.fsync(stream.fileno())
        if not size:
            raise HTTPException(400, "音频为空")
        audio_id = digest.hexdigest()
        target = ROOT / "inputs" / (audio_id + ".audio")
        if target.exists():
            temporary.unlink()
        else:
            temporary.replace(target)
            (ROOT / "inputs" / (audio_id + ".mime")).write_text(mime, encoding="utf-8")
        return {"id": audio_id, "bytes": size}
    finally:
        temporary.unlink(missing_ok=True)


@app.post("/v1/firered/tasks", status_code=202, dependencies=[Depends(authorized)])
def create_task(request: FireRedTaskRequest):
    return app.state.firered.submit(request)


@app.get("/v1/firered/tasks/{task_id}", dependencies=[Depends(authorized)])
def get_task(task_id: UUID):
    return app.state.firered.get(task_id)


@app.get("/v1/firered/tasks/{task_id}/content", dependencies=[Depends(authorized)])
def task_content(task_id: UUID):
    task = app.state.firered.get(task_id)
    if task["status"] != "completed":
        raise HTTPException(409, "任务尚未完成")
    result = task["result"] or {}
    path = ROOT / "outputs/firered" / str(task_id) / (result.get("audio") or "")
    if not result.get("audio") or not path.is_file():
        raise HTTPException(410, "音频文件已不可用；任务记录仍保留")
    return FileResponse(path, media_type=result.get("mime_type") or "audio/wav", filename=str(task_id) + ".wav")
