import asyncio
import base64
import glob
import io
import json
import os
import queue
import shutil
import tempfile
import threading
import time
import traceback
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

PROJECT_DIR_VALUE = os.environ.get("MLX_PROJECT_DIR")

if not PROJECT_DIR_VALUE:
    raise RuntimeError(
        "MLX_PROJECT_DIR must point to the qwen3-tts-apple-silicon checkout"
    )

PROJECT_DIR = Path(PROJECT_DIR_VALUE)
MODEL_DIR = Path(
    os.environ.get(
        "MLX_MODEL_DIR",
        str(PROJECT_DIR / "models" / "Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit"),
    )
)
DEFAULT_SPEAKER = os.environ.get("MLX_TTS_SPEAKER", "Serena")
DEFAULT_LANGUAGE = os.environ.get("MLX_TTS_LANGUAGE", "portuguese")
DEFAULT_INSTRUCT = os.environ.get(
    "MLX_TTS_INSTRUCT", "Neutral, casual, conversational tone"
)
DEFAULT_SPEED = float(os.environ.get("MLX_TTS_SPEED", "1.0"))
STREAMING_INTERVAL = float(os.environ.get("MLX_STREAMING_INTERVAL", "2.0"))

if STREAMING_INTERVAL <= 0:
    raise ValueError("MLX_STREAMING_INTERVAL deve ser maior que zero")

SUPPORTED_LANGUAGES = {
    "auto",
    "chinese",
    "english",
    "french",
    "german",
    "italian",
    "japanese",
    "korean",
    "portuguese",
    "russian",
    "spanish",
}

SUPPORTED_SPEAKERS = {
    "Serena",
    "Vivian",
    "Ryan",
    "Aiden",
    "Uncle_Fu",
    "Dylan",
    "Eric",
    "Ono_Anna",
    "Sohee",
}

state = {
    "ready": False,
    "loading": False,
    "error": None,
    "backend": "mlx",
    "model": str(MODEL_DIR),
    "speaker": DEFAULT_SPEAKER,
    "language": DEFAULT_LANGUAGE,
    "sample_rate": None,
    "load_seconds": None,
    "warmup_seconds": None,
    "last_generation_ms": None,
    "streaming": True,
    "streaming_interval": STREAMING_INTERVAL,
}

_model = None
_lock = threading.Lock()


def _resolve_speaker(value: Optional[str]) -> str:
    if not value:
        return DEFAULT_SPEAKER
    for name in SUPPORTED_SPEAKERS:
        if name.lower() == value.strip().lower():
            return name
    return DEFAULT_SPEAKER


def _resolve_language(value: Optional[str]) -> str:
    if not value:
        return DEFAULT_LANGUAGE
    language = value.strip().lower()
    return language if language in SUPPORTED_LANGUAGES else DEFAULT_LANGUAGE


def _wav_bytes(audio: np.ndarray, sample_rate: int) -> bytes:
    clipped = np.clip(np.asarray(audio, dtype=np.float32).reshape(-1), -1.0, 1.0)
    pcm = (clipped * 32767.0).astype(np.int16)
    buffer = io.BytesIO()
    sf.write(buffer, pcm, int(sample_rate), format="WAV", subtype="PCM_16")
    return buffer.getvalue()


