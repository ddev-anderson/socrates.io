# server-voz — Qwen3-TTS MLX

Local HTTP sidecar for Socrates.io. It serves speech synthesis with the
**Qwen3-TTS 1.7B CustomVoice 8-bit** model through the `qwen3-tts-apple-silicon`
MLX project and `mlx-audio`. No cloud TTS is used.

## External dependency (not vendored)

The speech model and its Python environment live in a separate checkout:

- `qwen3-tts-apple-silicon` — Apple Silicon MLX port of Qwen3-TTS
- `mlx-audio` and `mlx` — MLX inference and audio utilities
- Model: `Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit` (about 2.9 GB)
- Expected model path inside the checkout:
  `models/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit`
- Python 3.12 virtual environment with `fastapi`, `uvicorn`, `soundfile`,
  `numpy`, `mlx` and `mlx-audio`

The adapter is `server-voz/app.py` in this repository. The external project's
`main.py` is not modified.

## Voices and languages

The checkpoint has **9 CustomVoice speakers**:

Serena (default), Vivian, Ono Anna, Sohee, Ryan, Aiden, Dylan, Eric and Uncle Fu.

Chelsie and Ethan appear in the Qwen documentation but are not present in this
checkpoint (`get_supported_speakers` excludes them); they are not offered by the
catalog.

The **10 languages** exposed by the sidecar and UI are Portuguese (default),
English, Spanish, French, Italian, German, Japanese, Korean, Chinese and
Russian. The model also accepts `auto`, but `auto` is omitted from the UI because
speech recognition and the chat prompt need a concrete locale.

The Node `/api/voices` endpoint exposes the voice and language catalogs and the
preview samples. The selected voice and language are sent on every TTS request.

## Setup

The external project is not included in this repository. Use an existing
checkout or clone it from its repository, then create or reuse its Python
environment and download the model:

```bash
# Point this to the qwen3-tts-apple-silicon checkout.
export MLX_PROJECT_DIR="..."

# Create the environment if needed.
python3.12 -m venv "$MLX_PROJECT_DIR/.venv"
"$MLX_PROJECT_DIR/.venv/bin/pip" install -r "$MLX_PROJECT_DIR/requirements.txt"
"$MLX_PROJECT_DIR/.venv/bin/pip" install fastapi uvicorn numpy soundfile

# The model must exist at this path.
export MLX_MODEL_DIR="$MLX_PROJECT_DIR/models/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit"
```

The sidecar requires `MLX_PROJECT_DIR` to point to the checkout. If
`MLX_MODEL_DIR` is omitted, the adapter derives the default location from
`MLX_PROJECT_DIR`.

## Run

```bash
cd server-voz
export MLX_PROJECT_DIR="..."
"$MLX_PROJECT_DIR/.venv/bin/uvicorn" app:app --host 0.0.0.0 --port 8880
```

Binding to `0.0.0.0` lets the Node container reach the sidecar through
`host.docker.internal:8880`. Wait for the model to load and check:

```bash
curl http://127.0.0.1:8880/health
```

`"ready": true` means the model is loaded and the sidecar is accepting
requests.

## Environment

| Variable | Purpose | Default |
| --- | --- | --- |
| `MLX_PROJECT_DIR` | External Qwen3-TTS checkout | required |
| `MLX_MODEL_DIR` | Checkpoint directory | `<project>/models/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit` |
| `MLX_TTS_SPEAKER` | Default speaker | `Serena` |
| `MLX_TTS_LANGUAGE` | Default language | `portuguese` |
| `MLX_TTS_INSTRUCT` | Voice style instruction | `Neutral, casual, conversational tone` |
| `MLX_TTS_SPEED` | Speech speed | `1.0` |
| `MLX_STREAMING_INTERVAL` | Audio seconds per streamed chunk | `2.0` |

## Endpoints

- `GET /health` — readiness, loading state, model path, speaker, language,
  instruction, sample rate, load/warm-up times, last generation and streaming
  configuration.
- `POST /v1/audio/speech` — `{ text, language?, speaker?, instruct?, speed? }`
  → a complete `audio/wav` response at 24 kHz mono PCM 16-bit.
- `POST /v1/audio/speech/stream` — the same body → SSE. Each audio event
  contains a complete WAV chunk in base64:

```text
data: {"index":0,"audio":"UklGR...","final":false,"sample_rate":24000,"audio_ms":1920}
data: {"index":1,"audio":"UklGR...","final":false,"sample_rate":24000,"audio_ms":1920}
data: {"index":2,"audio":"UklGR...","final":true,"sample_rate":24000,"audio_ms":400}
data: {"type":"done","chunks":3,"total_ms":7630}
```

Errors during generation are emitted as
`{"type":"error","message":"..."}`.

## Streaming and cancellation

The model generates audio tokens at 12.5 Hz. `MLX_STREAMING_INTERVAL=2.0`
means roughly 2 seconds of audio per chunk. A smaller interval lowers the
first-chunk latency but increases the decoder overhead because each chunk
re-decodes overlapping context; a larger interval does the opposite. `2.0`
keeps the measured generation ahead of playback for this setup.

A worker thread owns the model lock for a generation. When the client aborts,
a cancellation flag is set and the lock is released on the next chunk (at most
about 2 seconds later), so the next request is not left waiting forever.

The front-end receives these chunks through the Node proxy, decodes them,
removes edge silence, and schedules them in the Web Audio API with a 30 ms
crossfade. A 220 ms pause separates sentences. The Node `/api/tts` endpoint
remains available as a whole-sentence fallback and for voice previews.

## Measurements

On the current Apple Silicon machine:

- Model load: about 1.7 seconds
- Warm-up: about 1.1–1.5 seconds
- Short non-streaming sentence: about 1.2 seconds of generation
- ~90-character sentence: about 5.3 seconds of generation
- 108-character sentence with the 2-second stream interval: first chunk about
  1.45 seconds; 7.6 seconds of generation for 8.2 seconds of audio
- 37-character greeting through Node and Docker: first chunk about 1.44 seconds
- End-to-end first speech with smooth Web Audio: about 2.6 seconds for the
  greeting and about 2.7 seconds at the start of a long turn

These numbers depend on the model, language, text length, hardware and thermal
state.

## Notes and limitations

- The real TTS requires Apple Silicon and MLX; the sidecar is not intended for
  Intel Macs, Linux GPU hosts or Docker on macOS.
- The model is large and is not stored in this repository.
- The sidecar has no authentication; keep it on localhost or a trusted local
  network.
- The adapter serializes model generations. A parallel text conversation is
  fine, but only one TTS generation is active at a time.
