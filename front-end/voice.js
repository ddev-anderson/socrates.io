import { iterateSSE } from "./sse.js";

const SPEECH_LANG = "pt-BR";
const SPEECH_END = /[.!?…。！？]["'”’)]*$/;
const STREAM_TRIM_THRESHOLD = 0.003;
const STREAM_TRIM_MARGIN_SECONDS = 0.005;
const STREAM_CROSSFADE_SECONDS = 0.03;
const STREAM_LOOKAHEAD_SECONDS = 0.08;

function normalizeSpeechText(text) {
  const value = String(text ?? "").trim();
  if (!value || SPEECH_END.test(value)) return value;
  return `${value}.`;
}

/* ============================================================
   Reconhecimento de fala (Web Speech API, Chrome/Edge)
   ============================================================ */

export function createRecognizer({
  lang = SPEECH_LANG,
  onInterim,
  onFinal,
  onError,
  onEnd,
} = {}) {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) return null;

  const recognition = new SpeechRecognition();
  recognition.lang = lang;
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  let active = false;

  recognition.onstart = () => {
    active = true;
  };

  recognition.onresult = (event) => {
    let interim = "";
    let final = "";

    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const transcript = result[0]?.transcript ?? "";
      if (result.isFinal) final += transcript;
      else interim += transcript;
    }

    if (interim.trim()) onInterim?.(interim.trim());
    if (final.trim()) onFinal?.(final.trim());
  };

  recognition.onerror = (event) => {
    onError?.(event.error, event);
  };

  recognition.onend = () => {
    active = false;
    onEnd?.();
  };

  return {
    start() {
      if (active) return;
      try {
        recognition.start();
      } catch {
        /* InvalidStateError — já iniciado */
      }
    },
    stop() {
      try {
        recognition.stop();
      } catch {
        /* noop */
      }
    },
    abort() {
      try {
        recognition.abort();
      } catch {
        /* noop */
      }
    },
    setLang(lang) {
      if (typeof lang !== "string" || !lang.trim()) return;
      recognition.lang = lang.trim();
    },
    get active() {
      return active;
    },
  };
}

/* ============================================================
   Reprodução de voz
   - modo live: POST /api/tts devolve um blob de áudio
   - modo demo: speechSynthesis do navegador
   O nível de áudio alimenta a animação do orbe (--level).
   ============================================================ */

