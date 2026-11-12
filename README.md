# Socrates.io

Socrates.io is a local-first voice interview and learning app. It has two
conversation modes:

- **Interview** — a Socratic technical interview. The assistant asks one
  concrete question at a time and narrows the conversation. If the candidate
  says they do not know, does not understand, or gives a partial/uncertain
  answer, the assistant teaches the missing idea with a short example and then
  returns with a follow-up question.
- **Learning** — a friendly, didactic conversation about a topic chosen by the
  user. The assistant teaches one idea at a time, uses concrete examples and
  analogies, checks understanding, and revisits concepts to help retention.

The browser captures speech, the Node/Fastify orchestrator streams replies from
DeepSeek, and a native Apple Silicon sidecar synthesizes the voice locally with
**Qwen3-TTS MLX**.

## Highlights

- Voice-first conversation with microphone input and a typed fallback.
- Two conversation modes, selectable in the UI.
- 9 voices and 10 languages, with an audio preview before you choose.
- Real streaming TTS: chunks are decoded, trimmed and crossfaded in the browser
  with the Web Audio API, with a natural pause between sentences.
- Assistant text appears only when the matching audio is available.
- Light and dark themes, a floating Document Picture-in-Picture player, and a
  browser-only demo mode.
- Local speech synthesis: the voice never leaves the machine.
- End-of-conversation learning summaries with key points, examples, check
  questions and flashcards, shown in a reader view and reopened from the
  right-side **Meus resumos** rail.
- The DeepSeek key stays on the server and is never sent to the browser.

## Architecture

```
Browser (Chrome / Edge)
  │
  │  SpeechRecognition: speech → text
  │  Web Audio: decoded TTS chunks and crossfade
  │
  ├── POST /api/chat (SSE) ───────────────► Fastify (Docker, port 3000)
  │                                              │
  │                                              ├──► DeepSeek API
  │                                              │    prompt + mode + language
  │                                              │    tokens + sentence events
  │                                              │
  │                                              ├──► MongoDB
  │                                              │    sessões + resumos
  │                                              │
  └── POST /api/tts/stream (SSE) ◄───────────────┤
                                                 │  HTTP, port 8880
                                                 ▼
                                    server-voz (FastAPI, native)
                                                 │
                                                 ▼
                              Qwen3-TTS 1.7B CustomVoice (MLX)
                              running on Apple Silicon (Metal)
```

The Node process can run in Docker because it only needs HTTP. The TTS sidecar
runs natively because Docker on macOS cannot access Metal/MPS. In Docker, the
container reaches the host sidecar through `host.docker.internal:8880`.

## Tech stack

- **Front-end:** vanilla HTML, CSS and ES modules; Web Speech API; Web Audio
  API; Document Picture-in-Picture; no build step.
- **Orchestrator:** Node.js 24, Fastify 5, `@fastify/static`, the OpenAI SDK
  pointed at DeepSeek, and Server-Sent Events.
- **Language model:** DeepSeek (`deepseek-chat` by default).
- **Speech synthesis:** Qwen3-TTS 1.7B CustomVoice 8-bit via the
  `qwen3-tts-apple-silicon` MLX project and the `mlx-audio` library, served by
  FastAPI/uvicorn. The adapter lives in `server-voz/app.py`.
- **Persistence:** MongoDB 7 stores learning sessions and their summaries.
- **Infrastructure:** Docker Compose for the Node server and MongoDB; a Python
  3.12 virtual environment for the MLX sidecar.

The Qwen3-TTS checkpoint is expected at
`models/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit` inside the external
`qwen3-tts-apple-silicon` checkout. It is **not** vendored in this repository.

## Requirements

- macOS on Apple Silicon (M-series). MLX and the real TTS need Metal.
- Node.js 24+ and npm.
- Docker Desktop (recommended for the Node server) **or** a native Node setup.
- MongoDB 7+ for the learning summaries. Docker Compose starts it
  automatically; a native setup expects `mongodb://127.0.0.1:27017`.
