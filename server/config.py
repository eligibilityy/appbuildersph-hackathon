"""All model names and tunable constants live here so they can be swapped in one place."""
import os
from pathlib import Path

# Make sure nothing phones home. Set before any HF / model library is imported.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

SERVER_DIR = Path(__file__).resolve().parent
ROOT_DIR = SERVER_DIR.parent
DATA_DIR = Path(os.environ.get("DATA_DIR", SERVER_DIR / "data"))  # smoke test points this at a temp dir
DB_PATH = DATA_DIR / "app.db"
THUMBS_DIR = DATA_DIR / "thumbs"
TTS_DIR = DATA_DIR / "tts"
MODELS_DIR = ROOT_DIR / "models"

for d in (DATA_DIR, THUMBS_DIR, TTS_DIR):
    d.mkdir(parents=True, exist_ok=True)


# --- Feature switches ---
# Turn a feature off on a laptop that doesn't need it, e.g. FEATURE_AUDIO=0.
# A disabled feature never loads its model. Faces are always on (it's the core).
def _flag(name: str) -> bool:
    return os.environ.get(f"FEATURE_{name.upper()}", "1").lower() not in ("0", "false", "no", "off")


FEATURES = {name: _flag(name) for name in ("visits", "tts", "audio", "memory")}

# --- Faces (CPU) ---
FACE_MODEL = "buffalo_s"
# 480, not 320: glasses lower the detector's confidence, and at 320 a 640 px frame is halved before
# detection, so mid-distance faces WITH glasses were often missed entirely (never even matched).
# Measured on synthetic glasses (tests/test_faces_real_model.py): 15/21 detected at 320, 21/21 at 480,
# for ~11 -> ~14 ms per frame on the dev laptop. Drop back to 320 only if the demo laptop is too slow.
FACE_DET_SIZE = (480, 480)
FACE_PROVIDERS = ["CPUExecutionProvider"]

MATCH_THRESHOLD = 0.45          # cosine similarity; tune with real faces (tools/eval_faces.py)
MATCH_MARGIN = 0.08             # best person must beat the 2nd-best person by this much, else "not sure"
TRACK_SCORE_WINDOW = 5          # per-person scores are averaged over this many recent good frames
CONFIRM_FRAMES = 5              # a track must agree on identity this many frames
# Glasses/hats can push a genuine match just under MATCH_THRESHOLD. A track may still be confirmed if
# the SAME person stays above WEAK_MATCH_THRESHOLD, far ahead of everyone else, for WEAK_MATCH_FRAMES
# good frames in a row (~3 s at 5 fps). Weak confirmations are never learned from.
WEAK_MATCH_THRESHOLD = 0.38
WEAK_MATCH_MARGIN = 0.15
WEAK_MATCH_FRAMES = 15
MAX_EMBEDDINGS_PER_PERSON = 20
ADD_EMBEDDING_MIN_SCORE = 0.55  # only learn new angles from confident matches
ADD_EMBEDDING_MAX_SCORE = 0.80  # ...that aren't near-duplicates of what we have
ADD_EMBEDDING_EVERY_S = 10.0

# Guards against turning a bad-angle known face into a new "Unknown #N"
UNKNOWN_MIN_FACE_PX = 60        # min face box width/height
UNKNOWN_MIN_DET_SCORE = 0.65
UNKNOWN_MAX_BEST_SCORE = 0.35   # track must never have come close to a known person
UNKNOWN_MIN_SELF_SIM = 0.50     # the frames saved for a new Unknown must look like one face

# Face quality gate (faces/quality.py). Calibrated on InsightFace sample photos: normalised sharpness
# is ~110-400 for sharp faces, ~44 for a mild blur (still matches at 0.94), ~12 for a heavy blur.
# Over-exposed faces (brightness ~240) dropped to 0.40 similarity; dark ones (~30) still matched at 0.94.
QUALITY_LIVE = {"min_face_px": 40, "min_brightness": 20, "max_brightness": 235,
                "min_sharpness": 15, "max_yaw": 0.75, "pitch_range": (0.2, 1.1)}
QUALITY_ENROLL = {"min_face_px": 80, "min_brightness": 40, "max_brightness": 215,
                  "min_sharpness": 30, "max_yaw": 0.5, "pitch_range": (0.3, 0.95)}

# Enrollment
ENROLL_MIN_IMAGES = 3
ENROLL_MAX_IMAGES = 8           # 5 guided shots + up to 2-3 with/without glasses
ENROLL_MIN_SELF_SIM = 0.25      # each photo vs the others: lower -> "doesn't look like the same person"
DUPLICATE_THRESHOLD = MATCH_THRESHOLD  # enrollment photos this similar to someone saved -> ask first
ADD_PHOTOS_MIN_SIM = 0.20       # "add photos to X": photos must look at least a little like X
NOTES_MAX_CHARS = 2000          # optional person description (stored in people.notes)

TRACK_IOU = 0.3                 # IoU to associate a detection with an existing track
TRACK_MAX_MISSES = 10           # frames a track survives without a detection

# --- Visits ---
VISIT_END_SECONDS = float(os.environ.get("VISIT_END_SECONDS", 30))
MONITORING_GAP_SECONDS = float(os.environ.get("MONITORING_GAP_SECONDS", 5))

# --- STT (CPU) ---
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "base")  # CPU-only multilingual model
WHISPER_DEVICE = "cpu"
WHISPER_COMPUTE_TYPE = "int8"
# "tl" (Tagalog) handles Tagalog, Taglish and English: tested on the dev laptop, English stayed word-for-word
# while auto-detect misheard Tagalog as Latin/English/Indonesian. WHISPER_LANGUAGE=auto to auto-detect.
_whisper_language = os.environ.get("WHISPER_LANGUAGE", "tl").strip().lower()
WHISPER_LANGUAGE = None if _whisper_language in ("", "auto", "none") else _whisper_language

# --- LLM (GPU via Ollama) ---
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen3:4b")  # fallback: "qwen3:1.7b"
OLLAMA_OPTIONS = {"num_ctx": 4096}
OLLAMA_KEEP_ALIVE = -1
OLLAMA_HOST = "http://127.0.0.1:11434"  # always local; never a remote Ollama
MEMORY_MIN_WORDS = 6            # shorter transcripts are skipped (nothing worth remembering)

# --- TTS (CPU) ---
PIPER_VOICE = MODELS_DIR / "en_US-lessac-medium.onnx"
PIPER_LENGTH_SCALE = 1.15

# --- Web ---
CORS_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:3001"]
