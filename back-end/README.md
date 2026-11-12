# socrates-backend

Node/Fastify orchestrator for Socrates.io. It serves the static front-end,
streams DeepSeek replies over Server-Sent Events, builds mode- and
language-aware system prompts, splits replies into speech-sized sentences,
proxies speech requests to the native Qwen3-TTS MLX sidecar, and stores
end-of-session learning summaries in MongoDB.

## Requirements

- Node.js 24+
- npm
- A DeepSeek API key for live chat
- MongoDB 7+ for learning summaries (`MONGODB_URI`)
- Docker Desktop (recommended for this service) or a native Node environment
- The `server-voz` sidecar running for real speech; `TTS_PROVIDER=mock` is
  available for UI work without the model

## Run natively

```bash
cd back-end
npm install
npm run dev
```

The dev server loads `../.env` and serves the front-end at
<http://127.0.0.1:3000>. It expects MongoDB at `mongodb://127.0.0.1:27017`
(configurable through `MONGODB_URI`).

## Start the TTS sidecar

The speech sidecar runs natively because MLX/Metal is not available inside
Docker. Put the external checkout path in `../.env`:

```bash
MLX_PROJECT_DIR=/path/to/qwen3-tts-apple-silicon
```

Then, from `back-end`:

```bash
npm run tts
```

The script starts the external venv's `uvicorn` with `server-voz/app.py` on
`0.0.0.0:8880`. Override the bind/port with `MLX_HOST` and `MLX_PORT`. Wait for
`GET http://127.0.0.1:8880/health` to report `"ready": true`; the Docker app
reaches the sidecar through `host.docker.internal:8880`. Press Ctrl+C to stop.

## Run with Docker

```bash
# Start Docker Desktop and make sure the docker CLI is on PATH.
docker compose up -d --build
```

Compose starts the app and a `mongo:7` service with the `mongo-data` volume.
The container serves the app at <http://127.0.0.1:3000>, reads `.env` through
`env_file`, reaches the host sidecar at `host.docker.internal:8880`, and
connects to MongoDB at `mongodb://mongo:27017`. The `.env` file and the model
are not baked into the image.

## What a turn does

1. The front-end posts `{ messages, kickoff, language, mode }` to
   `/api/chat`.
2. The prompt builder selects the interview or learning prompt, injects the
   requested language and mode, and sends the history to DeepSeek.
3. The provider streams tokens. Every token is forwarded as a `token` event;
   the sentence splitter also emits `sentence` events with an `index` and a
   speech-friendly `text`.
4. The front-end requests `/api/tts/stream` once per sentence. The Node proxy
   forwards it to the MLX sidecar.
5. The front-end decodes the returned WAV chunks, trims edge silence, and
   schedules them with the Web Audio API. The assistant transcript is revealed
   sentence by sentence when its audio starts; the full text is kept in history.

If the streaming request fails before the first byte of audio, the front-end
falls back to `/api/tts` for a complete sentence.

## Learning summaries

Every session creates a document in `sessions` with the local `ownerId`
configured by `OWNER_ID` (default `socrates-local`). The server uses that owner
for every request, so all browsers on the same instance share the same sessions
and summaries; there is no authentication. When the user clicks
**Encerrar conversa**, the front-end sends the transcript to
`POST /api/sessions/:id/end`. The backend stores the transcript, marks the
session as ended and generates one summary document asynchronously with
DeepSeek JSON mode. The front-end polls `GET /api/sessions/:id/summary` and
renders the result in the end-of-session screen; **Meus resumos** reopens saved
summaries later.

The summary is organized by concept (`sections`) with key points, an example,
an analogy, a common mistake, a check question and flashcards, plus open
questions and next steps. The model response is normalized and validated in
`src/sessions/summary-schema.js` before it is stored; invalid JSON gets one
repair attempt and is then marked as failed so the UI can offer a retry.

Collections:

- `sessions` — owner, mode, language, voice, transcript, status and timestamps.
- `summaries` — one document per session: title, overview, sections, open
  questions, next steps, concept index, status (`generating`, `ready`,
  `failed`), model and prompt version.

The summary feature degrades gracefully: if MongoDB is unavailable, chat and
TTS keep working and the session endpoints return HTTP 503.

## Conversation modes

- **Interview** (`interview`, default) — Socratic questioning. When the user
  says they do not know, does not understand, or gives an incomplete, partial
  or uncertain answer, the assistant teaches the missing idea with a short
  example and returns with a checking question.
- **Learning** (`learning`) — friendly tutoring. One idea at a time, examples,
  analogies, short checks and spaced recall to help retention. The kickoff asks
  which topic the user wants to learn.

The mode is part of the system prompt and is validated by `/api/chat`. Missing
mode defaults to `interview`; an unknown mode returns HTTP 400.