export function createVoicePlayer({
  audioEl,
  onLevel = () => {},
  getMode = () => "demo",
} = {}) {
  let ctx = null;
  let analyser = null;
  let meterRaf = 0;
  let meterActive = false;
  let playEpoch = 0;
  let pendingFinish = null;
  let activeStream = null;
  let voices = [];

  const synth = "speechSynthesis" in window ? window.speechSynthesis : null;

  function loadVoices() {
    if (!synth) return;
    voices = synth.getVoices();
  }

  if (synth) {
    loadVoices();
    synth.addEventListener?.("voiceschanged", loadVoices);
  }

  function pickVoice() {
    if (!voices.length) loadVoices();
    const portuguese = voices.filter((v) => /^pt/i.test(v.lang));
    if (!portuguese.length) return null;
    const brazilian = portuguese.filter((v) => /br/i.test(v.lang));
    const pool = brazilian.length ? brazilian : portuguese;
    return pool.find((v) => v.localService) || pool[0];
  }

  function ensureContext() {
    if (ctx) {
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      return true;
    }

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return false;

    try {
      ctx = new AudioCtx();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.7;

      const source = ctx.createMediaElementSource(audioEl);
      source.connect(analyser);
      analyser.connect(ctx.destination);

      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      return true;
    } catch {
      ctx = null;
      analyser = null;
      return false;
    }
  }

  function stopMeter() {
    meterActive = false;
    cancelAnimationFrame(meterRaf);
    meterRaf = 0;
    onLevel(0);
  }

  function startMeter(mode) {
    stopMeter();
    meterActive = true;

    const data = analyser ? new Uint8Array(analyser.fftSize) : null;
    const startedAt = performance.now();
    let smooth = 0;

    const tick = () => {
      if (!meterActive) return;

      let target;

      if (mode === "real" && analyser && data) {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i += 1) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        target = Math.min(1, Math.sqrt(sum / data.length) * 5);
        smooth = smooth * 0.7 + target * 0.3;
      } else {
        const t = (performance.now() - startedAt) / 1000;
        const wave = 0.5 + 0.5 * Math.sin(t * 7.7);
        const flutter = 0.5 + 0.5 * Math.sin(t * 17.3 + 1.2);
        smooth = Math.min(0.95, 0.2 + wave * 0.36 + flutter * 0.12 + Math.random() * 0.05);
      }

      onLevel(smooth);
      meterRaf = requestAnimationFrame(tick);
    };

    tick();
  }

  function releasePending() {
    if (!pendingFinish) return;
    const finish = pendingFinish;
    pendingFinish = null;
    finish();
  }

  function stop() {
    playEpoch += 1;
    if (activeStream) cancelStream(activeStream);
    releasePending();
    stopMeter();

    try {
      audioEl.pause();
      audioEl.removeAttribute("src");
      audioEl.load();
    } catch {
      /* noop */
    }

    synth?.cancel();
  }

  function stopSynthetic() {
    if (!synth) return;
    try {
      synth.cancel();
    } catch {
      /* noop */
    }
  }

  function playSynthetic(text) {
    return new Promise((resolve) => {
      const epoch = ++playEpoch;
      let settled = false;
      let watchdog = 0;

      const finish = () => {
        if (settled) return;
        settled = true;
        pendingFinish = null;
        window.clearTimeout(watchdog);
        stopMeter();
        resolve();
      };

      pendingFinish = finish;

      if (!synth) {
        const fallbackMs = Math.min(9000, Math.max(1400, text.length * 55));
        startMeter("synthetic");
        watchdog = window.setTimeout(() => {
          if (epoch === playEpoch) finish();
        }, fallbackMs);
        return;
      }

      // Se o motor de voz do navegador nunca disparar onend, o fluxo não trava.
      watchdog = window.setTimeout(
        finish,
        Math.min(20000, Math.max(4000, text.length * 90)),
      );

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = SPEECH_LANG;
      utterance.rate = 1;
      utterance.pitch = 0.92;
      utterance.volume = 1;

      const voice = pickVoice();
      if (voice) utterance.voice = voice;

      utterance.onend = finish;
      utterance.onerror = finish;

      stopSynthetic();
      synth.speak(utterance);
      startMeter("synthetic");
    });
  }

  function playAudio(url) {
    return new Promise((resolve, reject) => {
      const epoch = ++playEpoch;
      let settled = false;

      const finish = (error) => {
        if (settled) return;
        settled = true;
        pendingFinish = null;
        audioEl.onended = null;
        audioEl.onerror = null;
        stopMeter();
        if (error) reject(error);
        else resolve();
      };

      pendingFinish = () => finish();

      audioEl.onended = () => finish();
      audioEl.onerror = () => finish(new Error("Falha ao reproduzir o áudio"));

      audioEl.src = url;
      audioEl.play().then(
        () => {
          if (epoch === playEpoch && !settled) {
            startMeter(analyser ? "real" : "synthetic");
          }
        },
        (error) => finish(error),
      );
    });
  }

  /* ---------- streaming contínuo (Web Audio) ---------- */

  function streamTrimmedSlice(buffer) {
    const channels = buffer.numberOfChannels;
    const data = [];

    for (let c = 0; c < channels; c += 1) {
      data.push(buffer.getChannelData(c));
    }

    const length = buffer.length;
    const silent = (index) =>
      data.every((channel) => Math.abs(channel[index]) < STREAM_TRIM_THRESHOLD);

    let first = 0;
    while (first < length && silent(first)) first += 1;

    let last = length - 1;
    while (last >= first && silent(last)) last -= 1;

    if (first >= length || last < first) return null;

    const margin = Math.round(STREAM_TRIM_MARGIN_SECONDS * buffer.sampleRate);
    first = Math.max(0, first - margin);
    last = Math.min(length - 1, last + margin);

    return {
      offset: first / buffer.sampleRate,
      duration: (last - first + 1) / buffer.sampleRate,
    };
  }

  function scheduleStreamSlice(state, slice) {
    if (state.cancelled || !ctx) return;

    const { buffer, offset, duration } = slice;
    if (!(duration > 0)) return;

    const start = Math.max(state.nextStart, ctx.currentTime + 0.02);
    const end = start + duration;
    const fade = Math.min(STREAM_CROSSFADE_SECONDS, duration / 3);
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();

    source.buffer = buffer;
    source.connect(gain);
    gain.connect(analyser);

    if (state.scheduledCount === 0) {
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(
        1,
        start + Math.min(0.008, duration / 4),
      );
    } else {
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(1, start + fade);
    }

    gain.gain.setValueAtTime(1, Math.max(start, end - fade));
    gain.gain.linearRampToValueAtTime(0.0001, end);

    source.start(start, offset, duration);
    source.onended = () => {
      state.endedCount += 1;
      state.activeSources.delete(source);
      try {
        gain.disconnect();
      } catch {
        /* noop */
      }
      maybeFinishStream(state);
    };

    state.activeSources.add(source);
    state.scheduledCount += 1;
    state.nextStart = end - fade;
  }

  function scheduleStreamBuffers(state) {
    while (state.scheduledIndex < state.buffers.length) {
      const slice = state.buffers[state.scheduledIndex];
      state.scheduledIndex += 1;
      scheduleStreamSlice(state, slice);
    }
  }

  function maybeFinishStream(state) {
    if (!state.started || state.cancelled || state.playSettled) return;
    if (!state.done) return;
    if (state.scheduledIndex < state.buffers.length) return;
    if (state.endedCount < state.scheduledCount) return;

    state.playSettled = true;
    if (activeStream === state) activeStream = null;
    stopMeter();
    state.playResolve?.();
  }

  function cancelStream(state) {
    if (!state) return;

    state.cancelled = true;
    state.done = true;

    for (const source of state.activeSources) {
      try {
        source.stop();
      } catch {
        /* noop */
      }
      try {
        source.disconnect();
      } catch {
        /* noop */
      }
    }
    state.activeSources.clear();

    if (!state.playSettled) {
      state.playSettled = true;
      state.playResolve?.();
    }

    if (activeStream === state) activeStream = null;
    stopMeter();
  }

  function prepareStream(text, { signal, speaker, language } = {}) {
    if (!ensureContext() || !ctx) {
      return Promise.reject(new Error("AudioContext indisponível"));
    }
    if (ctx.state === "suspended") ctx.resume().catch(() => {});

    const body = { text: normalizeSpeechText(text) };
    if (speaker) body.speaker = speaker;
    if (language) body.language = language;

    const state = {
      kind: "stream",
      buffers: [],
      scheduledIndex: 0,
      scheduledCount: 0,
      endedCount: 0,
      done: false,
      error: null,
      cancelled: false,
      started: false,
      playSettled: false,
      firstSettled: false,
      nextStart: 0,
      activeSources: new Set(),
      resolveFirst: null,
      rejectFirst: null,
      playResolve: null,
      playPromise: null,
    };

    state.firstPromise = new Promise((resolve, reject) => {
      state.resolveFirst = resolve;
      state.rejectFirst = reject;
    });

    state.playPromise = new Promise((resolve) => {
      state.playResolve = resolve;
    });
    state.playPromise.catch(() => {});

    (async () => {
      try {
        const response = await fetch("/api/tts/stream", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify(body),
          signal,
        });

        if (!response.ok) {
          throw new Error(`TTS stream respondeu ${response.status}`);
        }

        const type = (response.headers.get("content-type") || "").toLowerCase();
        if (!type.includes("text/event-stream")) {
          throw new Error("TTS stream não retornou SSE");
        }
        if (!response.body) throw new Error("TTS stream sem corpo");

        for await (const event of iterateSSE(response)) {
          if (state.cancelled) return;

          let payload;
          try {
            payload = JSON.parse(event.data);
          } catch {
            continue;
          }

          if (payload?.type === "error") {
            throw new Error(payload.message || "erro no TTS em streaming");
          }
          if (typeof payload?.audio !== "string" || !payload.audio) continue;

          const bytes = Uint8Array.from(atob(payload.audio), (char) =>
            char.charCodeAt(0),
          );
          const wav = bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          );
          const buffer = await ctx.decodeAudioData(wav);
          if (state.cancelled) return;

          const slice = streamTrimmedSlice(buffer);
          if (!slice) continue;

          state.buffers.push({ buffer, ...slice });

          if (!state.firstSettled) {
            state.firstSettled = true;
            state.resolveFirst(state);
          }

          if (state.started) scheduleStreamBuffers(state);
          maybeFinishStream(state);
        }

        state.done = true;

        if (!state.firstSettled) {
          state.firstSettled = true;
          state.error = new Error("TTS stream sem áudio");
          state.rejectFirst(state.error);
        }

        maybeFinishStream(state);
      } catch (error) {
        if (state.cancelled) return;

        state.error = error;
        state.done = true;

        if (!state.firstSettled) {
          state.firstSettled = true;
          state.rejectFirst(error);
        }

        maybeFinishStream(state);
      }
    })();

    return state.firstPromise;
  }

  function playStream(state) {
    if (!state || state.kind !== "stream") return Promise.resolve();
    if (state.cancelled) return Promise.resolve();
    if (state.started) return state.playPromise;
    if (!ensureContext() || !ctx) {
      return Promise.reject(new Error("AudioContext indisponível"));
    }
    if (ctx.state === "suspended") ctx.resume().catch(() => {});

    if (activeStream && activeStream !== state) cancelStream(activeStream);

    state.started = true;
    state.epoch = ++playEpoch;
    activeStream = state;
    state.nextStart = ctx.currentTime + STREAM_LOOKAHEAD_SECONDS;

    scheduleStreamBuffers(state);
    startMeter("real");
    maybeFinishStream(state);

    return state.playPromise;
  }

  async function prepare(text, { signal, speaker, language } = {}) {
    const spokenText = normalizeSpeechText(text);

    if (getMode() !== "live") {
      return { kind: "speech", text: spokenText };
    }

    const body = { text: spokenText };
    if (speaker) body.speaker = speaker;
    if (language) body.language = language;

    const response = await fetch("/api/tts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "audio/wav, audio/*",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      throw new Error(`TTS respondeu ${response.status}`);
    }

    const type = (response.headers.get("content-type") || "").toLowerCase();
    if (type.includes("application/json")) {
      throw new Error("TTS retornou um erro em JSON");
    }

    const blob = await response.blob();
    if (!blob.size) throw new Error("TTS retornou áudio vazio");

    return { kind: "blob", url: URL.createObjectURL(blob) };
  }

  function play(prepared) {
    if (!prepared) return Promise.resolve();
    if (prepared.kind === "speech") return playSynthetic(prepared.text);
    if (prepared.kind === "stream") return playStream(prepared);

    ensureContext();
    return playAudio(prepared.url);
  }

  return {
    // cria o AudioContext dentro do gesto do usuário (evita autoplay bloqueado)
    unlock() {
      ensureContext();
    },
    prepare,
    prepareStream,
    play,
    stop,
  };
}

/**
 * Consome /api/tts/stream e entrega cada chunk de áudio assim que chega.
 * O chamador é dono dos object URLs e deve revogá-los após tocar.
 */
export async function* streamSpeech(text, { signal, speaker, language } = {}) {
  const body = { text: normalizeSpeechText(text) };
  if (speaker) body.speaker = speaker;
  if (language) body.language = language;

  const response = await fetch("/api/tts/stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    throw new Error(`TTS stream respondeu ${response.status}`);
  }

  const type = (response.headers.get("content-type") || "").toLowerCase();
  if (!type.includes("text/event-stream")) {
    throw new Error("TTS stream não retornou SSE");
  }

  let nextIndex = 0;

  for await (const event of iterateSSE(response)) {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      continue;
    }

    if (payload?.type === "error") {
      throw new Error(payload.message || "erro no TTS em streaming");
    }

    if (typeof payload?.audio !== "string" || !payload.audio) continue;

    let bytes;
    try {
      bytes = Uint8Array.from(atob(payload.audio), (char) => char.charCodeAt(0));
    } catch {
      continue;
    }
    if (!bytes.length) continue;

    const chunk = new Blob([bytes], { type: "audio/wav" });
    const index = Number.isFinite(payload.index) ? payload.index : nextIndex;
    nextIndex = Math.max(nextIndex, index + 1);

    yield {
      index,
      url: URL.createObjectURL(chunk),
      final: Boolean(payload.final),
    };
  }
}