def _generate(text: str, speaker: str, language: str, instruct: str, speed: float):
    from mlx_audio.tts.generate import generate_audio

    temp_dir = tempfile.mkdtemp(prefix="socrates_mlx_")
    try:
        generate_audio(
            model=_model,
            text=text,
            voice=speaker,
            instruct=instruct,
            speed=speed,
            lang_code=language,
            output_path=temp_dir,
            file_prefix="audio",
            audio_format="wav",
            join_audio=False,
            play=False,
            verbose=False,
        )

        files = sorted(glob.glob(os.path.join(temp_dir, "audio_*.wav")))
        if not files:
            raise RuntimeError("o MLX não gerou arquivo de áudio")

        chunks = []
        sample_rate = None
        for path in files:
            data, sr = sf.read(path, dtype="float32", always_2d=False)
            if sample_rate is None:
                sample_rate = int(sr)
            if data.ndim > 1:
                data = data.mean(axis=1)
            chunks.append(np.asarray(data, dtype=np.float32))

        audio = np.concatenate(chunks) if len(chunks) > 1 else chunks[0]
        audio = np.clip(audio, -1.0, 1.0)
        pcm = (audio * 32767.0).astype(np.int16)

        buffer = io.BytesIO()
        sf.write(buffer, pcm, sample_rate, format="WAV", subtype="PCM_16")
        return buffer.getvalue(), sample_rate
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def _load_model() -> None:
    global _model

    state["loading"] = True
    started = time.perf_counter()

    try:
        from mlx_audio.tts.utils import load_model

        _model = load_model(MODEL_DIR)
        state["load_seconds"] = round(time.perf_counter() - started, 2)

        warmup_started = time.perf_counter()
        with _lock:
            _audio, sr = _generate(
                "Olá, vamos começar.",
                DEFAULT_SPEAKER,
                DEFAULT_LANGUAGE,
                DEFAULT_INSTRUCT,
                DEFAULT_SPEED,
            )

        state["warmup_seconds"] = round(time.perf_counter() - warmup_started, 2)
        state["sample_rate"] = sr
        state["ready"] = True
        state["loading"] = False

        print(
            "[mlx-tts] pronto: "
            f"model={MODEL_DIR} device=mlx speaker={DEFAULT_SPEAKER} "
            f"load={state['load_seconds']}s warmup={state['warmup_seconds']}s sr={sr}",
            flush=True,
        )
    except Exception as exc:  # noqa: BLE001
        state["error"] = f"{type(exc).__name__}: {exc}"
        state["loading"] = False
        print(f"[mlx-tts] falha ao carregar: {state['error']}", flush=True)
        traceback.print_exc()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    threading.Thread(target=_load_model, daemon=True).start()
    yield


app = FastAPI(title="Socrates Qwen3-TTS MLX", lifespan=lifespan)


class SpeechRequest(BaseModel):
    text: str = Field(min_length=1, max_length=800)
    language: Optional[str] = "portuguese"
    speaker: Optional[str] = None
    instruct: Optional[str] = None
    speed: float = Field(default=1.0, ge=0.5, le=1.5)


_QUEUE_TIMEOUT = object()
_STREAM_END = object()
_QUEUE_POLL_SECONDS = 0.5


def _get_queue_item(events: queue.Queue):
    try:
        return events.get(timeout=_QUEUE_POLL_SECONDS)
    except queue.Empty:
        return _QUEUE_TIMEOUT


def _stream_worker(
    text: str,
    speaker: str,
    language: str,
    instruct: str,
    cancel: threading.Event,
    events: queue.Queue,
):
    started = time.perf_counter()
    chunk_index = 0
    results = None

    try:
        # O lock cobre toda a geração: o modelo MLX não é reentrante.
        # O cancelamento só é observado entre chunks; não interrompe um
        # forward pass em andamento, mas libera o lock no próximo chunk.
        with _lock:
            if cancel.is_set():
                return

            results = _model.generate_custom_voice(
                text=text,
                speaker=speaker,
                language=language,
                instruct=instruct,
                temperature=0.7,
                max_tokens=1200,
                stream=True,
                streaming_interval=STREAMING_INTERVAL,
            )

            try:
                for result in results:
                    if cancel.is_set():
                        break

                    # mlx-audio 0.3.1: quando o total de tokens gerados é
                    # múltiplo do tamanho do chunk, o gerador cai no caminho
                    # não-streaming e reemite o áudio inteiro. Chunks reais de
                    # streaming têm is_streaming_chunk=True; ignora o fantasma.
                    if not bool(getattr(result, "is_streaming_chunk", True)):
                        continue

                    audio = np.asarray(result.audio, dtype=np.float32).reshape(-1)
                    sample_rate = int(result.sample_rate)
                    is_final = bool(result.is_final_chunk)

                    if audio.size > 0:
                        wav = _wav_bytes(audio, sample_rate)
                        payload = {
                            "index": chunk_index,
                            "audio": base64.b64encode(wav).decode("ascii"),
                            "final": is_final,
                            "sample_rate": sample_rate,
                            "audio_ms": round((audio.size / sample_rate) * 1000),
                        }
                    else:
                        payload = {
                            "index": chunk_index,
                            "audio": None,
                            "final": is_final,
                            "sample_rate": sample_rate,
                            "audio_ms": 0,
                        }

                    events.put(payload)
                    chunk_index += 1

                    if is_final:
                        break
            finally:
                try:
                    results.close()
                except Exception:  # noqa: BLE001
                    pass

        elapsed_ms = round((time.perf_counter() - started) * 1000)
        state["last_generation_ms"] = elapsed_ms

        if not cancel.is_set():
            events.put(
                {
                    "type": "done",
                    "chunks": chunk_index,
                    "total_ms": elapsed_ms,
                }
            )
    except Exception as exc:  # noqa: BLE001
        state["last_generation_ms"] = round(
            (time.perf_counter() - started) * 1000
        )
        print(f"[mlx-tts] falha no streaming: {type(exc).__name__}: {exc}", flush=True)
        traceback.print_exc()

        if not cancel.is_set():
            events.put(
                {
                    "type": "error",
                    "message": f"Falha ao gerar áudio: {type(exc).__name__}",
                }
            )
    finally:
        events.put(_STREAM_END)