The mode and language prompts are in `src/chat/prompt.js`; the mode catalog is
in `src/chat/modes.js`.

## Language and voice

The front-end sends an optional `language` and `speaker` on TTS requests and a
`language` on chat requests. The Node validates both against its catalogs:

- 10 languages: Portuguese (default), English, Spanish, French, Italian,
  German, Japanese, Korean, Chinese and Russian.
- 9 voices: Serena (default), Vivian, Ono Anna, Sohee, Ryan, Aiden, Dylan, Eric
  and Uncle Fu.

The catalog is exposed by `GET /api/voices` along with the modes and preview
samples. A missing value falls back to the configured default; invalid values
return HTTP 400.

## Routes

| Route | Description |
| --- | --- |
| `GET /api/health` | Chat availability, TTS provider and DeepSeek key status |
| `GET /api/voices` | Mode, voice, language and preview catalogs |
| `POST /api/chat` | `{ messages, kickoff, language?, mode? }` → SSE with `token`, `sentence`, `done`, `error` |
| `POST /api/tts` | `{ text, language?, speaker? }` → `audio/wav` |
| `POST /api/tts/stream` | The same body → SSE with base64 WAV chunks and `done` |
| `POST /api/sessions` | `{ mode?, language?, voice? }` → `{ sessionId }` |
| `POST /api/sessions/:id/end` | `{ messages }` → 202 while the summary is generated |
| `GET /api/sessions/:id/summary` | Summary (200), generating (202) or failed (502) |
| `POST /api/sessions/:id/summary/retry` | Regenerates a failed summary |
| `GET /api/sessions` | Recent summaries for the local owner |
| `GET /*` | Static front-end |

## TTS and audio

- `TTS_PROVIDER=qwen` proxies to the sidecar at `TTS_URL`; the Node never
  loads the model.
- `TTS_PROVIDER=mock` produces a short local WAV for development.
- The sidecar endpoint `/v1/audio/speech/stream` emits chunks from the Qwen3-TTS
  streaming generator. The Node forwards the SSE response without buffering.
- The front-end default is the smooth Web Audio path. `?whole=1` uses
  `/api/tts` for whole sentences; `?stream=1` uses the older per-chunk audio
  queue for comparison.
- The sidecar releases its model lock on the next chunk after a client abort.
- The default voice style is
  `MLX_TTS_INSTRUCT=Neutral, casual, conversational tone`.

See `../server-voz/README.md` for the model, external project and sidecar
details.

## Configuration

Copy the repository `.env.example` to `.env` and fill in the key. The Node
process reads:

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | HTTP port | `3000` |
| `HOST` | Bind address | `127.0.0.1` |
| `LOG_LEVEL` | Fastify log level | `info` |
| `FRONTEND_DIR` | Static directory | `front-end` |
| `DEEPSEEK_API_KEY` | DeepSeek key (required for live chat) | — |
| `DEEPSEEK_BASE_URL` | DeepSeek base URL | `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | Chat model | `deepseek-chat` |
| `TTS_PROVIDER` | `qwen` or `mock` | `qwen` |
| `TTS_URL` | MLX sidecar base URL | `http://127.0.0.1:8880` |
| `TTS_SPEAKER` | Initial voice | `Serena` |
| `TTS_LANGUAGE` | Initial TTS language | `portuguese` |
| `TTS_TIMEOUT_MS` | TTS timeout | `45000` |
| `MONGODB_URI` | MongoDB connection string | `mongodb://127.0.0.1:27017` |
| `MONGODB_DB` | Database name | `socrates` |
| `OWNER_ID` | Local owner shared by all browsers | `socrates-local` |

Inside Docker, `TTS_URL` must be `http://host.docker.internal:8880` on macOS.
The `.env` key is server-side only and is never sent to the browser.

## Tests

```bash
npm test
```

29 tests cover health and static serving, 404 handling, prompt and kickoff
behavior for both modes, the partial-answer teaching rule, language selection,
mode validation, history limits, SSE chat, provider errors, sentence splitting,
CJK punctuation, the mock TTS and streaming TTS endpoints, and the modes,
voices and languages catalog.

Six additional tests cover the learning summary: schema normalization, concept
slugging, duplicate section merging, the section limit, JSON extraction from
Markdown fences and the summary prompt.

## Latency

With a warm MLX model, the first spoken reply starts around 2.6–2.7 seconds on
the current machine, including DeepSeek and the first TTS chunk. The full
sentence audio is delivered in 2-second chunks, trimmed and crossfaded in the
browser, with a 220 ms pause between sentences. Whole-sentence mode increases
the first-audio wait. These numbers depend on the model, language, sentence
length and hardware.
