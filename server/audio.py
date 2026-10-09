"""Mic audio buffering + Whisper transcription (CPU). Owner: voice & audio member.

STUB — audio is accepted and dropped. Block 2 task:
  - feed(): append PCM16 mono 16 kHz chunks to a buffer while any visit is open
    (visits.open_visit_ids()); never write raw audio to disk
  - every ~10-15 s, hand the buffer to a worker thread: faster-whisper
    (config.WHISPER_MODEL, device="cpu", compute_type="int8", vad_filter=True), loaded lazily
  - append text to each open visit's transcript, then
    hub.broadcast_threadsafe({"type": "transcript", "visit_id": ..., "text": ...})
  - the browser stops sending mic audio while our own TTS is playing, so no echo handling here
"""


def feed(pcm: bytes) -> None:
    """One ~100 ms chunk of raw PCM16 LE mono 16 kHz audio from the browser."""
    return None