async def _stream_events(
    text: str,
    speaker: str,
    language: str,
    instruct: str,
    http_request: Request,
):
    cancel = threading.Event()
    events: queue.Queue = queue.Queue()

    worker = threading.Thread(
        target=_stream_worker,
        args=(text, speaker, language, instruct, cancel, events),
        name="mlx-tts-stream",
        daemon=True,
    )
    worker.start()

    try:
        while True:
            if await http_request.is_disconnected():
                cancel.set()
                break

            item = await asyncio.to_thread(_get_queue_item, events)

            if item is _QUEUE_TIMEOUT:
                continue
            if item is _STREAM_END:
                break

            yield f"data: {json.dumps(item)}\n\n"
    finally:
        cancel.set()


@app.get("/health")
def health():
    return {
        "ok": state["ready"],
        "ready": state["ready"],
        "loading": state["loading"],
        "error": state["error"],
        "backend": state["backend"],
        "model": state["model"],
        "device": "mlx",
        "speaker": state["speaker"],
        "language": state["language"],
        "instruct": DEFAULT_INSTRUCT,
        "sample_rate": state["sample_rate"],
        "load_seconds": state["load_seconds"],
        "warmup_seconds": state["warmup_seconds"],
        "last_generation_ms": state["last_generation_ms"],
        "streaming": state["streaming"],
        "streaming_interval": state["streaming_interval"],
    }


@app.post("/v1/audio/speech")
def speech(request: SpeechRequest):
    if not state["ready"] or _model is None:
        raise HTTPException(status_code=503, detail="modelo ainda carregando")

    text = request.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="texto vazio")

    speaker = _resolve_speaker(request.speaker)
    language = _resolve_language(request.language)
    instruct = (request.instruct or DEFAULT_INSTRUCT).strip() or DEFAULT_INSTRUCT
    speed = float(request.speed or DEFAULT_SPEED)

    started = time.perf_counter()
    with _lock:
        audio, sample_rate = _generate(text, speaker, language, instruct, speed)

    elapsed_ms = round((time.perf_counter() - started) * 1000)
    state["last_generation_ms"] = elapsed_ms

    return Response(
        content=audio,
        media_type="audio/wav",
        headers={
            "Cache-Control": "no-store",
            "X-MLX-Generation-Ms": str(elapsed_ms),
            "X-MLX-Sample-Rate": str(sample_rate),
            "X-MLX-Speaker": speaker,
            "X-MLX-Language": language,
        },
    )


@app.post("/v1/audio/speech/stream")
async def speech_stream(request: SpeechRequest, http_request: Request):
    if not state["ready"] or _model is None:
        raise HTTPException(status_code=503, detail="modelo ainda carregando")

    text = request.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="texto vazio")

    speaker = _resolve_speaker(request.speaker)
    language = _resolve_language(request.language)
    instruct = (request.instruct or DEFAULT_INSTRUCT).strip() or DEFAULT_INSTRUCT

    return StreamingResponse(
        _stream_events(text, speaker, language, instruct, http_request),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
            "X-MLX-Speaker": speaker,
            "X-MLX-Language": language,
            "X-MLX-Streaming-Interval": str(STREAMING_INTERVAL),
        },
    )
