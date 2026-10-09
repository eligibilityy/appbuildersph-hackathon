"""Local text-to-speech with Piper (CPU)."""
import threading
import time
import uuid
import wave

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

import config

router = APIRouter()
_voice = None
_voice_lock = threading.Lock()
_synthesis_lock = threading.Lock()


def _get_voice():
    global _voice
    if _voice is None:
        with _voice_lock:
            if _voice is None:
                from piper import PiperVoice

                _voice = PiperVoice.load(str(config.PIPER_VOICE))
    return _voice


def speak(text: str) -> str | None:
    """Synthesize speech and return its local WAV URL, or None for empty text."""
    text = text.strip()
    if not text:
        return None
    from piper import SynthesisConfig

    clip_id = uuid.uuid4().hex
    path = config.TTS_DIR / f"{clip_id}.wav"
    started = time.perf_counter()
    try:
        # Piper's voice instance is shared; keep its synthesis calls serial.
        with _synthesis_lock:
            voice = _get_voice()
            with wave.open(str(path), "wb") as wav_file:
                voice.synthesize_wav(
                    text,
                    wav_file,
                    syn_config=SynthesisConfig(length_scale=config.PIPER_LENGTH_SCALE),
                )
    except Exception:
        path.unlink(missing_ok=True)
        raise
    elapsed = time.perf_counter() - started
    print(f"[tts] synthesized {clip_id} in {elapsed:.2f}s", flush=True)
    return f"/tts/{clip_id}.wav"


def available() -> bool:
    """True when the Piper voice files are in /models."""
    return config.PIPER_VOICE.exists() and config.PIPER_VOICE.with_suffix(".onnx.json").exists()


def warm_up() -> None:
    """Load the voice and run one throwaway synthesis, so the first brief isn't seconds late
    (and the camera loop doesn't stall on it). Call once at startup, off the main thread."""
    import io

    from piper import SynthesisConfig

    started = time.perf_counter()
    with _synthesis_lock:
        voice = _get_voice()
        with wave.open(io.BytesIO(), "wb") as wav_file:
            voice.synthesize_wav("Hello.", wav_file, syn_config=SynthesisConfig(length_scale=config.PIPER_LENGTH_SCALE))
    print(f"[tts] voice ready in {time.perf_counter() - started:.2f}s", flush=True)


@router.get("/tts/{clip_id}.wav")
def tts_file(clip_id: str):
    path = config.TTS_DIR / f"{clip_id}.wav"
    if not clip_id.isalnum() or not path.exists():
        raise HTTPException(404, "not found")
    return FileResponse(path, media_type="audio/wav")
