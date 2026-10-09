"""All model names and tunable constants live here so they can be swapped in one place."""
import os
from pathlib import Path

# Make sure nothing phones home. Set before any HF / model library is imported.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

SERVER_DIR = Path(__file__).resolve().parent
ROOT_DIR = SERVER_DIR.parent
DATA_DIR = SERVER_DIR / "data"
DB_PATH = DATA_DIR / "app.db"
THUMBS_DIR = DATA_DIR / "thumbs"
TTS_DIR = DATA_DIR / "tts"
MODELS_DIR = ROOT_DIR / "models"

for d in (DATA_DIR, THUMBS_DIR, TTS_DIR):
    d.mkdir(parents=True, exist_ok=True)

# --- Faces (CPU) ---
FACE_MODEL = "buffalo_s"
FACE_DET_SIZE = (320, 320)
FACE_PROVIDERS = ["CPUExecutionProvider"]

MATCH_THRESHOLD = 0.45          # cosine similarity; tune with real faces
CONFIRM_FRAMES = 5              # a track must agree on identity this many frames
MAX_EMBEDDINGS_PER_PERSON = 20
ADD_EMBEDDING_MIN_SCORE = 0.55  # only learn new angles from confident matches
ADD_EMBEDDING_MAX_SCORE = 0.80  # ...that aren't near-duplicates of what we have
ADD_EMBEDDING_EVERY_S = 10.0

# Guards against turning a bad-angle known face into a new "Unknown #N"
UNKNOWN_MIN_FACE_PX = 60        # min face box width/height
UNKNOWN_MIN_DET_SCORE = 0.65
UNKNOWN_MAX_BEST_SCORE = 0.35   # track must never have come close to a known person

TRACK_IOU = 0.3                 # IoU to associate a detection with an existing track
TRACK_MAX_MISSES = 10           # frames a track survives without a detection

# --- Visits ---
VISIT_END_SECONDS = float(os.environ.get("VISIT_END_SECONDS", 30))

# --- STT (CPU) ---
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "small")  # CPU-only fallback: "base"
WHISPER_DEVICE = "cpu"
WHISPER_COMPUTE_TYPE = "int8"
WHISPER_LANGUAGE = None          # pin to "en" if detection flips around

# --- LLM (GPU via Ollama) ---
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen3:4b")  # fallback: "qwen3:1.7b"
OLLAMA_OPTIONS = {"num_ctx": 4096}
OLLAMA_KEEP_ALIVE = -1

# --- TTS (CPU) ---
PIPER_VOICE = MODELS_DIR / "en_US-lessac-medium.onnx"
PIPER_LENGTH_SCALE = 1.15

# --- Web ---
CORS_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"]
