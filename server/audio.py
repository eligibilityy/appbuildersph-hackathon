"""In-memory PCM buffering and local faster-whisper transcription."""
from __future__ import annotations

import threading
import time

import config

_INTERVAL_SECONDS = 12
_BYTES_PER_SECOND = 16_000 * 2  # mono, signed PCM16 at 16 kHz
_buffer = bytearray()
_buffer_visits: set[int] = set()
_lock = threading.Lock()
_worker_active = False
_whisper = None
_whisper_lock = threading.Lock()


def _get_model():
    global _whisper
    if _whisper is None:
        with _whisper_lock:
            if _whisper is None:
                from faster_whisper import WhisperModel

                _whisper = WhisperModel(
                    config.WHISPER_MODEL,
                    device=config.WHISPER_DEVICE,
                    compute_type=config.WHISPER_COMPUTE_TYPE,
                )
    return _whisper


def _take_job_locked():
    global _worker_active
    if _worker_active or len(_buffer) < _INTERVAL_SECONDS * _BYTES_PER_SECOND:
        return None
    pcm = bytes(_buffer)
    _buffer.clear()
    visit_ids = set(_buffer_visits)
    _buffer_visits.clear()
    _worker_active = True
    return pcm, visit_ids


def _start_job(job):
    if job is None:
        return
    thread = threading.Thread(target=_transcribe, args=job, name="whisper-transcription", daemon=True)
    thread.start()


def feed(pcm: bytes) -> None:
    """Buffer one PCM16LE mono 16 kHz chunk only while a visit is open."""
    if not pcm:
        return
    import visits

    open_ids = set(visits.open_visit_ids())
    with _lock:
        if not open_ids:
            _buffer.clear()
            _buffer_visits.clear()
            return
        _buffer.extend(pcm)
        _buffer_visits.update(open_ids)
        job = _take_job_locked()
    _start_job(job)


def _transcribe(pcm: bytes, visit_ids: set[int]) -> None:
    global _worker_active
    started = time.perf_counter()
    try:
        import numpy as np
        import hub
        import visits

        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        segments, _info = _get_model().transcribe(
            samples,
            language=config.WHISPER_LANGUAGE,
            vad_filter=True,
        )
        text = " ".join(segment.text.strip() for segment in segments if segment.text.strip()).strip()
        if text:
            for visit_id in visits.append_transcript(visit_ids, text):
                hub.broadcast_threadsafe({"type": "transcript", "visit_id": visit_id, "text": text})
        print(f"[audio] transcribed {len(pcm) / _BYTES_PER_SECOND:.1f}s in {time.perf_counter() - started:.2f}s", flush=True)
    except Exception as exc:
        print(f"[audio] transcription failed: {exc!r}", flush=True)
    finally:
        import visits

        open_ids = set(visits.open_visit_ids())
        with _lock:
            if not open_ids:
                _buffer.clear()
                _buffer_visits.clear()
            else:
                _buffer_visits.intersection_update(open_ids)
            _worker_active = False
            next_job = _take_job_locked()
        _start_job(next_job)
