# socrates-backend

Node/Fastify orchestrator for Socrates.io. It serves the static front-end,
streams DeepSeek replies over Server-Sent Events, builds mode- and
language-aware system prompts, splits replies into speech-sized sentences, and
proxies speech requests to the native Qwen3-TTS MLX sidecar.

## Requirements

- Node.js 24+
- npm
- A DeepSeek API key for live chat
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
<http://127.0.0.1:3000>.

## Run with Docker

```bash
# Start Docker Desktop and make sure the docker CLI is on PATH.
docker compose up -d --build
```

The container serves the app at <http://127.0.0.1:3000>, reads `.env` through
`env_file`, and reaches the host sidecar at `host.docker.internal:8880`. The
`.env` file and the model are not baked into the image.

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

## Latency

With a warm MLX model, the first spoken reply starts around 2.6–2.7 seconds on
the current machine, including DeepSeek and the first TTS chunk. The full
sentence audio is delivered in 2-second chunks, trimmed and crossfaded in the
browser, with a 220 ms pause between sentences. Whole-sentence mode increases
the first-audio wait. These numbers depend on the model, language, sentence
length and hardware.