- Python 3.12 with the `qwen3-tts-apple-silicon` project and a virtual
  environment containing `mlx`, `mlx-audio`, `soundfile`, `fastapi`, `uvicorn`
  and `numpy`.
- The `Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit` model (about 2.9 GB), downloaded
  into the external project's `models/` directory.
- A DeepSeek API key.
- Chrome or Edge for Web Speech recognition, microphone permission and Document
  Picture-in-Picture. The app still works in demo mode without a backend.
- Ports `3000` (Node) and `8880` (TTS sidecar) free.

## Run locally

### 1. Clone and configure this repository

```bash
git clone <this-repository-url>
cd socrates.io

cp .env.example .env
chmod 600 .env
# Edit .env and set DEEPSEEK_API_KEY.
```

For local development without the MLX model, set `TTS_PROVIDER=mock` in `.env`.
The mock provider returns a short WAV blip and is useful for UI work.

### 2. Prepare the Qwen3-TTS MLX sidecar

Use your existing checkout of the external
`qwen3-tts-apple-silicon` project, or clone it from its repository. Follow that
project's instructions to download the model. A compact setup is:

```bash
# Point this to the checkout of qwen3-tts-apple-silicon.
export MLX_PROJECT_DIR="..."

# Create the Python environment if the external project does not have one.
python3.12 -m venv "$MLX_PROJECT_DIR/.venv"
"$MLX_PROJECT_DIR/.venv/bin/pip" install -r "$MLX_PROJECT_DIR/requirements.txt"
"$MLX_PROJECT_DIR/.venv/bin/pip" install fastapi uvicorn numpy soundfile

# The model must exist at this path inside the external project.
export MLX_MODEL_DIR="$MLX_PROJECT_DIR/models/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit"

cd server-voz
"$MLX_PROJECT_DIR/.venv/bin/uvicorn" app:app --host 0.0.0.0 --port 8880
```

Alternatively, set `MLX_PROJECT_DIR` in the repository `.env` and start the
sidecar from the backend with `cd back-end && npm run tts`. The script uses the
external venv and listens on `0.0.0.0:8880` by default (`MLX_PORT` overrides).

The sidecar loads the model once and exposes:

- `GET /health`
- `POST /v1/audio/speech` → full WAV
- `POST /v1/audio/speech/stream` → Server-Sent Events with WAV chunks

Wait until `GET /health` reports `"ready": true` before starting a conversation.
The default voice is **Serena**; the default language is **Portuguese**; the
default style is `Neutral, casual, conversational tone`.

### 3. Start the Node orchestrator and front-end

**Docker (recommended):**

```bash
# Docker Desktop must be running and the docker CLI must be on PATH.
docker compose up -d --build
```

The app is served at <http://127.0.0.1:3000>. The container reads `.env` through
`env_file`; the `.env` file is not copied into the image. Compose also starts a
`mongo:7` service backed by the `mongo-data` volume; the app connects to it at
`mongodb://mongo:27017`.

**Native Node:**

```bash
cd back-end
npm install
npm run dev
```

The native server also serves the front-end at
<http://127.0.0.1:3000> and loads the repository's `.env` from the parent
directory. It expects MongoDB at `MONGODB_URI`
(default `mongodb://127.0.0.1:27017`).

### 4. Use the app

1. Open <http://127.0.0.1:3000>.
2. Choose **Entrevista** or **Aprendizado** in the **modo** selector.
3. Choose a language and a voice, and use **ouvir** to preview the voice.
4. Click the orb and allow microphone access. The first turn starts the
   conversation. You can also type with the text fallback.
5. When you finish, click **Encerrar conversa** and confirm. The learning
   summary opens in the reader; the book icon in the topbar toggles the
   **Meus resumos** rail, where older summaries can be reopened, searched and
   exported.

The mode and the voice/language choices are stored in `localStorage`. The mode
is locked while a session is active; end the session before changing it.
Changing the mode with an existing transcript starts a fresh conversation so
the two modes do not share history.

## How a turn works

