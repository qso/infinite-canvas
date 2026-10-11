import dataclasses
import fcntl
import hmac
import hashlib
import shutil
import subprocess
import json
import logging
import os
from pathlib import Path
import secrets
import sqlite3
import sys
import threading
import time
from contextlib import asynccontextmanager
from typing import Literal
from uuid import UUID

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

ROOT = Path(os.environ.get("AUDIO_STUDIO_ROOT", "/project/daixinliang/audio-studio"))
RUNTIME = Path(os.environ.get("AUDIO_STUDIO_RUNTIME", "/var/tmp/audio-studio"))
logger = logging.getLogger("yue2")
security = HTTPBearer(auto_error=False)
REFERENCE_VERSION = "reference-v2"
INSTRUMENTAL_STYLE_PREFIX = "Instrumental, no vocals, no singing, no humming, no wordless vocals.\n"


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)
    sync_directory(path.parent)


class ReferenceSource(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    audio_id: str | None = None
    music_task_id: str | None = None

    @field_validator("audio_id")
    @classmethod
    def audio_hash(cls, value):
        if value is not None and (len(value) != 64 or any(char not in "0123456789abcdef" for char in value)):
            raise ValueError("参考音频编号无效")
        return value

    @field_validator("music_task_id")
    @classmethod
    def task_uuid(cls, value):
        return str(UUID(value)) if value is not None else None

    @model_validator(mode="after")
    def one_source(self):
        if bool(self.audio_id) == bool(self.music_task_id):
            raise ValueError("请选择一个参考音频或音乐任务")
        return self


class AnalysisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str
    source: ReferenceSource
    score: bool = False
    style: bool = False
    lyrics: bool = False

    @field_validator("id")
    @classmethod
    def uuid_id(cls, value):
        return str(UUID(value))

    @model_validator(mode="after")
    def analysis_required(self):
        if not any((self.score, self.style, self.lyrics)):
            raise ValueError("请选择转谱、曲风分析或歌词提取")
        return self


class MusicReference(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    analysis_id: str
    mode: Literal["melody", "full", "style"]
    style_override: str | None = None

    @field_validator("analysis_id")
    @classmethod
    def uuid_id(cls, value):
        return str(UUID(value))


class MusicRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str
    model: Literal["YuE2-3B"] = "YuE2-3B"
    style: str = Field(min_length=1)
    lyrics: str = ""
    cot: Literal["full", "melody", "off"] = "full"
    output_type: Literal["song", "instrumental"] = "song"
    seed: int | None = Field(default=None, ge=0, le=9007199254740991)
    cfg_scale: float | None = Field(default=None, ge=0, le=20, allow_inf_nan=False)
    steps: int = Field(default=32, ge=1)
    temperature: float = Field(default=1, ge=0, le=5, allow_inf_nan=False)
    abc: str | None = None
    format: Literal["wav", "flac"] = "wav"
    reference: MusicReference | None = None
    abc_temperature: float = Field(default=0.7, ge=0, le=5, allow_inf_nan=False)
    abc_top_p: float = Field(default=0.9, gt=0, le=1, allow_inf_nan=False)
    abc_top_k: int = Field(default=30, ge=1)
    abc_repetition_penalty: float = Field(default=1.005, gt=0, allow_inf_nan=False)
    top_p: float = Field(default=0.95, gt=0, le=1, allow_inf_nan=False)
    top_k: int = Field(default=100, ge=1)
    repetition_penalty: float = Field(default=1.2, gt=0, allow_inf_nan=False)

    @field_validator("id")
    @classmethod
    def uuid_id(cls, value):
        return str(UUID(value))

    @field_validator("style")
    @classmethod
    def nonempty_style(cls, value):
        if not value.strip():
            raise ValueError("请填写音乐风格")
        return value

    @model_validator(mode="after")
    def validate_score(self):
        if self.abc is not None and (not self.abc.strip() or self.cot == "off"):
            raise ValueError("ABC 乐谱需要非空文本，并选择旋律或旋律与和弦规划")
        return self


class MusicService:
    def __init__(self):
        self.lock = threading.RLock()
        self.wake = threading.Condition(self.lock)
        self.stop = threading.Event()
        self.state = "loading"
        self.error = None
        self.token = os.environ.get("YUE2_API_TOKEN") or (ROOT / "recover/yue2-api.token").read_text().strip()
        if not self.token:
            raise RuntimeError("未配置 YuE2 API token")
        ROOT.chmod(0o700)
        RUNTIME.mkdir(parents=True, exist_ok=True)
        self.process_lock = (RUNTIME / "yue2.lock").open("a")
        fcntl.flock(self.process_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        (ROOT / "jobs").mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(ROOT / "jobs/yue2.sqlite3", check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=DELETE")
        self.db.execute("PRAGMA synchronous=FULL")
        with self.db:
            self.db.execute("""CREATE TABLE IF NOT EXISTS jobs (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
                request TEXT NOT NULL, seed INTEGER NOT NULL, status TEXT NOT NULL,
                stage TEXT NOT NULL, output TEXT, error TEXT, created_at REAL NOT NULL
            )""")
            self.db.execute("UPDATE jobs SET status='failed', stage='failed', error=? WHERE status='running'", ("服务曾中断；请使用原参数重新生成",))
            self.db.execute("""CREATE TABLE IF NOT EXISTS analyses (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
                request TEXT NOT NULL, cache_key TEXT NOT NULL, status TEXT NOT NULL,
                stage TEXT NOT NULL, result TEXT, error TEXT, created_at REAL NOT NULL
            )""")
            self.db.execute("UPDATE analyses SET status='failed', stage='failed', error=? WHERE status='running'", ("参考分析曾中断；可使用原素材重新分析",))
        for name in ("inputs", "analyses"):
            (ROOT / name).mkdir(exist_ok=True)
        self.worker = threading.Thread(target=self.run, name="yue2-gpu", daemon=True)
        self.worker.start()

    def get(self, job_id):
        with self.lock:
            row = self.db.execute("SELECT * FROM jobs WHERE id=?", (str(job_id),)).fetchone()
        if row is None:
            raise HTTPException(404, "音乐任务不存在；请保留原请求编号")
        worker_failed = self.state == "failed" and row["status"] in {"queued", "running"}
        return {
            "id": row["id"], "status": "failed" if worker_failed else row["status"],
            "stage": "failed" if worker_failed else row["stage"],
            "seed": row["seed"], "request": json.loads(row["request"]),
            "output": json.loads(row["output"]) if row["output"] else None,
            "error": self.error if worker_failed else row["error"],
        }

    def submit(self, request):
        payload = json.dumps(request.model_dump(), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        with self.lock:
            row = self.db.execute("SELECT request FROM jobs WHERE id=?", (request.id,)).fetchone()
            if row is not None:
                if MusicRequest.model_validate_json(row["request"]) != request:
                    raise HTTPException(409, "同一任务编号不能对应不同的生成参数")
                return self.get(request.id)
            if self.state == "failed":
                raise HTTPException(503, self.error or "YuE2 未就绪")
            seed = request.seed if request.seed is not None else secrets.randbits(53)
            try:
                with self.db:
                    self.db.execute(
                        "INSERT INTO jobs(id,request,seed,status,stage,created_at) VALUES(?,?,?,'queued','queued',?)",
                        (request.id, payload, seed, time.time()),
                    )
            except sqlite3.Error as exc:
                logger.exception("Could not persist music request")
                raise HTTPException(503, "音乐任务保存失败；请保留原请求编号重试") from exc
            self.wake.notify()
            return self.get(request.id)

    def update(self, job_id, *, status=None, stage=None, output=None, error=None):
        values = {key: value for key, value in {"status": status, "stage": stage, "output": json.dumps(output) if output is not None else None, "error": error}.items() if value is not None}
        with self.lock, self.db:
            self.db.execute("UPDATE jobs SET " + ",".join(key + "=?" for key in values) + " WHERE id=?", (*values.values(), job_id))

    def analysis(self, analysis_id):
        with self.lock:
            row = self.db.execute("SELECT * FROM analyses WHERE id=?", (str(analysis_id),)).fetchone()
            if row is None:
                raise HTTPException(404, "参考分析任务不存在")
            worker_failed = self.state == "failed" and row["status"] in {"queued", "running"}
            return {"id": row["id"], "request": json.loads(row["request"]), "status": "failed" if worker_failed else row["status"], "stage": "failed" if worker_failed else row["stage"], "result": json.loads(row["result"]) if row["result"] else None, "error": self.error if worker_failed else row["error"]}

    def source_path(self, source):
        if source.audio_id:
            path = ROOT / "inputs" / (source.audio_id + ".audio")
            if not path.is_file():
                raise HTTPException(404, "参考音频不存在，请重新上传原文件")
            return path
        job = self.get(source.music_task_id)
        if job["status"] != "completed":
            raise HTTPException(409, "参考音乐尚未生成完成")
        path = ROOT / "outputs" / source.music_task_id / ("audio." + job["request"]["format"])
        if not path.is_file():
            raise HTTPException(410, "参考音乐文件已失效，可上传浏览器本地副本")
        return path

    def submit_analysis(self, request):
        payload = json.dumps(request.model_dump(), ensure_ascii=False, sort_keys=True)
        with self.lock:
            old = self.db.execute("SELECT request FROM analyses WHERE id=?", (request.id,)).fetchone()
            if old is not None:
                if json.loads(old["request"]) != request.model_dump():
                    raise HTTPException(409, "同一分析编号不能对应不同素材或选项")
                return self.analysis(request.id)
            if self.state == "failed":
                raise HTTPException(503, self.error or "参考分析服务未就绪")
            path = self.source_path(request.source)
            if request.source.audio_id:
                source_identity = request.source.audio_id
            else:
                score_path = path.parent / "score.abc"
                with (score_path if request.score and not request.style and not request.lyrics and score_path.is_file() else path).open("rb") as stream:
                    source_identity = hashlib.file_digest(stream, "sha256").hexdigest()
            identity = {"source": source_identity, "score": request.score, "style": request.style, "lyrics": request.lyrics, "version": REFERENCE_VERSION,
                        "sheetsage": "32c7c7473e7b59e1ed36bd8a8fefbd11ae8d468a", "flamingo": "6b5be086d52f65a1e204cb0faf70bf54e2741ecd"}
            cache_key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
            cached = self.db.execute("SELECT result FROM analyses WHERE cache_key=? AND status='completed' ORDER BY sequence LIMIT 1", (cache_key,)).fetchone()
            result = json.loads(cached["result"]) if cached else None
            if result is not None:
                result.update(source=request.source.model_dump(), version=REFERENCE_VERSION)
                result.pop("source_lyrics", None)
                if request.source.music_task_id:
                    result["source_lyrics"] = self.get(request.source.music_task_id)["request"]["lyrics"]
            try:
                with self.db:
                    self.db.execute("INSERT INTO analyses(id,request,cache_key,status,stage,result,created_at) VALUES(?,?,?,?,?,?,?)",
                                    (request.id, payload, cache_key, "completed" if cached else "queued", "analysis_completed" if cached else "queued", json.dumps(result, ensure_ascii=False) if result is not None else None, time.time()))
            except sqlite3.Error as exc:
                raise HTTPException(503, "参考分析保存失败，请保留原编号重试") from exc
            self.wake.notify()
            return self.analysis(request.id)

    def update_analysis(self, analysis_id, stage, *, status="running", result=None, error=None):
        with self.lock, self.db:
            self.db.execute("UPDATE analyses SET stage=?,status=?,result=COALESCE(?,result),error=? WHERE id=?",
                            (stage, status, json.dumps(result, ensure_ascii=False) if result is not None else None, error, analysis_id))

    def next_analysis(self):
        with self.lock:
            row = self.db.execute("SELECT id FROM analyses WHERE status='queued' ORDER BY sequence LIMIT 1").fetchone()
            if row is None:
                return None
            self.update_analysis(row["id"], "preparing_reference")
            return self.analysis(row["id"])

    def run_analysis(self, analysis):
        request = AnalysisRequest.model_validate(analysis["request"])
        directory = ROOT / "analyses" / request.id
        directory.mkdir(exist_ok=True)
        source = self.source_path(request.source)
        result = {"abc_full": None, "abc_melody": None, "style": None, "lyrics": None, "warnings": [], "source": request.source.model_dump(), "version": REFERENCE_VERSION}
        operations = []
        if request.score:
            score_path = ROOT / "outputs" / request.source.music_task_id / "score.abc" if request.source.music_task_id else None
            operations.append(("score" if score_path and score_path.is_file() else "transcribe", score_path if score_path and score_path.is_file() else source))
        if request.style:
            operations.append(("describe", source))
        if request.lyrics:
            operations.append(("lyrics", source))
        for operation, path in operations:
            python = RUNTIME / ("sheetsage-env" if operation in {"score", "transcribe"} else "flamingo-env") / "bin/python"
            if not python.is_file():
                raise RuntimeError("参考分析环境尚未安装：" + operation)
            env = dict(os.environ, PATH=str(RUNTIME / "ffmpeg/bin") + ":" + os.environ.get("PATH", ""), HF_HUB_OFFLINE="1", HF_HOME=str(RUNTIME / "cache/huggingface-reference"), PYTHONNOUSERSITE="1", TORCH_DEVICE_BACKEND_AUTOLOAD="0")
            output = directory / (operation + ".json")
            stderr = directory / (operation + ".log")
            with stderr.open("w") as log:
                process = subprocess.Popen([str(python), str(ROOT / "services/yue2/reference_worker.py"), operation, str(path), str(output)], env=env, stdout=subprocess.PIPE, stderr=log, text=True)
                for line in process.stdout:
                    try:
                        stage = json.loads(line).get("stage", "preparing_reference")
                    except ValueError:
                        continue
                    self.update_analysis(request.id, stage)
                code = process.wait()
            if code:
                raise RuntimeError(stderr.read_text()[-2000:] or "参考分析失败")
            part = json.loads(output.read_text())
            result["warnings"].extend(part.pop("warnings", []))
            result.update(part)
        if request.source.music_task_id:
            result["source_lyrics"] = self.get(request.source.music_task_id)["request"]["lyrics"]
        self.update_analysis(request.id, "analysis_completed", status="completed", result=result)

    def instrumentalize(self, abc, job_id, *, drop_chords):
        """Move the planned vocal melody to the instrumental voice via the pinned official tool."""
        # The model may emit section labels outside the official whitelist (e.g. "% silence"); those comment
        # lines carry no notes, so drop them before conversion and keep the original score untouched.
        recognized_sections = {"intro", "verse", "pre-chorus", "chorus", "bridge", "interlude", "outro", "instrumental"}
        convertible = "\n".join(line for line in abc.splitlines() if not (line.startswith("% ") and line[2:].strip() and line[2:].strip() not in recognized_sections)) + "\n"
        directory = ROOT / "outputs" / job_id
        directory.mkdir(parents=True, exist_ok=True)
        source = directory / "source-score.abc"
        source.write_text(abc, encoding="utf-8")
        conversion_input = directory / "conversion-input.abc"
        conversion_input.write_text(convertible, encoding="utf-8")
        conversion = directory / "conversion"
        if conversion.exists():
            shutil.rmtree(conversion)
        command = [sys.executable, str(ROOT / "services/yue2/instrumental/instrumentalize.py"), str(conversion_input), "--output", str(conversion)]
        if drop_chords:
            command.append("--drop-chords")
        process = subprocess.run(command, capture_output=True, text=True)
        if process.returncode:
            raise RuntimeError((process.stderr or "").strip()[-2000:] or "器乐乐谱转换失败；原始乐谱已保留")
        converted = (conversion / "score.abc").read_text(encoding="utf-8")
        transfer = json.loads((conversion / "transfer.json").read_text(encoding="utf-8"))
        return converted, transfer

    def next_job(self):
        with self.lock:
            row = self.db.execute("SELECT id FROM jobs WHERE status='queued' ORDER BY sequence LIMIT 1").fetchone()
            if row is None:
                return None
            self.update(row["id"], status="running", stage="planning")
            return self.get(row["id"])

    def run(self):
        pipe = None
        try:
            import soundfile as sf
            from yue2 import YuE2Pipeline

            pipe = YuE2Pipeline.from_pretrained(
                str(ROOT / "models/YuE2-3B"), vae=str(ROOT / "models/YuE2-Vae"),
                local_files_only=True, device="cuda", backend="torch", quantization="none",
            )
            defaults = pipe.generation_config
            self.state = "ready"
            while True:
                with self.wake:
                    if self.stop.is_set():
                        break
                    analysis = self.next_analysis()
                    job = None if analysis else self.next_job()
                    while job is None and analysis is None and not self.stop.is_set():
                        self.wake.wait()
                        if not self.stop.is_set():
                            analysis = self.next_analysis()
                            job = None if analysis else self.next_job()
                    if self.stop.is_set():
                        break
                if analysis:
                    pipe.close()
                    try:
                        self.run_analysis(analysis)
                    except Exception as exc:
                        logger.exception("Reference analysis failed")
                        self.update_analysis(analysis["id"], "failed", status="failed", error=str(exc))
                    continue
                job_id, request = job["id"], MusicRequest.model_validate(job["request"]).model_dump()
                plan = semantic = latents = audio = None
                instrumental = request["output_type"] == "instrumental"
                transfer = None
                try:
                    pipe.generation_config = dataclasses.replace(defaults, ode_steps=request["steps"])
                    actual = {"style": request["style"], "lyrics": request["lyrics"], "abc": request["abc"], "cot": request["cot"]}
                    if request["reference"]:
                        reference = request["reference"]
                        analysis = self.analysis(reference["analysis_id"])
                        if analysis["status"] != "completed":
                            raise RuntimeError("参考分析尚未完成，未退回无参考生成")
                        data = analysis["result"]
                        if reference["mode"] == "style":
                            if not data.get("style"):
                                raise RuntimeError("参考曲风分析缺失")
                            caption = reference["style_override"] if reference["style_override"] is not None else data["style"]
                            if not caption.strip():
                                raise RuntimeError("参考曲风描述不能为空，请编辑后再生成")
                            actual["style"] = caption if request["style"].strip() == caption.strip() else caption + "\nAdditional direction: " + request["style"]
                            actual["abc"] = None
                        else:
                            actual["abc"] = request["abc"] or data.get("abc_melody" if reference["mode"] == "melody" else "abc_full")
                            if not actual["abc"]:
                                raise RuntimeError("参考音乐没有有效乐谱")
                            actual["cot"] = reference["mode"]
                    if instrumental:
                        actual["lyrics"] = ""
                        if actual["cot"] == "off":
                            actual["cot"] = "full"
                        actual["style"] = INSTRUMENTAL_STYLE_PREFIX + actual["style"]
                    plan = pipe.plan(
                        style=actual["style"], lyrics=actual["lyrics"], cot=actual["cot"],
                        seed=job["seed"], cfg_scale=request["cfg_scale"], abc=actual["abc"], id=job_id,
                        abc_sampling={"temperature": request["abc_temperature"], "top_p": request["abc_top_p"], "top_k": request["abc_top_k"], "repetition_penalty": request["abc_repetition_penalty"]},
                    )
                    if instrumental:
                        if plan.abc is None:
                            raise RuntimeError("纯音乐规划未返回乐谱，无法转换为器乐演奏")
                        self.update(job_id, stage="instrumentalizing")
                        actual["abc"], transfer = self.instrumentalize(plan.abc, job_id, drop_chords=bool(request["reference"] and request["reference"]["mode"] == "melody" and not request["abc"]))
                        plan = pipe.plan(
                            style=actual["style"], lyrics="", cot=actual["cot"], seed=job["seed"],
                            cfg_scale=request["cfg_scale"], abc=actual["abc"], id=job_id,
                            abc_sampling={"temperature": request["abc_temperature"], "top_p": request["abc_top_p"], "top_k": request["abc_top_k"], "repetition_penalty": request["abc_repetition_penalty"]},
                        )
                    self.update(job_id, stage="semantic")
                    semantic = pipe.generate_semantic(plan, sampling={"temperature": request["temperature"], "top_p": request["top_p"], "top_k": request["top_k"], "repetition_penalty": request["repetition_penalty"]})
                    self.update(job_id, stage="synthesizing")
                    latents = pipe.synthesize(semantic)
                    self.update(job_id, stage="decoding")
                    audio = pipe.decode(latents)
                    self.update(job_id, stage="saving")
                    directory = ROOT / "outputs" / job_id
                    directory.mkdir(parents=True, exist_ok=True)
                    path = directory / ("audio." + request["format"])
                    temporary = directory / ("audio.part." + request["format"])
                    sf.write(temporary, audio, 48000, subtype="FLOAT" if request["format"] == "wav" else "PCM_24")
                    with temporary.open("rb") as stream:
                        os.fsync(stream.fileno())
                    temporary.replace(path)
                    if plan.abc is not None:
                        with (directory / "score.abc").open("w", encoding="utf-8") as stream:
                            stream.write(plan.abc)
                            stream.flush()
                            os.fsync(stream.fileno())
                    for parent in (directory, ROOT / "outputs"):
                        descriptor = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
                        try:
                            os.fsync(descriptor)
                        finally:
                            os.close(descriptor)
                    output = {
                        "mime_type": "audio/wav" if request["format"] == "wav" else "audio/flac",
                        "sample_rate": 48000, "duration_ms": round(len(audio) / 48),
                        "bytes": path.stat().st_size, "has_score": plan.abc is not None,
                        "truncated": {"abc": plan.truncated, "semantic": semantic.truncated},
                        "output_type": request["output_type"],
                        "instrumental": {"vocal_notes": transfer.get("vocal_notes_before"), "affected_ins_notes": len(transfer.get("affected_ins_notes", []))} if instrumental and transfer else None,
                        "used_input": actual,
                    }
                    self.update(job_id, status="completed", stage="completed", output=output)
                except Exception as exc:
                    logger.exception("Music task %s failed", job_id)
                    self.update(job_id, status="failed", stage="failed", error=str(exc))
                finally:
                    plan = semantic = latents = audio = None
                    pipe.generation_config = defaults
        except Exception as exc:
            logger.exception("YuE2 worker failed")
            with self.lock:
                self.state, self.error = "failed", str(exc)
                try:
                    with self.db:
                        self.db.execute("UPDATE jobs SET status='failed', stage='failed', error=? WHERE status IN ('queued','running')", (self.error,))
                except sqlite3.Error:
                    logger.exception("Could not persist failed worker state")
        finally:
            if pipe is not None:
                pipe.close()

    def close(self):
        with self.wake:
            self.stop.set()
            self.wake.notify()
        self.worker.join()
        self.db.close()
        self.process_lock.close()


@asynccontextmanager
async def lifespan(app):
    app.state.music = MusicService()
    try:
        yield
    finally:
        app.state.music.close()


app = FastAPI(title="YuE2 Music API", lifespan=lifespan)


def authorized(credentials: HTTPAuthorizationCredentials | None = Depends(security)):
    if credentials is None or not hmac.compare_digest(credentials.credentials, app.state.music.token):
        raise HTTPException(401, "音乐服务认证失败", headers={"WWW-Authenticate": "Bearer"})


@app.get("/health")
def health():
    service = app.state.music
    capabilities = {"score": (RUNTIME / "sheetsage-env/bin/python").is_file() and (ROOT / "models/SheetSage2/model.safetensors").is_file(),
                    "style": (RUNTIME / "flamingo-env/bin/python").is_file() and (ROOT / "models/MusicFlamingo/model.safetensors").is_file()}
    return {"status": service.state, "model": "YuE2-3B", "model_dtype": "bfloat16", "vae_dtype": "float32", "backend": "torch", "error": service.error, "reference_capabilities": capabilities}


@app.post("/v1/music/audio", dependencies=[Depends(authorized)])
async def upload_audio(request: Request):
    if not request.headers.get("content-type", "").startswith(("audio/", "application/octet-stream")):
        raise HTTPException(415, "请上传音频文件")
    temporary = ROOT / "inputs" / (str(UUID(bytes=secrets.token_bytes(16))) + ".uploading")
    digest = hashlib.sha256()
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
            raise HTTPException(400, "参考音频为空")
        audio_id = digest.hexdigest()
        target = ROOT / "inputs" / (audio_id + ".audio")
        if target.exists():
            temporary.unlink()
        else:
            temporary.replace(target)
        return {"id": audio_id, "bytes": size}
    finally:
        temporary.unlink(missing_ok=True)


@app.post("/v1/music/analyses", status_code=202, dependencies=[Depends(authorized)])
def analyze(request: AnalysisRequest):
    return app.state.music.submit_analysis(request)


@app.get("/v1/music/analyses/{analysis_id}", dependencies=[Depends(authorized)])
def get_analysis(analysis_id: UUID):
    return app.state.music.analysis(analysis_id)


@app.post("/v1/music/generations", status_code=202, dependencies=[Depends(authorized)])
def generate(request: MusicRequest):
    return app.state.music.submit(request)


@app.get("/v1/music/generations/{job_id}", dependencies=[Depends(authorized)])
def get_job(job_id: UUID):
    return app.state.music.get(job_id)


@app.get("/v1/music/generations/{job_id}/content", dependencies=[Depends(authorized)])
def content(job_id: UUID):
    job = app.state.music.get(job_id)
    if job["status"] != "completed":
        raise HTTPException(409, "音乐尚未生成完成")
    path = ROOT / "outputs" / str(job_id) / ("audio." + job["request"]["format"])
    if not path.is_file():
        raise HTTPException(410, "音频文件已不可用；任务记录仍保留")
    return FileResponse(path, media_type=job["output"]["mime_type"], filename=str(job_id) + "." + job["request"]["format"])


@app.get("/v1/music/generations/{job_id}/score", response_class=PlainTextResponse, dependencies=[Depends(authorized)])
def score(job_id: UUID, variant: Literal["used", "source"] = "used"):
    job = app.state.music.get(job_id)
    if variant == "source":
        path = ROOT / "outputs" / str(job_id) / "source-score.abc"
        if not path.is_file():
            raise HTTPException(404, "该任务没有保存的原始乐谱")
        return PlainTextResponse(path.read_text(encoding="utf-8"))
    if job["status"] != "completed":
        raise HTTPException(409, "乐谱尚未生成完成")
    if not job["output"]["has_score"]:
        raise HTTPException(404, "直接生成模式不提供 ABC 乐谱")
    path = ROOT / "outputs" / str(job_id) / "score.abc"
    if not path.is_file():
        raise HTTPException(410, "乐谱文件已不可用；任务记录仍保留")
    return PlainTextResponse(path.read_text(encoding="utf-8"))
