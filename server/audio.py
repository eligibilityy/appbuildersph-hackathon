"""In-memory PCM buffering and local faster-whisper transcription.

While a visit is open, mic audio is buffered and transcribed every config.TRANSCRIBE_EVERY_SECONDS (live captions),
cut at the quietest moment near the end so a word isn't split between two chunks.
When a visit ends, memory.py calls finish_visit() before reading the transcript: it waits for any
transcription in progress, then transcribes what's left in the buffer, so a short "Hi Lola, it's
Miguel..." said just before leaving is never lost. Raw audio is never written to disk.
"""
from __future__ import annotations

import re
import threading
import time

import config

_SPLIT_SEARCH_SECONDS = 1.5  # look this far back from the end of a chunk for a pause to cut at
_MIN_FLUSH_SECONDS = 0.5  # less than this left over at visit end: nothing worth transcribing
_FINISH_WAIT_SECONDS = 60
_BYTES_PER_SECOND = 16_000 * 2  # mono, signed PCM16 at 16 kHz
_buffer = bytearray()
_buffer_visits: set[int] = set()
_lock = threading.Lock()
_idle = threading.Condition(_lock)  # notified when a transcription finishes
_worker_active = False
_whisper = None
_whisper_lock = threading.Lock()


def _get_model():
    global _whisper
    if _whisper is None:
        with _whisper_lock:
            if _whisper is None:
                from faster_whisper import WhisperModel

                try:
                    _whisper = WhisperModel(
                        config.WHISPER_MODEL,
                        device=config.WHISPER_DEVICE,
                        compute_type=config.WHISPER_COMPUTE_TYPE,
                    )
                except Exception as e:
                    if "offline" in str(e).lower() or type(e).__name__ == "LocalEntryNotFoundError":
                        raise RuntimeError(
                            f"Whisper '{config.WHISPER_MODEL}' isn't downloaded (the server runs offline). With internet "
                            f"on, run the Whisper download command in README > Models for '{config.WHISPER_MODEL}'."
                        ) from e
                    raise
    return _whisper


def warm_up() -> None:
    """Load Whisper at startup (off the main thread), so the first visit's captions aren't late."""
    started = time.perf_counter()
    _get_model()
    print(f"[audio] Whisper {config.WHISPER_MODEL} ready in {time.perf_counter() - started:.2f}s", flush=True)


def _interval_bytes() -> int:
    return int(config.TRANSCRIBE_EVERY_SECONDS * _BYTES_PER_SECOND)


def quiet_split(pcm: bytes) -> int:
    """Byte offset of the quietest 20 ms in the last _SPLIT_SEARCH_SECONDS of `pcm`: cutting there instead of
    at a fixed length keeps words whole ("...a new job in BG" + "C" becomes "...in BGC")."""
    import numpy as np

    samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32)
    frame = 320  # 20 ms at 16 kHz
    start = max(0, len(samples) - int(_SPLIT_SEARCH_SECONDS * 16_000))
    n = (len(samples) - start) // frame
    if n < 2:
        return len(pcm)
    energy = (samples[start : start + n * frame].reshape(n, frame) ** 2).mean(axis=1)
    return (start + int(np.argmin(energy)) * frame + frame // 2) * 2


def _take_locked(min_bytes: int, split: bool = False):
    """Hand the buffer to one transcription job (call with _lock held). With `split` (live captions), cut at a
    pause and keep the rest buffered for the next chunk; otherwise (end of visit) take everything."""
    global _worker_active
    if _worker_active or not _buffer_visits or len(_buffer) < min_bytes:
        return None
    cut = quiet_split(bytes(_buffer)) if split else len(_buffer)
    pcm = bytes(_buffer[:cut])
    del _buffer[:cut]
    visit_ids = set(_buffer_visits)
    if not _buffer:
        _buffer_visits.clear()  # otherwise the leftover still belongs to the same visits
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
    if not open_ids:
        # Nobody here: drop the chunk. Keep what's buffered: it belongs to a visit that just ended
        # and finish_visit() will transcribe it.
        return
    with _lock:
        _buffer.extend(pcm)
        _buffer_visits.update(open_ids)
        job = _take_locked(_interval_bytes(), split=True)
    _start_job(job)


def finish_visit(visit_id: int) -> None:
    """Called (from the memory worker) after a visit ends, before its transcript is read.
    Blocks until the visit's remaining audio has been transcribed and saved."""
    if not config.FEATURES["audio"]:
        return
    with _idle:
        # A transcription started while the visit was open must land before memory reads it.
        if not _idle.wait_for(lambda: not _worker_active, timeout=_FINISH_WAIT_SECONDS):
            print(f"[audio] visit {visit_id}: gave up waiting for transcription", flush=True)
            return
        if visit_id not in _buffer_visits:
            return
        job = _take_locked(int(_MIN_FLUSH_SECONDS * _BYTES_PER_SECOND))
        if job is None:  # too little audio to bother; drop it so it doesn't leak into the next visit
            _buffer.clear()
            _buffer_visits.clear()
    if job:
        _transcribe(*job)


def _trim_chunk_dots(text: str) -> str:
    """Whisper marks a sentence cut by the chunk edge with "...": "a new job in..." + "...BGC". Drop those
    edge dots so the caption and the saved transcript read as one sentence ("a new job in BGC")."""
    return re.sub(r"^(?:\.\.\.|…)\s*|\s*(?:\.\.\.|…)$", "", text).strip()


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
        text = _trim_chunk_dots(text)
        if text:
            for visit_id in visits.append_transcript(visit_ids, text):
                hub.broadcast_threadsafe({"type": "transcript", "visit_id": visit_id, "text": text})
        print(f"[audio] transcribed {len(pcm) / _BYTES_PER_SECOND:.1f}s in {time.perf_counter() - started:.2f}s", flush=True)
    except Exception as exc:
        print(f"[audio] transcription failed: {exc!r}", flush=True)
    finally:
        with _idle:
            _worker_active = False
            _idle.notify_all()
            next_job = _take_locked(_interval_bytes(), split=True)
        _start_job(next_job)