1. The browser turns microphone audio into text with the Web Speech API. The
   user speaks first; if the microphone is unavailable, the typed composer can
   be used.
2. The front-end posts `{ messages, kickoff, language, mode }` to `/api/chat`.
   The backend builds a system prompt for the selected mode and language and
   streams DeepSeek's answer.
3. The backend sends `token` events for the full text and `sentence` events for
   speech-sized fragments. The front-end does not paint tokens as they arrive;
   it paints a sentence when its audio starts.
4. For each sentence, the front-end calls `/api/tts/stream`. The Node proxy
   forwards the request to the native MLX sidecar. The sidecar emits WAV chunks
   from the Qwen3-TTS streaming generator.
5. The front-end decodes each chunk, trims edge silence, and schedules the
   buffers in the Web Audio API with a 30 ms crossfade. Sentences are separated
   by a 220 ms pause. This keeps the speech continuous instead of switching
   `<audio>` elements every two seconds.
6. The assistant text is revealed sentence by sentence at the same moment as
   its audio. The full text is still committed to the conversation history.
7. When the response and audio finish, the microphone is resumed automatically
   for the next turn. Clicking the orb interrupts; ending a session stops all
   playback.
8. When the user clicks **Encerrar conversa** and confirms, the front-end sends
   the transcript to `/api/sessions/:id/end`. The backend stores it in MongoDB
   and generates a concept-by-concept study summary (key points, examples,
   check questions and flashcards) that the end-of-session screen shows and
   **Meus resumos** reopens later.

### Audio modes

The default playback path is the smooth Web Audio scheduler. Two diagnostic
options are available:

- `?whole=1` — use `/api/tts` for each complete sentence. Slower first audio,
  but useful for comparing chunk behavior.
- `?stream=1` — use the older queue that plays one `<audio>` element per chunk.

## Conversation modes

### Interview

The assistant behaves like a Socratic interviewer:

- It asks one concrete question at a time and follows the candidate's answers.
- It does not give ready-made answers while the candidate is reasoning.
- If the candidate says **“I don't know”**, **“I don't know the concept”**,
  **“I don't understand”**, or gives a **partial, incomplete or uncertain**
  answer, it explains the missing piece in plain language with a short example,
  then asks a checking question to resume the interview.
- The opening asks what the candidate wants to talk about. If they have no
  topic, it offers a few short options.

### Learning

The assistant behaves like a friendly tutor:

- The opening asks what the user wants to learn. It does not assume a topic.
- It teaches one idea at a time, in everyday language, with a concrete example
  or a short analogy.
- It keeps answers short, ends with a small check, a mini quiz or an invitation
  to apply the idea, and revisits concepts over time to support retention.
- If the answer is incomplete or wrong, it validates what is right, gently
  corrects the gap with an example, and asks a recall question.
- It avoids long lectures and dumping several concepts at once.

Both modes respect the selected language, the selected voice and the same
no-markdown/speech-friendly output rules. The backend validates `mode`; invalid
values return HTTP 400, and a missing value defaults to `interview`.

## Voices and languages

The checkpoint used by this project has **9 CustomVoice speakers**:

Serena (default), Vivian, Ono Anna, Sohee, Ryan, Aiden, Dylan, Eric and Uncle Fu.

The documented Qwen speakers Chelsie and Ethan are not present in this
checkpoint and are not offered by the catalog. The **10 languages** offered in
the UI are Portuguese, English, Spanish, French, Italian, German, Japanese,
Korean, Chinese and Russian. The model also accepts `auto`, but the UI omits it
because speech recognition and the prompt need a concrete locale.

The selected voice affects both the conversation and the preview. The selected
language affects the prompt, the speech-recognition locale and the TTS. The
preview uses `/api/tts`; it is cached per voice+language and pauses the
microphone while it plays.

## Project structure

