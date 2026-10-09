"""Text-to-speech with Piper (CPU). Owner: voice & audio member.

STUB — speak() returns None until Piper is wired in. Block 1 task:
  - load PiperVoice from config.PIPER_VOICE once, lazily, on first speak()
    (piper-tts 1.8: `from piper import PiperVoice, SynthesisConfig`;
     PiperVoice.load(path); voice.synthesize_wav(text, wav_file, syn_config=SynthesisConfig(length_scale=...)))
  - write config.TTS_DIR/<id>.wav and return "/tts/<id>.wav"
  - log how long synthesis took (real numbers for the README)
"""
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

import config

router = APIRouter()


def speak(text: str) -> str | None:
    """Synthesize text. Returns the audio URL ("/tts/<id>.wav"), or None if unavailable."""
    return None


@router.get("/tts/{clip_id}.wav")
def tts_file(clip_id: str):
    path = config.TTS_DIR / f"{clip_id}.wav"
    if not clip_id.isalnum() or not path.exists():
        raise HTTPException(404, "not found")
    return FileResponse(path, media_type="audio/wav")