```
.
├── front-end/
│   ├── index.html              # app shell, theme bootstrap, hero, controls
│   ├── app.js                  # state machine, modes, transcript, audio queue
│   ├── voice.js                # recognition, player, smooth Web Audio stream
│   ├── sse.js                  # SSE parser for fetch streams
│   ├── style/
│   │   ├── styles.css          # themes, layout, orb, selectors
│   │   └── mini.css            # floating mini player
│   └── fonts/
│       └── InterVariable.woff2
├── back-end/
│   ├── src/
│   │   ├── server.js           # process entry point
│   │   ├── app.js              # Fastify app and route registration
│   │   ├── config.js           # environment configuration
│   │   ├── db.js               # lazy MongoDB connection and indexes
│   │   ├── languages.js        # language catalog (10 languages)
│   │   ├── chat/
│   │   │   ├── deepseek.js     # DeepSeek streaming provider
│   │   │   ├── prompt.js       # interview and learning system prompts
│   │   │   ├── modes.js        # interview / learning mode catalog
│   │   │   └── splitter.js     # sentence segmentation and sanitization
│   │   ├── routes/
│   │   │   ├── chat.js         # POST /api/chat (SSE)
│   │   │   ├── sessions.js     # sessions and learning summaries
│   │   │   ├── tts.js          # /api/voices, /api/tts, /api/tts/stream
│   │   │   └── health.js       # GET /api/health
│   │   ├── sessions/
│   │   │   ├── summary.js      # summary prompt, DeepSeek call and storage
│   │   │   └── summary-schema.js # normalization and validation
│   │   └── tts/
│   │       ├── index.js        # provider selection
│   │       ├── qwen.js         # proxy to the MLX sidecar
│   │       ├── mock.js         # local test audio
│   │       └── voices.js       # 9-voice catalog
│   ├── test/                   # Node test suite
│   ├── Dockerfile
│   └── README.md
├── server-voz/
│   ├── app.py                  # FastAPI adapter for Qwen3-TTS MLX
│   └── README.md
├── docker-compose.yml
├── .env.example
├── .dockerignore
└── README.md
```

The external Qwen project is intentionally outside this tree:

```
<qwen3-tts-apple-silicon checkout>/
├── .venv/                      # Python 3.12 environment
├── models/
│   └── Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit/
└── ...                         # model code and assets
```

The Docker image copies only `back-end/src`, the package manifests and
`front-end`. The MLX project, model weights and Python environment are never
baked into the image.

## Configuration

The Node server reads `.env` (copy `.env.example`):

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | Node HTTP port | `3000` |
| `HOST` | Node bind address | `127.0.0.1` |
| `LOG_LEVEL` | Fastify log level | `info` |
| `FRONTEND_DIR` | Front-end directory | `front-end` |
| `DEEPSEEK_API_KEY` | DeepSeek key (required for live chat) | — |
| `DEEPSEEK_BASE_URL` | DeepSeek API base URL | `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | Chat model | `deepseek-chat` |
| `TTS_PROVIDER` | `qwen` or `mock` | `qwen` |
| `TTS_URL` | MLX sidecar base URL | `http://127.0.0.1:8880` |
| `TTS_SPEAKER` | Initial voice | `Serena` |
| `TTS_LANGUAGE` | Initial TTS language | `portuguese` |
| `TTS_TIMEOUT_MS` | TTS request timeout | `45000` |
| `MONGODB_URI` | MongoDB connection string | `mongodb://127.0.0.1:27017` |
| `MONGODB_DB` | MongoDB database name | `socrates` |
| `OWNER_ID` | Local owner shared by all browsers | `socrates-local` |

The TTS sidecar reads:

| Variable | Purpose | Default |
| --- | --- | --- |
| `MLX_PROJECT_DIR` | Path to the external Qwen3-TTS checkout | required |
| `MLX_MODEL_DIR` | Path to the checkpoint | `<project>/models/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit` |
| `MLX_TTS_SPEAKER` | Default speaker | `Serena` |
| `MLX_TTS_LANGUAGE` | Default language | `portuguese` |
| `MLX_TTS_INSTRUCT` | Voice style | `Neutral, casual, conversational tone` |
| `MLX_TTS_SPEED` | Speech speed | `1.0` |
| `MLX_STREAMING_INTERVAL` | Seconds of audio per TTS chunk | `2.0` |

Do not commit `.env`; it contains the DeepSeek key. The server never logs or
sends the key to the browser.

## API

- `GET /api/health` — chat availability, TTS provider and DeepSeek key status.
- `GET /api/voices` — mode, voice, language and preview catalogs.
- `POST /api/chat` — body `{ messages, kickoff, language?, mode? }`; SSE with
  `token`, `sentence`, `done` and `error` events.
- `POST /api/tts` — `{ text, language?, speaker? }` → `audio/wav`.
- `POST /api/tts/stream` — the same body → SSE with base64 WAV chunks and a
  final `done` event.
- `POST /api/sessions` — `{ mode?, language?, voice? }` → `{ sessionId }`.
- `POST /api/sessions/:id/end` — `{ messages }` → 202 while the learning
  summary is generated.
- `GET /api/sessions/:id/summary` — summary (200), generating (202) or failed
  (502).
- `POST /api/sessions/:id/summary/retry` — regenerates a failed summary.
- `GET /api/sessions` — recent summaries for the local owner.
- `GET /*` — the static front-end.

## Tests

```bash
cd back-end
npm test
```

The Node suite has **35 tests**, including prompt/mode behavior, language
selection, SSE chat, sentence splitting, voice/language validation, the mock TTS
and the streaming TTS endpoint. The learning summary has unit tests for schema
normalization, concept slugging, duplicate section merging, the section limit,
JSON extraction from Markdown fences and the summary prompt. The browser flows
(mode switch, learning conversation, interview help, text/audio synchronization
and mobile layout) are validated with an end-to-end Chrome run.

## Latency and design notes

- The first spoken reply can start in about 2.6–2.7 seconds on a warm model
  (greeting and the first turn of a long answer), including DeepSeek and the
  first TTS chunk.
- The MLX streaming chunks are crossfaded in the browser. The older
  whole-sentence mode increases the first-audio wait.
- The real voice service loads the model once and serializes generations. It
  releases its lock on the next chunk when a client aborts.
- The model and Python environment are external; the browser and Node are
  independent of Apple Silicon other than the real TTS dependency.
- The project is intended to run locally. It has no authentication layer; do
  not expose the Node server or the TTS sidecar to untrusted networks.

## Credits and dependencies

- **Qwen3-TTS** and the
  `Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit` checkpoint, by the Qwen team.
- **`qwen3-tts-apple-silicon`**, the Apple Silicon MLX port used by the voice
  sidecar.
- **`mlx-audio`** and **MLX**, the audio and inference libraries used for local
  speech synthesis.
- **DeepSeek** for the chat model.
- **Fastify**, `@fastify/static`, the OpenAI SDK and the Inter typeface for the
  web application.

## Troubleshooting

- **`/api/health` says the TTS provider is unavailable** — check that the
  sidecar is running, `/health` reports `"ready": true`, and `TTS_URL` points to
  it. Inside Docker, use `http://host.docker.internal:8880`.
- **`MLX_PROJECT_DIR must point to the qwen3-tts-apple-silicon checkout`** —
  export `MLX_PROJECT_DIR` in the shell that starts `server-voz`.
- **The app says “modo demo”** — `/api/health` was not reachable, or
  `DEEPSEEK_API_KEY` is missing, so the front-end runs its local demo. Start the
  backend and reload.
- **No microphone** — use Chrome or Edge, allow microphone permission, or type
  with the fallback composer.
- **Slow first audio** — use a warm, loaded model and keep the network to
  DeepSeek healthy. The first chunk is also affected by the TTS language and
  sentence length.
- **Docker cannot reach the TTS sidecar** — keep the sidecar bound to
  `0.0.0.0`, use `host.docker.internal` on macOS, and use the compose
  `extra_hosts` mapping on Linux.
- **“Meus resumos” or the end-of-session summary fails** — check that MongoDB
  is running (`docker compose up -d mongo`) and that `MONGODB_URI` points to
  it. Chat and TTS keep working while the summary store is unavailable.
