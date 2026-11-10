import { readSSE } from "./sse.js";
import { createRecognizer, createVoicePlayer, streamSpeech } from "./voice.js";

/* ============================================================
   DOM
   ============================================================ */

const $ = (selector) => document.querySelector(selector);

const dom = {
  body: document.body,
  app: $("#app"),
  hero: $("#hero"),
  heroEyebrow: $("#heroEyebrow"),
  heroTitle: $("#heroTitle"),
  heroLede: $("#heroLede"),
  transcript: $("#transcript"),
  transcriptInner: $("#transcriptInner"),
  orb: $("#orb"),
  stateLabel: $("#stateLabel"),
  hint: $("#hint"),
  connection: $("#connection"),
  connectionLabel: $("#connectionLabel"),
  miniBtn: $("#miniBtn"),
  miniFallback: $("#miniFallback"),
  themeBtn: $("#themeBtn"),
  resetBtn: $("#resetBtn"),
  historyBtn: $("#historyBtn"),
  endSessionBtn: $("#endSessionBtn"),
  summaryOverlay: $("#summaryOverlay"),
  summaryKicker: $("#summaryKicker"),
  summaryTitle: $("#summaryTitle"),
  summaryBody: $("#summaryBody"),
  summaryFoot: $("#summaryFoot"),
  summaryCloseBtn: $("#summaryCloseBtn"),
  readerView: $("#readerView"),
  readerBack: $("#readerBack"),
  readerKicker: $("#readerKicker"),
  readerTitle: $("#readerTitle"),
  readerMeta: $("#readerMeta"),
  readerBody: $("#readerBody"),
  readerActions: $("#readerActions"),
  summariesRail: $("#summariesRail"),
  railClose: $("#railClose"),
  railBackdrop: $("#railBackdrop"),
  summarySearch: $("#summarySearch"),
  summaryList: $("#summaryList"),
  railNewConversation: $("#railNewConversation"),
  composer: $("#composer"),
  composerInput: $("#composerInput"),
  textToggle: $("#textToggle"),
  player: $("#player"),
  voicePicker: $("#voicePicker"),
  modeSelect: $("#modeSelect"),
  languageSelect: $("#languageSelect"),
  voiceSelect: $("#voiceSelect"),
  voiceAudition: $("#voiceAudition"),
  voiceAuditionLabel: $("#voiceAuditionLabel"),
  voicePreviewPlayer: $("#voicePreviewPlayer"),
};

/* ============================================================
   Tema
   ============================================================ */

const THEME_KEY = "socrates.theme";

function applyTheme(theme, { persist = false } = {}) {
  const next = theme === "light" ? "light" : "dark";
  const isLight = next === "light";

  document.documentElement.dataset.theme = next;

  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* armazenamento indisponível */
    }
  }

  const label = isLight ? "Mudar para tema escuro" : "Mudar para tema claro";
  dom.themeBtn?.setAttribute("aria-label", label);
  dom.themeBtn?.setAttribute("title", label);

  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", isLight ? "#FFFFFF" : "#0D0D0E");

  syncMini();
}

function setupTheme() {
  // o script inline do <head> já aplicou a preferência antes do primeiro paint
  applyTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");

  dom.themeBtn?.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    applyTheme(next, { persist: true });
  });
}

/* ============================================================
   Modo da conversa (entrevista ou aprendizado)
   ============================================================ */

function readStoredMode() {
  try {
    return localStorage.getItem(MODE_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function storeMode(id) {
  try {
    localStorage.setItem(MODE_STORAGE_KEY, id);
  } catch {
    /* armazenamento indisponível */
  }
}

function applyModeCopy() {
  const copy = MODE_COPY[conversationMode] ?? MODE_COPY.interview;

  if (dom.heroEyebrow) dom.heroEyebrow.textContent = copy.eyebrow;
  if (dom.heroTitle) dom.heroTitle.textContent = copy.title;
  if (dom.heroLede) dom.heroLede.textContent = copy.lede;
  document.title = copy.docTitle;
  document
    .querySelector('meta[name="description"]')
    ?.setAttribute("content", copy.meta);

  if (dom.modeSelect && modeCatalog) {
    dom.modeSelect.value = conversationMode;
  }
}

/* ============================================================
   Estados e cópia
   ============================================================ */

const STATE_COPY = {
  idle: {
    label: "Inativo",
    hint: "Clique no orbe para começar",
    aria: "Iniciar entrevista",
  },
  listening: {
    label: "Ouvindo",
    hint: "Fale naturalmente — estou ouvindo. Clique para encerrar.",
    aria: "Ouvindo. Clique para encerrar a entrevista.",
  },
  thinking: {
    label: "Pensando",
    hint: "Formulando a próxima pergunta… Clique para interromper.",
    aria: "Pensando. Clique para interromper.",
  },
  speaking: {
    label: "Falando",
    hint: "Clique no orbe para interromper.",
    aria: "Falando. Clique para interromper.",
  },
  error: {
    label: "Erro",
    hint: "Algo saiu do ar. Clique para tentar de novo.",
    aria: "Erro. Clique para tentar de novo.",
  },
};

/* ============================================================
   Estado da sessão
   ============================================================ */

let mode = "demo"; // "demo" | "live"
let state = "idle";
let sessionActive = false;
let sessionToken = 0;
let messages = [];
let lastUserText = "";
let currentAssistant = null;
let interimEl = null;
let streamDone = true;
let listeningTimer = 0;
let recognition = null;
let recognitionBlocked = false;
let mockProbeIndex = 0;

let chatAbort = null;
let ttsAbort = new AbortController();

let audioQueue = [];
let queueBusy = false;
let queueGen = 0;
let pendingSpeechStreams = 0;
let speechStreamChain = Promise.resolve();

const OWNER_STORAGE_KEY = "socrates.ownerId";
const SUMMARY_POLL_MS = 1200;
const SUMMARY_POLL_MAX_MS = 180_000;

let apiOwnerId = readOrCreateOwnerId();
let apiSessionId = null;
let apiSessionPromise = null;
let summaryPollTimer = 0;
let summaryPollToken = 0;
let summaryView = "closed";
let summarySessionId = null;
let activeSummary = null;
let summaryPreviousFocus = null;
let railOpen = false;
let readerOpen = false;
let railSummaries = [];
let railFilter = "";
let selectedSessionId = null;

let mini = null;
let pipWindow = null;
let miniLevel = 0;
let miniCaption = "Clique no orbe para começar.";
let miniDetail = "";

const VOICE_STORAGE_KEY = "socrates.voice";
const LANGUAGE_STORAGE_KEY = "socrates.language";
const MODE_STORAGE_KEY = "socrates.mode";
const MODE_COPY = {
  interview: {
    eyebrow: "Entrevista técnica · método socrático",
    title: "socrates --interview",
    lede: "Prática de argumentação técnica por voz de baixa latência.",
    docTitle: "socrates --interview · Socrates.io",
    meta: "Prática de argumentação técnica por voz de baixa latência.",
  },
  learning: {
    eyebrow: "Aprendizado guiado · conversa didática",
    title: "socrates --learn",
    lede: "Aprenda um tema por voz, com exemplos, conversa e revisão.",
    docTitle: "socrates --learn · Socrates.io",
    meta: "Aprenda um tema por voz, com exemplos, conversa e revisão.",
  },
};
// Padrão: chunks do TTS são decodificados e agendados no Web Audio com
// crossfade, sem trocar de elemento de áudio a cada 2 s. ?whole=1 usa a
// sentença inteira (mais lento) e ?stream=1 reativa a fila antiga de chunks.
const AUDIO_MODE = (() => {
  const params = new URLSearchParams(window.location.search);
  if (params.get("stream") === "1") return "chunks";
  if (params.get("whole") === "1") return "whole";
  return "smooth";
})();
const SENTENCE_PAUSE_MS = 220;
const FALLBACK_VOICE_CATALOG = {
  default: "Serena",
  defaultLanguage: "portuguese",
  defaultMode: "interview",
  modes: [
    { id: "interview", label: "Entrevista" },
    { id: "learning", label: "Aprendizado" },
  ],
  voices: [
    { id: "Serena", label: "Serena" },
    { id: "Vivian", label: "Vivian" },
    { id: "Ono_Anna", label: "Ono Anna" },
    { id: "Sohee", label: "Sohee" },
    { id: "Ryan", label: "Ryan" },
    { id: "Aiden", label: "Aiden" },
    { id: "Dylan", label: "Dylan" },
    { id: "Eric", label: "Eric" },
    { id: "Uncle_Fu", label: "Uncle Fu" },
  ],
  languages: [
    { id: "portuguese", label: "Português", locale: "pt-BR", sample: "Olá. Esta é a minha voz." },
    { id: "english", label: "English", locale: "en-US", sample: "Hello. This is my voice." },
    { id: "spanish", label: "Español", locale: "es-ES", sample: "Hola. Esta es mi voz." },
    { id: "french", label: "Français", locale: "fr-FR", sample: "Bonjour. C'est ma voix." },
    { id: "italian", label: "Italiano", locale: "it-IT", sample: "Ciao. Questa è la mia voce." },
    { id: "german", label: "Deutsch", locale: "de-DE", sample: "Hallo. Das ist meine Stimme." },
    { id: "japanese", label: "日本語", locale: "ja-JP", sample: "こんにちは。これが私の声です。" },
    { id: "korean", label: "한국어", locale: "ko-KR", sample: "안녕하세요. 제 목소리입니다." },
    { id: "chinese", label: "中文", locale: "zh-CN", sample: "你好。这是我的声音。" },
    { id: "russian", label: "Русский", locale: "ru-RU", sample: "Здравствуйте. Это мой голос." },
  ],
};

let voiceCatalog = null;
let languageCatalog = null;
let modeCatalog = null;
let selectedVoice = null;
let selectedLanguage = null;
let conversationMode = "interview";
let voicePreviewState = "idle"; // idle | loading | playing
let voicePreviewController = null;
let voicePreviewVoice = null;
let voicePreviewResumeMic = false;
let voicePreviewHint = null;
const voicePreviewCache = new Map();

/* ============================================================
   Voz
   ============================================================ */

const player = createVoicePlayer({
  audioEl: dom.player,
  onLevel(level) {
    miniLevel = level;
    dom.orb.style.setProperty("--level", level.toFixed(3));
    mini?.refs.orb.style.setProperty("--level", level.toFixed(3));
  },
  getMode: () => mode,
});

/* ============================================================
   Voz: catálogo, seleção e prévia
   ============================================================ */

let voicePreviewEpoch = 0;

function readStoredVoice() {
  try {
    return localStorage.getItem(VOICE_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function storeVoice(id) {
  try {
    localStorage.setItem(VOICE_STORAGE_KEY, id);
  } catch {
    /* armazenamento indisponível */
  }
}

function readStoredLanguage() {
  try {
    return localStorage.getItem(LANGUAGE_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function storeLanguage(id) {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, id);
  } catch {
    /* armazenamento indisponível */
  }
}

function updateVoiceControls() {
  if (!dom.voiceSelect || !dom.voiceAudition) return;

  const loaded = Boolean(
    voiceCatalog &&
      selectedVoice &&
      selectedLanguage &&
      modeCatalog &&
      conversationMode,
  );
  const locked = state === "thinking" || state === "speaking";
  const loading = voicePreviewState === "loading";
  const playing = voicePreviewState === "playing";

  if (dom.modeSelect) {
    dom.modeSelect.disabled = !loaded || sessionActive;
    dom.modeSelect.title = sessionActive
      ? "Encerre a sessão para trocar de modo"
      : "Escolher modo da conversa";
  }
  if (dom.languageSelect) dom.languageSelect.disabled = !loaded || locked;
  dom.voiceSelect.disabled = !loaded || locked;
  dom.voiceAudition.disabled = !loaded || locked || loading;

  dom.voiceAudition.classList.toggle("is-loading", loading);
  dom.voiceAudition.classList.toggle("is-playing", playing);

  const label = loading ? "gerando" : playing ? "parar" : "ouvir";
  if (dom.voiceAuditionLabel) dom.voiceAuditionLabel.textContent = label;

  let title = "Ouvir a voz selecionada";
  if (!loaded) title = "Catálogo de vozes indisponível";
  else if (locked) title = "Aguarde a fala atual terminar para trocar a voz";
  else if (loading) title = "Gerando prévia da voz";
  else if (playing) title = "Parar prévia da voz";

  dom.voiceAudition.title = title;
  dom.voiceAudition.setAttribute("aria-label", title);
  dom.voiceAudition.setAttribute("aria-pressed", String(playing));

  const lockedTitle = "Aguarde a fala atual terminar";
  if (dom.languageSelect) {
    dom.languageSelect.title = locked
      ? `${lockedTitle} para trocar o idioma`
      : "Escolher idioma da conversa";
  }
  dom.voiceSelect.title = locked
    ? `${lockedTitle} para trocar a voz`
    : "Escolher voz da IA";
}

async function setupVoicePicker() {
  if (
    !dom.voicePicker ||
    !dom.modeSelect ||
    !dom.languageSelect ||
    !dom.voiceSelect ||
    !dom.voiceAudition
  ) {
    return;
  }

  let catalog = null;
  try {
    const response = await fetch("/api/voices", { cache: "no-store" });
    if (!response.ok) throw new Error(`/api/voices respondeu ${response.status}`);
    const data = await response.json();
    if (!data || !Array.isArray(data.voices) || data.voices.length === 0) {
      throw new Error("catálogo de vozes vazio");
    }
    catalog = data;
  } catch (error) {
    console.warn(
      "[socrates] catálogo de vozes/idiomas indisponível; usando lista local",
      error,
    );
    catalog = FALLBACK_VOICE_CATALOG;
  }

  const voices = catalog.voices
    .filter((voice) => voice && typeof voice.id === "string" && voice.id.trim())
    .map((voice) => ({
      id: voice.id.trim(),
      label:
        typeof voice.label === "string" && voice.label.trim()
          ? voice.label.trim()
          : voice.id.trim(),
    }));

  const languageSource =
    Array.isArray(catalog.languages) && catalog.languages.length > 0
      ? catalog.languages
      : FALLBACK_VOICE_CATALOG.languages;

  const languages = languageSource
    .filter(
      (language) =>
        language &&
        typeof language.id === "string" &&
        language.id.trim() &&
        typeof language.locale === "string" &&
        language.locale.trim(),
    )
    .map((language) => ({
      id: language.id.trim(),
      label:
        typeof language.label === "string" && language.label.trim()
          ? language.label.trim()
          : language.id.trim(),
      locale: language.locale.trim(),
      sample:
        typeof language.sample === "string" && language.sample.trim()
          ? language.sample.trim()
          : FALLBACK_VOICE_CATALOG.languages[0].sample,
    }));

  const modeSource =
    Array.isArray(catalog.modes) && catalog.modes.length > 0
      ? catalog.modes
      : FALLBACK_VOICE_CATALOG.modes;

  const modes = modeSource
    .filter(
      (mode) =>
        mode && typeof mode.id === "string" && mode.id.trim(),
    )
    .map((mode) => ({
      id: mode.id.trim(),
      label:
        typeof mode.label === "string" && mode.label.trim()
          ? mode.label.trim()
          : mode.id.trim(),
    }));

  if (!voices.length || !languages.length || !modes.length) return;

  const requestedDefault =
    typeof catalog.default === "string" ? catalog.default.trim() : "";
  const defaultVoice =
    voices.find(
      (voice) => voice.id.toLowerCase() === requestedDefault.toLowerCase(),
    ) ?? voices[0];

  const requestedLanguage =
    typeof catalog.defaultLanguage === "string"
      ? catalog.defaultLanguage.trim()
      : "";
  const defaultLanguage =
    languages.find(
      (language) =>
        language.id.toLowerCase() === requestedLanguage.toLowerCase(),
    ) ?? languages[0];

  const storedVoiceId = readStoredVoice();
  const storedVoice = storedVoiceId
    ? voices.find(
        (voice) => voice.id.toLowerCase() === storedVoiceId.toLowerCase(),
      )
    : null;

  const storedLanguageId = readStoredLanguage();
  const storedLanguage = storedLanguageId
    ? languages.find(
        (language) =>
          language.id.toLowerCase() === storedLanguageId.toLowerCase(),
      )
    : null;

  const requestedMode =
    typeof catalog.defaultMode === "string"
      ? catalog.defaultMode.trim()
      : "";
  const defaultMode =
    modes.find(
      (mode) => mode.id.toLowerCase() === requestedMode.toLowerCase(),
    ) ?? modes[0];

  const storedModeId = readStoredMode();
  const storedMode = storedModeId
    ? modes.find((mode) => mode.id.toLowerCase() === storedModeId.toLowerCase())
    : null;

  voiceCatalog = { default: defaultVoice.id, voices };
  languageCatalog = { default: defaultLanguage.id, languages };
  modeCatalog = { default: defaultMode.id, modes };
  selectedVoice = (storedVoice ?? defaultVoice).id;
  selectedLanguage = storedLanguage ?? defaultLanguage;
  conversationMode = (storedMode ?? defaultMode).id;

  dom.voiceSelect.replaceChildren(
    ...voices.map((voice) => {
      const option = document.createElement("option");
      option.value = voice.id;
      option.textContent = voice.label;
      return option;
    }),
  );
  dom.voiceSelect.value = selectedVoice;

  dom.languageSelect.replaceChildren(
    ...languages.map((language) => {
      const option = document.createElement("option");
      option.value = language.id;
      option.textContent = language.label;
      return option;
    }),
  );
  dom.languageSelect.value = selectedLanguage.id;

  dom.modeSelect.replaceChildren(
    ...modes.map((mode) => {
      const option = document.createElement("option");
      option.value = mode.id;
      option.textContent = mode.label;
      return option;
    }),
  );
  dom.modeSelect.value = conversationMode;

  applyModeCopy();
  syncRecognitionLanguage();

  dom.voicePicker.hidden = false;
  updateVoiceControls();
}

function onVoiceChange() {
  if (!voiceCatalog || !dom.voiceSelect) return;

  const next = voiceCatalog.voices.find(
    (voice) => voice.id === dom.voiceSelect.value,
  );
  if (!next || next.id === selectedVoice) return;

  stopVoicePreview();
  selectedVoice = next.id;
  storeVoice(next.id);
  updateVoiceControls();
}

function syncRecognitionLanguage() {
  if (!recognition || !selectedLanguage) return;

  recognition.setLang(selectedLanguage.locale);
  if (recognition.active) recognition.stop();
}

function onLanguageChange() {
  if (!languageCatalog || !dom.languageSelect) return;

  const next = languageCatalog.languages.find(
    (language) => language.id === dom.languageSelect.value,
  );
  if (!next || next.id === selectedLanguage?.id) return;

  stopVoicePreview();
  selectedLanguage = next;
  storeLanguage(next.id);
  syncRecognitionLanguage();
  updateVoiceControls();
}

function onModeChange() {
  if (!modeCatalog || !dom.modeSelect) return;

  if (sessionActive) {
    dom.modeSelect.value = conversationMode;
    return;
  }

  const next = modeCatalog.modes.find(
    (mode) => mode.id === dom.modeSelect.value,
  );
  if (!next || next.id === conversationMode) return;

  conversationMode = next.id;
  storeMode(next.id);

  if (
    state !== "idle" ||
    messages.length > 0 ||
    currentAssistant
  ) {
    resetConversation();
  }

  applyModeCopy();
  updateVoiceControls();
}

function prepareMicForPreview() {
  if (!(sessionActive && state === "listening")) return false;

  const canResume = Boolean(
    recognition && !recognitionBlocked && dom.composer.hidden,
  );

  window.clearTimeout(listeningTimer);
  listeningTimer = 0;

  if (recognition?.active) recognition.stop();

  return canResume;
}

function showVoicePreviewHint(text) {
  if (!sessionActive || state !== "listening") return;

  if (!voicePreviewHint) {
    voicePreviewHint = {
      hint: dom.hint.textContent,
      caption: miniCaption,
    };
  }

  dom.hint.textContent = text;
  miniCaption = text;
  syncMini();
}

function clearVoicePreviewHint() {
  if (!voicePreviewHint) return;

  const previous = voicePreviewHint;
  voicePreviewHint = null;

  if (!sessionActive || state !== "listening") return;

  dom.hint.textContent = previous.hint || STATE_COPY.listening.hint;
  miniCaption = previous.caption || "Sua vez. Fale ou digite.";
  syncMini();
}

function restoreMicAfterPreview() {
  const shouldResume = voicePreviewResumeMic;
  voicePreviewResumeMic = false;

  if (
    !shouldResume ||
    !sessionActive ||
    state !== "listening" ||
    !dom.composer.hidden
  ) {
    return;
  }

  window.clearTimeout(listeningTimer);
  listeningTimer = window.setTimeout(() => {
    if (!sessionActive || state !== "listening" || !dom.composer.hidden) {
      return;
    }
    if (voicePreviewState !== "idle") return;
    beginRecognition();
  }, 250);
}

function finishVoicePreview() {
  if (voicePreviewState === "idle") return;

  voicePreviewEpoch += 1;
  voicePreviewState = "idle";
  voicePreviewVoice = null;
  voicePreviewController = null;

  if (dom.voicePreviewPlayer) {
    try {
      dom.voicePreviewPlayer.pause();
      dom.voicePreviewPlayer.currentTime = 0;
    } catch {
      /* noop */
    }
  }

  updateVoiceControls();
  clearVoicePreviewHint();
  restoreMicAfterPreview();
}

function stopVoicePreview() {
  if (voicePreviewController) {
    voicePreviewController.abort();
    voicePreviewController = null;
  }

  finishVoicePreview();
}

function playVoicePreview(voice, url) {
  if (!dom.voicePreviewPlayer) {
    finishVoicePreview();
    return;
  }

  voicePreviewEpoch += 1;
  const epoch = voicePreviewEpoch;
  voicePreviewState = "playing";
  voicePreviewVoice = voice;
  updateVoiceControls();
  showVoicePreviewHint("Ouvindo prévia da voz…");

  const audio = dom.voicePreviewPlayer;

  try {
    audio.pause();
    audio.currentTime = 0;
    audio.src = url;

    const playback = audio.play();

    if (playback?.then) {
      playback
        .then(() => {
          if (epoch !== voicePreviewEpoch) {
            try {
              audio.pause();
            } catch {
              /* noop */
            }
          }
        })
        .catch((error) => {
          if (epoch !== voicePreviewEpoch || error?.name === "AbortError") {
            return;
          }
          console.warn("[socrates] prévia de voz bloqueada", error);
          finishVoicePreview();
        });
    }
  } catch (error) {
    console.warn("[socrates] falha ao iniciar a prévia da voz", error);
    finishVoicePreview();
  }
}

async function auditionVoice() {
  if (!voiceCatalog || !selectedVoice || !selectedLanguage) return;
  if (state === "thinking" || state === "speaking") return;

  if (voicePreviewState !== "idle") {
    stopVoicePreview();
    return;
  }

  const voice = selectedVoice;
  const language = selectedLanguage;
  const cacheKey = `${voice}|${language.id}`;
  const cached = voicePreviewCache.get(cacheKey);

  voicePreviewState = "loading";
  voicePreviewVoice = voice;
  voicePreviewResumeMic = prepareMicForPreview();
  updateVoiceControls();
  showVoicePreviewHint("Gerando prévia da voz…");

  if (cached) {
    playVoicePreview(voice, cached);
    return;
  }

  const controller = new AbortController();
  voicePreviewController = controller;

  try {
    const prepared = await player.prepare(language.sample, {
      signal: controller.signal,
      speaker: voice,
      language: language.id,
    });

    if (controller.signal.aborted || voicePreviewController !== controller) {
      releasePrepared(prepared);
      return;
    }

    if (prepared?.kind !== "blob" || !prepared.url) {
      throw new Error("prévia de voz indisponível");
    }

    voicePreviewController = null;
    voicePreviewCache.set(cacheKey, prepared.url);
    playVoicePreview(voice, prepared.url);
  } catch (error) {
    if (controller.signal.aborted || voicePreviewController !== controller) {
      return;
    }

    voicePreviewController = null;
    console.warn("[socrates] não foi possível gerar a prévia da voz", error);

    voicePreviewState = "idle";
    voicePreviewVoice = null;
    updateVoiceControls();
    clearVoicePreviewHint();
    restoreMicAfterPreview();
  }
}

function onVoicePreviewAudioError() {
  if (voicePreviewState !== "playing") return;
  console.warn("[socrates] falha ao reproduzir a prévia da voz");
  finishVoicePreview();
}

function releaseVoicePreviewCache() {
  for (const url of voicePreviewCache.values()) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* noop */
    }
  }
  voicePreviewCache.clear();
}

/* ============================================================
   Janela flutuante (mini player)
   ============================================================ */

const MINI_MARKUP = `
  <div class="mini-card">
    <div class="mini-top">
      <div class="mini-live">
        <span class="mini-dot" aria-hidden="true"></span>
        <span class="mini-status" id="miniStatus" aria-live="polite">Inativo</span>
      </div>
      <div class="mini-actions">
        <button class="mini-icon" id="miniRestore" type="button" aria-label="Expandir para a janela principal" title="Expandir">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M8 3H5a2 2 0 0 0-2 2v3" />
            <path d="M16 3h3a2 2 0 0 1 2 2v3" />
            <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
            <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
          </svg>
        </button>
        <button class="mini-icon" id="miniClose" type="button" aria-label="Fechar janela flutuante" title="Fechar">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      </div>
    </div>

    <div class="mini-context">
      <p class="mini-caption" id="miniCaption">Clique no orbe para começar.</p>
      <p class="mini-detail" id="miniDetail" hidden></p>
    </div>

    <div class="mini-bottom">
      <button class="orb mini-orb" id="miniOrb" type="button" aria-label="Iniciar entrevista">
        <span class="orb-halo" aria-hidden="true"></span>
        <span class="orb-ring orb-ring--inner" aria-hidden="true"></span>
        <span class="orb-ring orb-ring--outer" aria-hidden="true"></span>
        <span class="orb-core" aria-hidden="true">
          <span class="orb-tint"></span>
          <span class="orb-gloss"></span>
          <span class="orb-sheen"></span>
        </span>
      </button>

      <div class="mini-copy">
        <span class="mini-hint" id="miniHint">Clique para iniciar</span>
        <form class="mini-form" id="miniForm" autocomplete="off" hidden>
          <input id="miniInput" type="text" placeholder="Digite sua resposta…" aria-label="Digite sua resposta" />
          <button class="mini-send" type="submit" aria-label="Enviar resposta">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 19V5" />
              <path d="m5 12 7-7 7 7" />
            </svg>
          </button>
        </form>
      </div>

      <button class="mini-key" id="miniKey" type="button" aria-label="Digitar resposta" title="Digitar" aria-expanded="false">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="2" y="6" width="20" height="12" rx="2" />
          <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6" />
        </svg>
      </button>
    </div>
  </div>
`;

function currentTheme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function miniHint() {
  if (state === "listening") {
    return sessionActive ? "Clique para encerrar" : "Clique para falar";
  }
  if (state === "thinking" || state === "speaking") return "Clique para interromper";
  if (state === "error") return "Clique para tentar de novo";
  return messages.length ? "Clique para retomar" : "Clique para iniciar";
}

function updateMiniButton() {
  if (!dom.miniBtn) return;

  const active = Boolean(mini);
  dom.miniBtn.classList.toggle("is-active", active);

  const label = active ? "Fechar janela flutuante" : "Abrir janela flutuante";
  dom.miniBtn.setAttribute("aria-label", label);
  dom.miniBtn.setAttribute("title", label);
}

function syncMini() {
  if (!mini) return;

  const { doc, refs, isPip } = mini;

  if (isPip) {
    doc.documentElement.dataset.theme = currentTheme();
    doc.body.dataset.state = state;
  }

  if (state !== "listening") mini.formOpen = false;

  const canType = state === "listening" && sessionActive;

  refs.status.textContent = dom.stateLabel.textContent;
  refs.caption.textContent = miniCaption;
  refs.detail.textContent = miniDetail;
  refs.detail.hidden = !miniDetail;
  refs.hint.textContent = miniHint();
  refs.orb.setAttribute("aria-label", dom.orb.getAttribute("aria-label") || "Orbe");
  refs.input.disabled = !canType;
  refs.key.disabled = !canType;
  refs.form.hidden = !mini.formOpen;
  refs.hint.hidden = mini.formOpen;
  refs.key.setAttribute("aria-expanded", String(mini.formOpen));
  refs.orb.style.setProperty("--level", miniLevel.toFixed(3));

  updateMiniButton();
}

function mountMini(doc, root, { isPip = false } = {}) {
  root.innerHTML = MINI_MARKUP;

  const refs = {
    status: root.querySelector("#miniStatus"),
    caption: root.querySelector("#miniCaption"),
    detail: root.querySelector("#miniDetail"),
    hint: root.querySelector("#miniHint"),
    orb: root.querySelector("#miniOrb"),
    form: root.querySelector("#miniForm"),
    input: root.querySelector("#miniInput"),
    key: root.querySelector("#miniKey"),
    restore: root.querySelector("#miniRestore"),
    close: root.querySelector("#miniClose"),
  };

  mini = { doc, root, refs, isPip, formOpen: false };

  refs.orb.addEventListener("click", onOrbClick);

  refs.restore.addEventListener("click", () => {
    closeMini();
    window.focus();
  });

  refs.close.addEventListener("click", closeMini);

  refs.key.addEventListener("click", () => {
    if (state !== "listening") return;
    mini.formOpen = !mini.formOpen;
    syncMini();
    if (mini.formOpen) refs.input.focus();
  });

  refs.form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (state !== "listening" || !sessionActive) return;

    const value = refs.input.value;
    refs.input.value = "";
    mini.formOpen = false;
    handleUserText(value);
  });

  syncMini();
  return mini;
}

function closeMini() {
  const current = mini;
  mini = null;
  dom.body.classList.remove("mini-fallback-open");

  if (current?.isPip) {
    const pip = pipWindow;
    pipWindow = null;
    try {
      pip?.close();
    } catch {
      /* noop */
    }
  } else if (current) {
    current.root.hidden = true;
    current.root.innerHTML = "";
  }

  updateMiniButton();
}

function openFallbackMini() {
  if (!dom.miniFallback) return;
  if (mini) closeMini();

  dom.body.classList.add("mini-fallback-open");
  dom.miniFallback.hidden = false;
  mountMini(document, dom.miniFallback, { isPip: false });
}

async function openMini() {
  if (mini) {
    closeMini();
    return;
  }

  if ("documentPictureInPicture" in window) {
    try {
      const pip = await window.documentPictureInPicture.requestWindow({
        width: 400,
        height: 240,
      });

      pipWindow = pip;
      const doc = pip.document;

      doc.title = "Socrates.io — ao vivo";
      doc.documentElement.lang = "pt-BR";
      doc.documentElement.dataset.theme = currentTheme();

      for (const file of ["style/styles.css", "style/mini.css"]) {
        const link = doc.createElement("link");
        link.rel = "stylesheet";
        link.href = new URL(file, window.location.href).href;
        doc.head.appendChild(link);
      }

      doc.body.className = "mini-body";
      doc.body.dataset.state = state;

      const root = doc.createElement("div");
      doc.body.appendChild(root);

      mountMini(doc, root, { isPip: true });

      pip.addEventListener("pagehide", () => {
        if (mini?.isPip && mini.doc === doc) mini = null;
        if (pipWindow === pip) pipWindow = null;
        updateMiniButton();
      });

      updateMiniButton();
      return;
    } catch (error) {
      console.warn("[socrates] janela flutuante indisponível", error);
    }
  }

  openFallbackMini();
}

/* ============================================================
   Conteúdo do modo demo
   ============================================================ */

const OPENING =
  "Vamos começar sem pressa. O que a inversão de dependência realmente inverte: a direção das chamadas, a posse do controle ou apenas o nome das classes?";

const PROBES = [
  "Você mencionou abstrações. Mas o que faz uma abstração ser boa: o número de métodos ou o fato de esconder uma decisão que pode mudar?",
  "Se a implementação concreta é escolhida na composição, quem garante que essa escolha não vaza para dentro do domínio? Me dê um exemplo concreto.",
  "Você chamou isso de desacoplamento. Se o banco mudasse amanhã, quantos arquivos do seu domínio precisariam mudar? Por quê?",
  "Ainda não estou convencido. Qual é o custo de inverter dependências cedo demais? Quando a abstração vira especulação?",
];

const KEYWORD_PROBES = [
  {
    re: /test|mock|stub|dubl/i,
    text: "Você falou de testes. Se a abstração vazasse detalhes do banco, o que você estaria testando de verdade: o domínio ou o framework?",
  },
  {
    re: /banco|sql|postgres|mysql|orm/i,
    text: "Então o banco é um detalhe. Prove: se ele mudasse amanhã, quantos arquivos do domínio precisariam mudar? Por quê?",
  },
  {
    re: /composi|inicializa|configur/i,
    text: "A composição decide. Mas quem impede essa decisão de vazar para dentro do domínio? Me mostre a fronteira concretamente.",
  },
  {
    re: /abstra|interface/i,
    text: "Você usou a palavra abstração. O que exatamente faz uma abstração ser boa: o número de métodos ou o fato de esconder uma decisão que pode mudar?",
  },
];

const PREVIEW_USER =
  "A inversão de dependência inverte a direção das dependências: o módulo de alto nível define a abstração, e o módulo de baixo nível a implementa. O controle fica na composição.";

const ABBREVIATIONS = new Set([
  "sr",
  "sra",
  "dr",
  "dra",
  "prof",
  "profa",
  "etc",
  "ex",
  "fig",
  "pag",
  "pág",
  "vs",
]);

/* ============================================================
   Estado visual
   ============================================================ */

function setState(next, hintOverride) {
  if (!STATE_COPY[next]) return;
  state = next;
  dom.body.dataset.state = next;
  dom.stateLabel.textContent = STATE_COPY[next].label;
  dom.hint.textContent = hintOverride ?? STATE_COPY[next].hint;
  dom.orb.setAttribute("aria-label", STATE_COPY[next].aria);
  dom.composerInput.disabled = next !== "listening";
  updateToggle();
  updateEndSessionButton();

  if (next === "thinking") miniCaption = "Formulando a próxima pergunta…";
  else if (next === "listening") miniCaption = "Sua vez. Fale ou digite.";
  else if (next === "idle") {
    miniCaption = messages.length ? "Sessão encerrada." : "Clique no orbe para começar.";
  } else if (next === "error") {
    miniCaption = hintOverride || "Algo saiu do ar.";
  }

  syncMini();
  updateVoiceControls();
}

function setConnection(value) {
  dom.connection.dataset.mode = value;
  dom.connectionLabel.textContent =
    value === "live" ? "conectado" : value === "offline" ? "sem conexão" : "modo demo";

  dom.connection.title =
    value === "live"
      ? "Orquestrador Node detectado."
      : value === "offline"
        ? "O servidor caiu. Verifique o Node."
        : "Backend não detectado — respostas simuladas neste navegador.";
}

function updateToggle() {
  const visible =
    state === "listening" &&
    dom.composer.hidden &&
    Boolean(recognition) &&
    !recognitionBlocked;
  dom.textToggle.hidden = !visible;
}

/* ============================================================
   Transcrição
   ============================================================ */

function isNearBottom() {
  const el = dom.transcript;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}

function scrollToBottom(force = false) {
  if (!force && !isNearBottom()) return;
  requestAnimationFrame(() => {
    dom.transcript.scrollTop = dom.transcript.scrollHeight;
  });
}

function addAssistantMessage() {
  const el = document.createElement("article");
  el.className = "msg msg--assistant is-streaming";

  const role = document.createElement("div");
  role.className = "msg-role";
  role.textContent = "Sócrates";

  const text = document.createElement("div");
  text.className = "msg-text";

  const typing = document.createElement("span");
  typing.className = "typing";
  typing.innerHTML = "<i></i><i></i><i></i>";
  text.appendChild(typing);

  el.append(role, text);
  dom.transcriptInner.appendChild(el);
  scrollToBottom(true);

  const node = document.createTextNode("");
  const sentences = new Map();
  const revealed = new Set();
  let started = false;
  let fullContent = "";
  let displayContent = "";
  let committed = false;

  function showContent(value) {
    if (!started) {
      typing.remove();
      text.appendChild(node);
      started = true;
    }

    displayContent = displayContent ? `${displayContent} ${value}` : value;
    node.data = displayContent;
    scrollToBottom();
  }

  function revealSentence(index, sentence) {
    const value = String(sentence ?? sentences.get(index) ?? "").trim();
    if (!value) return;

    const key = Number.isFinite(index) ? index : value;
    if (revealed.has(key)) return;

    revealed.add(key);
    showContent(value);
  }

  return {
    el,
    // O texto só entra no DOM quando o áudio da sentença fica disponível.
    appendToken(token) {
      fullContent += token;
    },
    noteSentence(index, sentence) {
      const value = String(sentence ?? "").trim();
      if (!value || sentences.has(index)) return;
      sentences.set(index, value);
    },
    revealSentence,
    finish() {
      el.classList.remove("is-streaming");
      if (started) typing.remove();
    },
    // Interrupção/erro: não revela texto sem áudio; só limpa o indicador.
    finishVisible() {
      el.classList.remove("is-streaming");
      typing.remove();
      if (!started && !displayContent.trim()) el.remove();
    },
    removeIfEmpty() {
      if (!fullContent.trim() && sentences.size === 0) el.remove();
    },
    commit() {
      if (committed) return;

      const content =
        fullContent.trim() || [...sentences.values()].join(" ").trim();
      if (!content) return;

      committed = true;
      messages.push({ role: "assistant", content });
    },
    get content() {
      return fullContent;
    },
  };
}

function addUserMessage(content, { interim = false } = {}) {
  const el = document.createElement("article");
  el.className = interim ? "msg msg--user msg--interim" : "msg msg--user";

  const role = document.createElement("div");
  role.className = "msg-role";
  role.textContent = "Você";

  const text = document.createElement("div");
  text.className = "msg-text";
  text.textContent = content;

  el.append(role, text);
  dom.transcriptInner.appendChild(el);
  scrollToBottom(true);

  return {
    el,
    textEl: text,
    remove() {
      el.remove();
    },
  };
}

function addStaticMessage(roleName, content) {
  const el = document.createElement("article");
  el.className = `msg msg--${roleName}`;

  const role = document.createElement("div");
  role.className = "msg-role";
  role.textContent = roleName === "user" ? "Você" : "Sócrates";

  const text = document.createElement("div");
  text.className = "msg-text";
  text.textContent = content;

  el.append(role, text);
  dom.transcriptInner.appendChild(el);
}

function showInterim(text) {
  miniCaption = text;

  if (!interimEl) {
    interimEl = addUserMessage(text, { interim: true });
  } else {
    interimEl.textEl.textContent = text;
    scrollToBottom();
  }

  syncMini();
}

function removeInterim() {
  if (!interimEl) return;
  interimEl.remove();
  interimEl = null;
}

/* ============================================================
   Fila de áudio
   ============================================================ */

function releasePrepared(prepared) {
  if (prepared?.kind === "blob" && prepared.url) {
    URL.revokeObjectURL(prepared.url);
  }
}

function resetAudio() {
  queueGen += 1;
  queueBusy = false;
  streamDone = true;
  pendingSpeechStreams = 0;
  speechStreamChain = Promise.resolve();

  player.stop();

  for (const item of audioQueue) {
    item.prepared?.then(releasePrepared).catch(() => {});
  }
  audioQueue = [];

  ttsAbort.abort();
  ttsAbort = new AbortController();
}

function pushAudioItem(index, text, prepared, token, reveal, sentenceIndex) {
  if (!sessionActive || token !== sessionToken) {
    Promise.resolve(prepared).then(releasePrepared).catch(() => {});
    return;
  }

  const ready = Promise.resolve(prepared);
  ready.catch(() => {});

  const item = {
    index,
    text,
    prepared: ready,
    reveal,
    sentenceIndex: Number.isFinite(sentenceIndex) ? sentenceIndex : index,
  };
  const position = audioQueue.findIndex((entry) => entry.index > index);
  if (position === -1) audioQueue.push(item);
  else audioQueue.splice(position, 0, item);

  pumpQueue(token);
}

function enqueueAudio(index, text, token, voice, language, reveal, sentenceIndex) {
  if (!sessionActive || token !== sessionToken) return;

  const prepared = player.prepare(text, {
    signal: ttsAbort.signal,
    speaker: voice,
    language,
  });
  prepared.catch(() => {});
  pushAudioItem(index, text, prepared, token, reveal, sentenceIndex);
}

function enqueueAudioStream(sentenceIndex, text, token, voice, language, reveal) {
  if (!sessionActive || token !== sessionToken) return;

  if (mode !== "live" || AUDIO_MODE === "whole") {
    const index = mode === "live" ? sentenceIndex * 1000 : sentenceIndex;
    enqueueAudio(
      index,
      text,
      token,
      voice,
      language,
      reveal,
      sentenceIndex,
    );
    return;
  }

  if (AUDIO_MODE === "smooth") {
    const index = sentenceIndex * 1000;
    const prepared = player
      .prepareStream(text, {
        signal: ttsAbort.signal,
        speaker: voice,
        language,
      })
      .catch((error) => {
        if (ttsAbort.signal.aborted) throw error;

        console.warn(
          "[socrates] áudio em streaming falhou; usando sentença inteira",
          error,
        );
        return player.prepare(text, {
          signal: ttsAbort.signal,
          speaker: voice,
          language,
        });
      });

    prepared.catch(() => {});
    pushAudioItem(index, text, prepared, token, reveal, sentenceIndex);
    return;
  }

  const gen = queueGen;
  const base = sentenceIndex * 1000;
  let chunks = 0;

  pendingSpeechStreams += 1;

  const run = async () => {
    try {
      for await (const chunk of streamSpeech(text, {
        signal: ttsAbort.signal,
        speaker: voice,
        language,
      })) {
        if (!sessionActive || gen !== queueGen || token !== sessionToken) {
          URL.revokeObjectURL(chunk.url);
          return;
        }

        chunks += 1;
        const chunkIndex = Number.isFinite(chunk.index) ? chunk.index : chunks - 1;
        pushAudioItem(
          base + chunkIndex,
          text,
          { kind: "blob", url: chunk.url },
          token,
          reveal,
          sentenceIndex,
        );
      }

      // Stream vazio (ex.: timeout antes do primeiro chunk): áudio único.
      if (chunks === 0 && sessionActive && gen === queueGen && token === sessionToken) {
        enqueueAudio(base, text, token, voice, language, reveal, sentenceIndex);
      }
    } catch (error) {
      if (
        ttsAbort.signal.aborted ||
        !sessionActive ||
        gen !== queueGen ||
        token !== sessionToken
      ) {
        return;
      }

      console.warn("[socrates] TTS em streaming falhou; usando áudio único", error);
      if (chunks === 0) {
        enqueueAudio(base, text, token, voice, language, reveal, sentenceIndex);
      }
    } finally {
      if (gen === queueGen && token === sessionToken) {
        pendingSpeechStreams = Math.max(0, pendingSpeechStreams - 1);
        maybeResumeListening(token);
      }
    }
  };

  // O modelo MLX serializa as gerações; encadear no cliente preserva a ordem
  // das sentenças e evita que a fila toque a sentença seguinte antes da hora.
  speechStreamChain = speechStreamChain.then(run, run).catch(() => {});
}

async function pumpQueue(token) {
  if (queueBusy) return;

  queueBusy = true;
  const gen = queueGen;
  let lastSentenceIndex = null;

  try {
    while (gen === queueGen && audioQueue.length > 0) {
      if (token !== sessionToken) return;

      const item = audioQueue[0];

      if (
        lastSentenceIndex !== null &&
        Number.isFinite(item.sentenceIndex) &&
        item.sentenceIndex !== lastSentenceIndex
      ) {
        await delay(SENTENCE_PAUSE_MS);
        if (gen !== queueGen || token !== sessionToken) return;
      }

      if (Number.isFinite(item.sentenceIndex)) {
        lastSentenceIndex = item.sentenceIndex;
      }

      let prepared;

      try {
        prepared = await item.prepared;
      } catch {
        if (gen !== queueGen) return;
        audioQueue.shift();
        continue;
      }

      if (gen !== queueGen || token !== sessionToken) {
        releasePrepared(prepared);
        return;
      }

      miniCaption = item.text;

      if (typeof item.reveal === "function") {
        try {
          item.reveal();
        } catch {
          /* noop */
        }
      }

      setState("speaking");

      try {
        await player.play(prepared);
      } catch (error) {
        console.warn("[socrates] falha ao reproduzir sentença", error);
      }

      releasePrepared(prepared);

      if (gen !== queueGen || token !== sessionToken) return;

      audioQueue.shift();

      if (audioQueue.length === 0 && !streamDone && pendingSpeechStreams === 0) {
        setState("thinking");
      }
    }
  } finally {
    if (gen === queueGen) {
      queueBusy = false;
      if (audioQueue.length > 0) {
        pumpQueue(token);
      } else {
        maybeResumeListening(token);
      }
    }
  }
}

/* ============================================================
   Transporte: DeepSeek via Node (SSE)
   ============================================================ */

async function streamLive({ kickoff, language, mode }, handlers, signal) {
  const body = { messages, kickoff };
  if (language) body.language = language;
  if (mode) body.mode = mode;

  const response = await fetch("/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    throw new Error(`/api/chat respondeu ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    throw new Error("resposta do chat não é um stream SSE");
  }

  let finished = false;

  await readSSE(response, {
    onEvent({ event, data }) {
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        return;
      }

      const kind = payload.type || event;

      if (kind === "token") {
        const text = payload.text ?? payload.token ?? "";
        if (text) handlers.onToken(text);
        return;
      }

      if (kind === "sentence" || kind === "sentenceReady") {
        const text = payload.text ?? payload.sentence ?? "";
        if (!text) return;
        handlers.onSentence({
          index: Number.isFinite(payload.index) ? payload.index : payload.id,
          text,
        });
        return;
      }

      if (kind === "done") {
        finished = true;
        handlers.onDone();
        return;
      }

      if (kind === "error") {
        throw new Error(payload.message || "erro no stream do chat");
      }
    },
  });

  if (!finished) handlers.onDone();
}

/* ============================================================
   Transporte: simulação local
   ============================================================ */

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

function findSentenceCut(buffer, isFirst) {
  const minLength = isFirst ? 18 : 55;
  const pattern = /[.!?…]+(?=\s|$)/g;
  let match;

  while ((match = pattern.exec(buffer)) !== null) {
    const end = match.index + match[0].length;
    const candidate = buffer.slice(0, end).trim();
    if (candidate.length < minLength) continue;

    const beforePunctuation = candidate.slice(0, -match[0].length);
    const lastWord =
      beforePunctuation
        .split(/\s+/)
        .pop()
        ?.toLowerCase()
        .replace(/[^\p{L}.]/gu, "") ?? "";

    if (ABBREVIATIONS.has(lastWord.replace(/\.$/, ""))) continue;
    return end;
  }

  return 0;
}

function pickMockReply() {
  const match = KEYWORD_PROBES.find((probe) => probe.re.test(lastUserText));
  if (match) return match.text;

  const reply = PROBES[mockProbeIndex % PROBES.length];
  mockProbeIndex += 1;
  return reply;
}

async function streamMock({ kickoff }, handlers, signal) {
  await delay(650 + Math.random() * 450, signal);

  const full = kickoff ? OPENING : pickMockReply();
  const tokens = full.match(/\S+\s*/g) ?? [full];

  let buffer = "";
  let index = 0;
  let first = true;

  for (const token of tokens) {
    await delay(18 + Math.random() * 30, signal);

    handlers.onToken(token);
    buffer += token;

    let cut;
    while ((cut = findSentenceCut(buffer, first)) > 0) {
      const sentence = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut).trimStart();
      if (sentence) {
        handlers.onSentence({ index: index, text: sentence });
        index += 1;
        first = false;
      }
    }
  }

  if (buffer.trim()) {
    handlers.onSentence({ index: index, text: buffer.trim() });
  }

  handlers.onDone();
}

/* ============================================================
   Turno
   ============================================================ */

function abortChat() {
  if (!chatAbort) return;
  chatAbort.abort();
  chatAbort = null;
}

function runTurn({ kickoff = false } = {}) {
  if (!sessionActive) return;

  const token = sessionToken;
  const turnVoice = selectedVoice;
  const turnLanguage = selectedLanguage?.id ?? null;
  const turnMode = conversationMode;

  settleCurrentAssistant();
  stopVoicePreview();
  resetAudio();
  streamDone = false;
  abortChat();

  chatAbort = new AbortController();
  const signal = chatAbort.signal;

  setState("thinking");

  const assistant = addAssistantMessage();
  currentAssistant = assistant;

  let sentenceIndex = 0;
  let finished = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    streamDone = true;

    assistant.finish();
    assistant.commit();
    assistant.removeIfEmpty();

    // Mantém a referência até o áudio terminar para limpar o indicador caso
    // o usuário interrompa antes de qualquer áudio.
    if (token === sessionToken && sessionActive) {
      maybeResumeListening(token);
    }
  };

  const handlers = {
    onToken(text) {
      if (token !== sessionToken || !text) return;
      assistant.appendToken(text);
    },
    onSentence(sentence) {
      if (token !== sessionToken) return;
      const text = String(sentence?.text ?? "").trim();
      if (!text) return;

      const index = Number.isFinite(sentence?.index) ? sentence.index : sentenceIndex;
      sentenceIndex = Math.max(sentenceIndex, index + 1);
      assistant.noteSentence(index, text);

      enqueueAudioStream(
        index,
        text,
        token,
        turnVoice,
        turnLanguage,
        () => assistant.revealSentence(index, text),
      );
    },
    onDone: finish,
  };

  const runner = mode === "live" ? streamLive : streamMock;

  runner({ kickoff, language: turnLanguage, mode: turnMode }, handlers, signal)
    .then(finish)
    .catch((error) => {
      if (error?.name === "AbortError" || token !== sessionToken) return;

      console.error("[socrates] turno falhou", error);

      assistant.finishVisible();
      assistant.commit();

      if (currentAssistant === assistant) currentAssistant = null;
      if (token !== sessionToken) return;

      sessionActive = false;
      sessionToken += 1;
      resetAudio();

      setState(
        "error",
        mode === "live"
          ? "Não consegui falar com o servidor. Clique para tentar de novo."
          : "Algo saiu do ar. Clique para tentar de novo.",
      );

      if (mode === "live") setConnection("offline");

      if (!messages.length) {
        dom.app.classList.remove("has-conversation");
        dom.transcript.hidden = true;
        dom.hero.hidden = false;
        dom.resetBtn.hidden = true;
      }

      updateToggle();
    });
}

/* ============================================================
   Sessão e reconhecimento
   ============================================================ */

function maybeResumeListening(token) {
  if (!sessionActive || token !== sessionToken) return;
  if (!streamDone || pendingSpeechStreams > 0 || audioQueue.length > 0) return;
  resumeListening(token);
}

function resumeListening(token) {
  if (!sessionActive || token !== sessionToken) return;

  window.clearTimeout(listeningTimer);
  setState("listening");

  listeningTimer = window.setTimeout(() => {
    if (!sessionActive || token !== sessionToken || state !== "listening") return;
    if (!dom.composer.hidden) return;
    beginRecognition();
  }, 400);
}

function beginRecognition() {
  if (!recognition || recognitionBlocked) {
    openComposer(
      recognitionBlocked ? "Microfone bloqueado. Digite sua resposta." : undefined,
    );
    return;
  }

  recognition.start();
  updateToggle();
}

function openComposer(hintText) {
  if (!dom.composer.hidden) {
    if (hintText) {
      dom.hint.textContent = hintText;
      miniCaption = hintText;
      syncMini();
    }
    return;
  }

  dom.composer.hidden = false;
  dom.textToggle.hidden = true;

  if (state === "listening") {
    dom.stateLabel.textContent = "Sua vez";
    dom.orb.setAttribute("aria-label", "Sua vez. Clique para encerrar a entrevista.");
    miniCaption = hintText || "Sua vez. Fale ou digite.";
  }

  if (hintText) dom.hint.textContent = hintText;
  else if (state === "listening") dom.hint.textContent = "Digite sua resposta abaixo.";

  dom.composerInput.focus({ preventScroll: true });
  scrollToBottom(true);
  updateToggle();
  syncMini();
}

function handleUserText(raw) {
  if (!sessionActive || state !== "listening") return;

  const text = String(raw ?? "").trim();
  if (!text) return;

  removeInterim();
  recognition?.stop();

  dom.composer.hidden = true;
  dom.composerInput.value = "";
  dom.textToggle.hidden = true;

  lastUserText = text;
  miniDetail = `Você: ${text}`;
  addUserMessage(text);
  messages.push({ role: "user", content: text });
  scrollToBottom(true);

  setState("thinking");
  runTurn();
}

function startSession() {
  if (sessionActive) return;

  stopVoicePreview();
  player.unlock();

  sessionActive = true;
  sessionToken += 1;
  recognitionBlocked = false;
  resetAudio();
  abortChat();
  startApiSession();

  dom.app.classList.add("has-conversation");
  dom.transcript.hidden = false;
  dom.hero.hidden = true;
  dom.resetBtn.hidden = false;

  if (messages.length === 0) miniDetail = "";

  const last = messages[messages.length - 1];

  if (messages.length === 0) {
    setState("thinking");
    runTurn({ kickoff: true });
    return;
  }

  if (last?.role === "user") {
    setState("thinking");
    runTurn();
    return;
  }

  resumeListening(sessionToken);
}

function endSession() {
  if (!sessionActive && state === "idle") return;

  stopVoicePreview();

  sessionActive = false;
  sessionToken += 1;
  abortChat();

  window.clearTimeout(listeningTimer);
  listeningTimer = 0;

  recognition?.abort();
  removeInterim();
  resetAudio();

  settleCurrentAssistant();

  dom.composer.hidden = true;
  dom.composerInput.value = "";

  if (messages.length > 0) {
    setState("idle", "Sessão encerrada. Clique no orbe para retomar.");
    dom.resetBtn.hidden = false;
  } else {
    setState("idle");
    dom.app.classList.remove("has-conversation");
    dom.transcript.hidden = true;
    dom.hero.hidden = false;
    dom.resetBtn.hidden = true;
  }

  updateToggle();
}

function settleCurrentAssistant() {
  if (!currentAssistant) return;

  currentAssistant.finishVisible();
  currentAssistant.commit();
  currentAssistant = null;
}

function interrupt() {
  if (!sessionActive) return;

  abortChat();
  resetAudio();

  settleCurrentAssistant();

  streamDone = true;
  removeInterim();
  resumeListening(sessionToken);
}

function onOrbClick() {
  if (state === "thinking" || state === "speaking") {
    interrupt();
    return;
  }

  if (sessionActive) {
    requestEndConversation();
    return;
  }

  startSession();
}

function resetConversation() {
  endSession();

  apiSessionId = null;
  apiSessionPromise = null;
  summarySessionId = null;
  activeSummary = null;
  selectedSessionId = null;

  messages = [];
  lastUserText = "";
  currentAssistant = null;
  miniDetail = "";
  mockProbeIndex = 0;

  removeInterim();
  dom.transcriptInner.innerHTML = "";
  dom.transcript.hidden = true;
  dom.app.classList.remove("has-conversation");
  dom.hero.hidden = false;
  dom.resetBtn.hidden = true;
  dom.composer.hidden = true;
  dom.composerInput.value = "";

  setState("idle");
  updateToggle();
}

/* ============================================================
   Sessões de aprendizagem, rail de resumos e leitor
   ============================================================ */

const SUMMARY_ERRORS = {
  storage_unavailable: "O banco de resumos está indisponível. Verifique o MongoDB.",
  deepseek_not_configured: "O backend está sem a chave da DeepSeek.",
  invalid_summary: "O modelo retornou um resumo inválido. Tente novamente.",
  invalid_json: "O modelo retornou um JSON incompleto. Tente novamente.",
  summary_not_found: "Resumo não encontrado para esta conversa.",
  generation_timeout: "A geração do resumo demorou demais.",
  deepseek_401: "A chave da DeepSeek é inválida.",
  deepseek_402: "O saldo da DeepSeek está esgotado.",
  deepseek_429: "Muitas requisições à DeepSeek. Tente em instantes.",
  summary_failed: "A geração do resumo falhou.",
  empty_session: "A conversa é curta demais para gerar um resumo.",
};

function readOrCreateOwnerId() {
  const fallback = `local-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;

  try {
    const stored = localStorage.getItem(OWNER_STORAGE_KEY);
    if (typeof stored === "string" && /^[a-zA-Z0-9_-]{8,64}$/.test(stored)) {
      return stored;
    }
  } catch {
    /* armazenamento indisponível */
  }

  const generated =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : fallback;

  try {
    localStorage.setItem(OWNER_STORAGE_KEY, generated);
  } catch {
    /* armazenamento indisponível */
  }

  return generated;
}

function sessionHeaders({ json = true } = {}) {
  const headers = { "X-Owner-Id": apiOwnerId };
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

async function createApiSession() {
  const response = await fetch("/api/sessions", {
    method: "POST",
    headers: sessionHeaders(),
    body: JSON.stringify({
      mode: conversationMode,
      language: selectedLanguage?.id ?? null,
      voice: selectedVoice ?? null,
    }),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(
      data?.message || `sessão respondeu ${response.status}`,
    );
    error.status = response.status;
    throw error;
  }
  if (!data?.sessionId) throw new Error("sessão sem id");
  return data.sessionId;
}

function startApiSession() {
  if (apiSessionId || apiSessionPromise) return;

  apiSessionPromise = createApiSession()
    .then((sessionId) => {
      apiSessionId = sessionId;
      return sessionId;
    })
    .catch((error) => {
      console.warn("[socrates] não foi possível criar a sessão", error);
      apiSessionPromise = null;
      return null;
    });
}

async function ensureApiSession() {
  if (apiSessionId) return apiSessionId;
  if (!apiSessionPromise) startApiSession();
  if (!apiSessionPromise) return null;
  const sessionId = await apiSessionPromise;
  return sessionId ?? null;
}

function updateEndSessionButton() {
  if (!dom.endSessionBtn) return;
  const visible = sessionActive && messages.length > 0;
  dom.endSessionBtn.hidden = !visible;
  dom.endSessionBtn.disabled = !visible;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function clearNode(node) {
  if (node) node.replaceChildren();
}

function isDesktopRail() {
  return window.matchMedia("(min-width: 900px)").matches;
}

function friendlySummaryError(code) {
  return SUMMARY_ERRORS[code] ?? "Não foi possível gerar o resumo.";
}

function languageLabel(id) {
  if (!id) return "";
  const fromCatalog = voiceCatalog?.languages?.find(
    (language) => language.id === id,
  );
  if (fromCatalog) return fromCatalog.label;
  const fallback = FALLBACK_VOICE_CATALOG.languages.find(
    (language) => language.id === id,
  );
  return fallback?.label ?? id;
}

function formatSummaryDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

/* ---------- confirmação de encerramento ---------- */

function setSummaryHeader(kicker, title) {
  if (dom.summaryKicker) dom.summaryKicker.textContent = kicker;
  if (dom.summaryTitle) dom.summaryTitle.textContent = title;
}

function setSummaryFoot(actions) {
  if (!dom.summaryFoot) return;
  clearNode(dom.summaryFoot);

  for (const action of actions) {
    const button = element(
      "button",
      `summary-btn${action.primary ? " summary-btn--primary" : ""}`,
      action.label,
    );
    button.type = "button";
    button.disabled = Boolean(action.disabled);
    button.addEventListener("click", () => action.onClick?.());
    dom.summaryFoot.appendChild(button);
  }
}

function openSummaryOverlay() {
  if (!dom.summaryOverlay) return;
  if (dom.summaryOverlay.hidden) {
    summaryPreviousFocus = document.activeElement;
    dom.summaryOverlay.hidden = false;
  }
  requestAnimationFrame(() => dom.summaryCloseBtn?.focus());
}

function hideConfirmModal() {
  if (!dom.summaryOverlay) return;
  dom.summaryOverlay.hidden = true;
  if (summaryView === "confirm") summaryView = "closed";

  const previous = summaryPreviousFocus;
  summaryPreviousFocus = null;
  if (previous?.focus) {
    try {
      previous.focus();
    } catch {
      /* noop */
    }
  }
}

function requestEndConversation() {
  if (!sessionActive) return;
  if (summaryView === "confirm" && dom.summaryOverlay && !dom.summaryOverlay.hidden) {
    return;
  }

  summaryView = "confirm";
  setSummaryHeader("Fim da conversa", "Encerrar conversa e gerar o resumo?");
  clearNode(dom.summaryBody);
  dom.summaryBody.appendChild(
    element(
      "p",
      "summary-section-text",
      "O resumo da conversa fica salvo em “Meus resumos” para você reler depois.",
    ),
  );

  setSummaryFoot([
    { label: "Continuar conversando", onClick: hideConfirmModal },
    {
      label: "Encerrar e ver resumo",
      primary: true,
      onClick: () => {
        hideConfirmModal();
        finishConversation().catch((error) => {
          console.warn("[socrates] falha ao finalizar a conversa", error);
        });
      },
    },
  ]);

  openSummaryOverlay();
}

/* ---------- rail de resumos ---------- */

function setRailOpen(open, { focus = true, reload = true } = {}) {
  railOpen = Boolean(open);

  if (dom.summariesRail) dom.summariesRail.hidden = !railOpen;
  if (dom.railBackdrop) dom.railBackdrop.hidden = !railOpen;
  document.body.dataset.rail = railOpen ? "open" : "closed";
  dom.historyBtn?.setAttribute("aria-expanded", railOpen ? "true" : "false");

  if (!railOpen) {
    if (focus) dom.historyBtn?.focus?.();
    return;
  }

  if (reload) {
    loadRailList().catch(() => {});
  }

  if (focus) {
    requestAnimationFrame(() => {
      if (isDesktopRail()) dom.summarySearch?.focus();
      else dom.railClose?.focus();
    });
  }
}

function toggleRail() {
  setRailOpen(!railOpen);
}

function groupLabel(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "Anteriores";

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  const diff = Math.round((startOfToday - startOfDay) / 86_400_000);

  if (diff <= 0) return "Hoje";
  if (diff === 1) return "Ontem";
  return "Anteriores";
}

function formatConceptTag(key) {
  const text = String(key ?? "").replace(/-/g, " ").trim();
  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function renderRailLoading() {
  if (!dom.summaryList) return;
  clearNode(dom.summaryList);
  const wrap = element("div", "rail-loading");
  for (let index = 0; index < 4; index += 1) {
    wrap.appendChild(element("div", "skeleton"));
  }
  dom.summaryList.appendChild(wrap);
}

function renderRailError() {
  if (!dom.summaryList) return;
  clearNode(dom.summaryList);

  const wrap = element("div", "rail-empty");
  wrap.appendChild(
    element(
      "p",
      "",
      "Não foi possível carregar seus resumos. Verifique se o MongoDB está rodando.",
    ),
  );

  const retry = element("button", "summary-btn", "Tentar de novo");
  retry.type = "button";
  retry.addEventListener("click", () => {
    loadRailList().catch(() => {});
  });
  wrap.appendChild(retry);
  dom.summaryList.appendChild(wrap);
}

async function loadRailList({ silent = false } = {}) {
  if (!dom.summaryList) return;
  if (!silent) renderRailLoading();

  try {
    const response = await fetch("/api/sessions?limit=50", {
      headers: sessionHeaders({ json: false }),
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`histórico respondeu ${response.status}`);
    }

    const data = await response.json();
    railSummaries = Array.isArray(data.sessions) ? data.sessions : [];
    renderRailList();
  } catch (error) {
    console.warn("[socrates] falha ao carregar o rail de resumos", error);
    renderRailError();
  }
}

function renderRailList() {
  if (!dom.summaryList) return;
  clearNode(dom.summaryList);

  const filter = railFilter.trim().toLowerCase();
  const items = railSummaries.filter((item) => {
    if (!filter) return true;
    const haystack = [
      item.title,
      item.overview,
      ...(item.conceptIndex ?? []),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(filter);
  });

  if (!items.length) {
    const empty = element("div", "rail-empty");
    empty.appendChild(
      element(
        "p",
        "",
        railSummaries.length
          ? "Nenhum resumo corresponde à busca."
          : "Nenhum resumo salvo ainda. Encerre uma conversa para criar o primeiro.",
      ),
    );
    dom.summaryList.appendChild(empty);
    return;
  }

  let group = "";

  for (const item of items) {
    const nextGroup = groupLabel(item.updatedAt || item.createdAt);
    if (nextGroup !== group) {
      group = nextGroup;
      dom.summaryList.appendChild(element("p", "rail-group", group));
    }

    const active = item.sessionId === selectedSessionId;
    const button = element("button", `rail-item${active ? " is-active" : ""}`);
    button.type = "button";
    button.dataset.sessionId = item.sessionId;

    button.appendChild(
      element(
        "span",
        "rail-item-title",
        item.title ||
          (item.status === "generating"
            ? "Gerando resumo…"
            : item.status === "failed"
              ? "Resumo com falha"
              : "Resumo sem título"),
      ),
    );

    const status =
      item.status === "generating"
        ? "gerando…"
        : item.status === "failed"
          ? "falhou"
          : "";

    button.appendChild(
      element(
        "span",
        "rail-item-meta",
        [
          item.mode === "learning" ? "Aprendizado" : "Entrevista",
          `${item.turnCount ?? 0} mensagens`,
          status,
        ]
          .filter(Boolean)
          .join(" · "),
      ),
    );

    const tags = (item.conceptIndex ?? []).slice(0, 2);
    if (tags.length) {
      const tagWrap = element("span", "rail-item-tags");
      for (const tag of tags) {
        const label = formatConceptTag(tag);
        if (label) tagWrap.appendChild(element("span", "rail-item-tag", label));
      }
      if (tagWrap.childElementCount) button.appendChild(tagWrap);
    }

    button.addEventListener("click", () => {
      openSavedSummary(item.sessionId).catch((error) => {
        console.warn("[socrates] falha ao abrir o resumo", error);
      });
      if (!isDesktopRail()) {
        setRailOpen(false, { focus: false });
      }
    });

    dom.summaryList.appendChild(button);
  }

  dom.summaryList
    .querySelector(".rail-item.is-active")
    ?.scrollIntoView({ block: "nearest" });
}

/* ---------- leitor de resumo ---------- */

function openReader() {
  if (!dom.readerView) return;
  const wasHidden = dom.readerView.hidden;
  readerOpen = true;
  dom.readerView.hidden = false;
  document.body.dataset.view = "reader";

  if (wasHidden) {
    dom.readerView.scrollTop = 0;
    requestAnimationFrame(() => dom.readerBack?.focus());
  }
}

function closeReader() {
  if (!dom.readerView) return;
  readerOpen = false;
  dom.readerView.hidden = true;
  document.body.dataset.view = "conversation";
  summaryView = "closed";
  summaryPollToken += 1;
  window.clearTimeout(summaryPollTimer);
  summaryPollTimer = 0;

  if (railOpen && isDesktopRail()) dom.summarySearch?.focus?.();
  else dom.orb?.focus?.();
}

function setReaderHeader(kicker, title) {
  if (dom.readerKicker) dom.readerKicker.textContent = kicker;
  if (dom.readerTitle) dom.readerTitle.textContent = title;
}

function setReaderMeta(items) {
  if (!dom.readerMeta) return;
  clearNode(dom.readerMeta);
  for (const item of items.filter(Boolean)) {
    dom.readerMeta.appendChild(element("span", "summary-chip", item));
  }
}

function setReaderActions(actions) {
  if (!dom.readerActions) return;
  clearNode(dom.readerActions);

  for (const action of actions) {
    const button = element(
      "button",
      `summary-btn${action.primary ? " summary-btn--primary" : ""}`,
      action.label,
    );
    button.type = "button";
    button.disabled = Boolean(action.disabled);
    button.addEventListener("click", () => action.onClick?.());
    dom.readerActions.appendChild(button);
  }
}

function renderReaderLoading() {
  summaryView = "loading";
  summaryPollToken += 1;
  window.clearTimeout(summaryPollTimer);
  summaryPollTimer = 0;

  openReader();
  setReaderHeader("Resumo da conversa", "Organizando o que você aprendeu…");
  setReaderMeta([]);
  setReaderActions([
    { label: "Meus resumos", onClick: () => setRailOpen(true) },
  ]);

  clearNode(dom.readerBody);
  const wrap = element("div", "summary-loading");
  wrap.appendChild(
    element(
      "p",
      "",
      "Isso leva alguns segundos. Você pode voltar à conversa; o resumo continua sendo gerado.",
    ),
  );
  wrap.appendChild(element("div", "skeleton skeleton--title"));
  for (const modifier of [
    "skeleton--line",
    "skeleton--line",
    "skeleton--short",
    "skeleton--line",
  ]) {
    wrap.appendChild(element("div", `skeleton ${modifier}`));
  }

  dom.readerBody.appendChild(wrap);
  dom.readerView.scrollTop = 0;
}

function renderReaderSummary(summary) {
  summaryView = "ready";
  summaryPollToken += 1;
  window.clearTimeout(summaryPollTimer);
  summaryPollTimer = 0;

  activeSummary = summary;
  if (summary?.sessionId) {
    summarySessionId = summary.sessionId;
    selectedSessionId = summary.sessionId;
  }

  openReader();
  setReaderHeader("Resumo da conversa", summary.title || "Resumo da conversa");

  const modeLabel = summary.mode === "learning" ? "Aprendizado" : "Entrevista";
  setReaderMeta([
    modeLabel,
    languageLabel(summary.language),
    `${summary.turnCount ?? 0} mensagens`,
    formatSummaryDate(summary.updatedAt || summary.createdAt),
  ]);

  clearNode(dom.readerBody);

  if (summary.overview) {
    dom.readerBody.appendChild(
      element("p", "summary-overview", summary.overview),
    );
  }

  for (const section of summary.sections ?? []) {
    const wrapper = element("section", "summary-section");
    wrapper.appendChild(
      element("h3", "summary-section-title", section.title || "Conceito"),
    );

    if (section.summary) {
      wrapper.appendChild(
        element("p", "summary-section-text", section.summary),
      );
    }

    if (Array.isArray(section.keyPoints) && section.keyPoints.length) {
      const list = element("ul", "summary-keypoints");
      for (const point of section.keyPoints) {
        list.appendChild(element("li", "", point));
      }
      wrapper.appendChild(list);
    }

    const cards = element("div", "summary-cards");
    for (const [label, value] of [
      ["Exemplo", section.example],
      ["Analogia", section.analogy],
      ["Erro comum", section.commonMistake],
    ]) {
      if (!value) continue;
      const card = element("div", "summary-card");
      card.appendChild(element("span", "summary-card-label", label));
      card.appendChild(element("p", "", value));
      cards.appendChild(card);
    }

    if (section.checkQuestion?.question) {
      const card = element("div", "summary-card summary-card--check");
      card.appendChild(
        element("span", "summary-card-label", "Pergunta de checagem"),
      );
      const details = element("details");
      details.appendChild(
        element("summary", "", section.checkQuestion.question),
      );
      if (section.checkQuestion.answer) {
        details.appendChild(
          element("p", "", section.checkQuestion.answer),
        );
      }
      card.appendChild(details);
      cards.appendChild(card);
    }

    if (cards.childElementCount) wrapper.appendChild(cards);

    if (Array.isArray(section.flashcards) && section.flashcards.length) {
      const flashcards = element("div", "summary-flashcards");
      for (const flashcard of section.flashcards) {
        const details = element("details", "summary-flashcard");
        details.appendChild(element("summary", "", flashcard.front));
        details.appendChild(element("p", "", flashcard.back));
        flashcards.appendChild(details);
      }
      wrapper.appendChild(flashcards);
    }

    dom.readerBody.appendChild(wrapper);
  }

  if (summary.openQuestions?.length) {
    const section = element("section", "summary-section");
    section.appendChild(
      element("h3", "summary-section-title", "Perguntas em aberto"),
    );
    const list = element("ul", "summary-keypoints");
    for (const question of summary.openQuestions) {
      list.appendChild(element("li", "", question));
    }
    section.appendChild(list);
    dom.readerBody.appendChild(section);
  }

  if (summary.nextSteps?.length) {
    const section = element("section", "summary-section");
    section.appendChild(
      element("h3", "summary-section-title", "Próximos passos"),
    );
    const list = element("ul", "summary-keypoints");
    for (const step of summary.nextSteps) {
      list.appendChild(element("li", "", step));
    }
    section.appendChild(list);
    dom.readerBody.appendChild(section);
  }

  setReaderActions([
    { label: "Baixar Markdown", onClick: downloadSummary },
    { label: "Meus resumos", onClick: () => setRailOpen(true) },
    { label: "Nova conversa", primary: true, onClick: startNewConversation },
  ]);

  dom.readerView.scrollTop = 0;
  renderRailList();
  loadRailList({ silent: true }).catch(() => {});
}

function renderReaderError(
  message,
  {
    retry = false,
    title = "Não foi possível gerar o resumo",
    kicker = "Resumo da conversa",
  } = {},
) {
  summaryView = "error";
  summaryPollToken += 1;
  window.clearTimeout(summaryPollTimer);
  summaryPollTimer = 0;

  openReader();
  setReaderHeader(kicker, title);
  setReaderMeta([]);
  setReaderActions([]);
  clearNode(dom.readerBody);

  const box = element("div", "summary-error");
  box.appendChild(element("strong", "", "A conversa foi encerrada."));
  box.appendChild(element("p", "", message));
  dom.readerBody.appendChild(box);

  const actions = [{ label: "Meus resumos", onClick: () => setRailOpen(true) }];

  if (retry) {
    actions.push({
      label: "Tentar de novo",
      primary: true,
      onClick: () => {
        const attempt = summarySessionId
          ? retrySummary()
          : finishConversation();
        attempt.catch((error) => {
          console.warn("[socrates] falha ao tentar o resumo novamente", error);
        });
      },
    });
  }

  actions.push({ label: "Nova conversa", onClick: startNewConversation });
  setReaderActions(actions);
  dom.readerView.scrollTop = 0;
  loadRailList({ silent: true }).catch(() => {});
}

/* ---------- fluxo de sessão ---------- */

function startNewConversation() {
  if (sessionActive && messages.length > 0) {
    const confirmed = window.confirm(
      "Descartar a conversa atual e começar uma nova?",
    );
    if (!confirmed) return false;
  }

  hideConfirmModal();
  closeReader();
  resetConversation();

  if (!isDesktopRail()) setRailOpen(false);
  return true;
}

async function finishConversation() {
  if (summaryView === "loading") return;

  summaryView = "loading";
  endSession();

  const transcript = messages
    .filter(
      (message) =>
        message &&
        typeof message.content === "string" &&
        message.content.trim(),
    )
    .map((message) => ({
      role: message.role,
      content: message.content.trim(),
    }));

  renderReaderLoading();

  if (isDesktopRail()) {
    setRailOpen(true, { focus: false });
  }

  if (transcript.length < 2) {
    renderReaderError(
      "A conversa é curta demais para gerar um resumo. Converse mais um pouco antes de encerrar.",
      { title: "Conversa curta demais" },
    );
    return;
  }

  try {
    const sessionId = await ensureApiSession();
    if (!sessionId) {
      renderReaderError(
        "Não foi possível abrir a sessão de resumo. Verifique se o backend e o MongoDB estão rodando.",
        { retry: true },
      );
      return;
    }

    summarySessionId = sessionId;
    selectedSessionId = sessionId;

    const response = await fetch(`/api/sessions/${sessionId}/end`, {
      method: "POST",
      headers: sessionHeaders(),
      body: JSON.stringify({ messages: transcript }),
    });

    const data = await response.json().catch(() => null);

    if (response.status === 503) {
      renderReaderError(SUMMARY_ERRORS.storage_unavailable, { retry: true });
      return;
    }

    if (!response.ok) {
      renderReaderError(
        data?.message ||
          friendlySummaryError(data?.error) ||
          "Não foi possível encerrar a conversa.",
        { retry: true },
      );
      return;
    }

    if (data?.status === "ready" && data.summary) {
      renderReaderSummary(data.summary);
      return;
    }

    loadRailList({ silent: true }).catch(() => {});
    startSummaryPolling(sessionId);
  } catch (error) {
    console.warn("[socrates] falha ao encerrar a conversa", error);
    renderReaderError(
      "Não foi possível gerar o resumo. Verifique a conexão e tente novamente.",
      { retry: true },
    );
  }
}

function startSummaryPolling(sessionId) {
  summarySessionId = sessionId;
  const token = ++summaryPollToken;
  const startedAt = Date.now();

  const schedule = () => {
    if (token !== summaryPollToken || summaryView !== "loading") return;
    window.clearTimeout(summaryPollTimer);
    summaryPollTimer = window.setTimeout(tick, SUMMARY_POLL_MS);
  };

  async function tick() {
    if (token !== summaryPollToken || summaryView !== "loading") return;

    try {
      const response = await fetch(`/api/sessions/${sessionId}/summary`, {
        headers: sessionHeaders({ json: false }),
        cache: "no-store",
      });

      if (token !== summaryPollToken || summaryView !== "loading") return;

      if (response.status === 202) {
        schedule();
        return;
      }

      if (response.ok) {
        const data = await response.json().catch(() => null);
        if (data?.summary) {
          renderReaderSummary(data.summary);
          return;
        }
      }

      const data = await response.json().catch(() => null);

      if (response.status === 502) {
        renderReaderError(friendlySummaryError(data?.error), {
          retry: true,
        });
        return;
      }

      if (response.status === 503) {
        renderReaderError(SUMMARY_ERRORS.storage_unavailable, {
          retry: true,
        });
        return;
      }

      if (response.status === 404) {
        renderReaderError("Resumo não encontrado para esta conversa.");
        return;
      }

      throw new Error(`resumo respondeu ${response.status}`);
    } catch (error) {
      if (token !== summaryPollToken || summaryView !== "loading") return;
      if (Date.now() - startedAt > SUMMARY_POLL_MAX_MS) {
        renderReaderError(
          "A geração do resumo demorou demais. Tente novamente.",
          { retry: true },
        );
        return;
      }
      schedule();
    }
  }

  tick();
}

async function retrySummary() {
  if (!summarySessionId) return;

  const sessionId = summarySessionId;
  renderReaderLoading();

  try {
    const response = await fetch(
      `/api/sessions/${sessionId}/summary/retry`,
      {
        method: "POST",
        headers: sessionHeaders({ json: false }),
      },
    );

    if (!response.ok) {
      const data = await response.json().catch(() => null);
      const known = data?.error ? SUMMARY_ERRORS[data.error] : "";
      renderReaderError(
        known || "Não foi possível iniciar a geração do resumo novamente.",
        { retry: true },
      );
      return;
    }

    loadRailList({ silent: true }).catch(() => {});
    startSummaryPolling(sessionId);
  } catch (error) {
    console.warn("[socrates] falha ao tentar o resumo novamente", error);
    renderReaderError("Não foi possível tentar novamente.", { retry: true });
  }
}

async function openSavedSummary(sessionId) {
  selectedSessionId = sessionId;
  summarySessionId = sessionId;
  renderRailList();
  renderReaderLoading();

  try {
    const response = await fetch(`/api/sessions/${sessionId}/summary`, {
      headers: sessionHeaders({ json: false }),
      cache: "no-store",
    });

    if (response.status === 202) {
      startSummaryPolling(sessionId);
      return;
    }

    if (response.ok) {
      const data = await response.json().catch(() => null);
      if (data?.summary) {
        renderReaderSummary(data.summary);
        return;
      }
    }

    const data = await response.json().catch(() => null);

    if (response.status === 502) {
      renderReaderError(friendlySummaryError(data?.error), {
        retry: true,
        title: "Não foi possível abrir o resumo",
      });
      return;
    }

    renderReaderError("Não foi possível carregar este resumo.", {
      retry: response.status >= 500,
      title: "Não foi possível abrir o resumo",
    });
  } catch (error) {
    console.warn("[socrates] falha ao carregar o resumo", error);
    renderReaderError("Não foi possível carregar este resumo.", {
      retry: true,
      title: "Não foi possível abrir o resumo",
    });
  }
}

function openHistory() {
  toggleRail();
}

/* ---------- markdown ---------- */

function summaryToMarkdown(summary) {
  const lines = [`# ${summary.title || "Resumo da conversa"}`, ""];

  if (summary.overview) lines.push(summary.overview, "");

  for (const section of summary.sections ?? []) {
    lines.push(`## ${section.title || "Conceito"}`, "");
    if (section.summary) lines.push(section.summary, "");

    if (section.keyPoints?.length) {
      lines.push("**Pontos-chave**", "");
      for (const point of section.keyPoints) lines.push(`- ${point}`);
      lines.push("");
    }

    if (section.example) lines.push(`**Exemplo:** ${section.example}`, "");
    if (section.analogy) lines.push(`**Analogia:** ${section.analogy}`, "");
    if (section.commonMistake) {
      lines.push(`**Erro comum:** ${section.commonMistake}`, "");
    }

    if (section.checkQuestion?.question) {
      lines.push(
        `**Pergunta de checagem:** ${section.checkQuestion.question}`,
        `**Resposta:** ${section.checkQuestion.answer ?? ""}`,
        "",
      );
    }

    if (section.flashcards?.length) {
      lines.push("**Flashcards**", "");
      for (const flashcard of section.flashcards) {
        lines.push(`- ${flashcard.front} — ${flashcard.back}`);
      }
      lines.push("");
    }
  }

  if (summary.openQuestions?.length) {
    lines.push("## Perguntas em aberto", "");
    for (const question of summary.openQuestions) {
      lines.push(`- ${question}`);
    }
    lines.push("");
  }

  if (summary.nextSteps?.length) {
    lines.push("## Próximos passos", "");
    for (const step of summary.nextSteps) lines.push(`- ${step}`);
    lines.push("");
  }

  return lines.join("\n");
}

function downloadSummary() {
  if (!activeSummary) return;

  const markdown = summaryToMarkdown(activeSummary);
  const blob = new Blob([markdown], {
    type: "text/markdown;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const date = new Date().toISOString().slice(0, 10);

  anchor.href = url;
  anchor.download = `socrates-resumo-${date}.md`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ============================================================
   Detecção de modo
   ============================================================ */

async function detectMode() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("mock") === "1") return "demo";
  if (params.get("live") === "1") return "live";

  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 900);

    const response = await fetch("/api/health", {
      signal: controller.signal,
      cache: "no-store",
    });

    window.clearTimeout(timer);

    if (response.ok) {
      const data = await response.json().catch(() => null);
      if (!data || data.ok !== false) return "live";
    }
  } catch {
    /* sem backend — segue em demo */
  }

  return "demo";
}

/* ============================================================
   Preview (revisão visual): ?preview=conversation&state=speaking
   ============================================================ */

function seedPreview() {
  messages = [
    { role: "assistant", content: OPENING },
    { role: "user", content: PREVIEW_USER },
    { role: "assistant", content: PROBES[0] },
  ];

  addStaticMessage("assistant", OPENING);
  addStaticMessage("user", PREVIEW_USER);
  addStaticMessage("assistant", PROBES[0]);

  miniDetail = `Você: ${PREVIEW_USER}`;

  dom.app.classList.add("has-conversation");
  dom.transcript.hidden = false;
  dom.hero.hidden = true;
  dom.resetBtn.hidden = false;
  setState("listening");

  requestAnimationFrame(() => {
    dom.transcript.scrollTop = dom.transcript.scrollHeight;
  });
}

/* ============================================================
   Eventos
   ============================================================ */

function bindEvents() {
  dom.orb.addEventListener("click", onOrbClick);
  dom.miniBtn?.addEventListener("click", openMini);

  dom.resetBtn.addEventListener("click", () => {
    if (startNewConversation()) setRailOpen(false);
  });

  dom.endSessionBtn?.addEventListener("click", requestEndConversation);
  dom.historyBtn?.addEventListener("click", openHistory);
  dom.summaryCloseBtn?.addEventListener("click", hideConfirmModal);
  dom.summaryOverlay?.addEventListener("click", (event) => {
    if (event.target?.dataset?.summaryClose) hideConfirmModal();
  });

  dom.railClose?.addEventListener("click", () => setRailOpen(false));
  dom.railBackdrop?.addEventListener("click", () => setRailOpen(false));
  dom.railNewConversation?.addEventListener("click", () => {
    startNewConversation();
  });
  dom.readerBack?.addEventListener("click", closeReader);
  dom.summarySearch?.addEventListener("input", () => {
    railFilter = dom.summarySearch.value;
    renderRailList();
  });

  dom.modeSelect?.addEventListener("change", onModeChange);
  dom.languageSelect?.addEventListener("change", onLanguageChange);
  dom.voiceSelect?.addEventListener("change", onVoiceChange);
  dom.voiceAudition?.addEventListener("click", () => {
    auditionVoice().catch((error) => {
      console.warn("[socrates] prévia de voz falhou", error);
    });
  });
  dom.voicePreviewPlayer?.addEventListener("ended", finishVoicePreview);
  dom.voicePreviewPlayer?.addEventListener("error", onVoicePreviewAudioError);

  dom.textToggle.addEventListener("click", () => {
    recognition?.stop();
    openComposer();
  });

  dom.composer.addEventListener("submit", (event) => {
    event.preventDefault();
    if (state !== "listening" || !sessionActive) return;
    handleUserText(dom.composerInput.value);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;

    if (dom.summaryOverlay && !dom.summaryOverlay.hidden) {
      hideConfirmModal();
      return;
    }

    if (railOpen && dom.summarySearch === document.activeElement) {
      if (dom.summarySearch.value) {
        dom.summarySearch.value = "";
        railFilter = "";
        renderRailList();
        return;
      }
      setRailOpen(false);
      return;
    }

    if (readerOpen) {
      closeReader();
      return;
    }

    if (railOpen) {
      setRailOpen(false);
      return;
    }

    if (sessionActive) requestEndConversation();
  });

  window.addEventListener("pagehide", () => {
    stopVoicePreview();
    releaseVoicePreviewCache();
    abortChat();
    resetAudio();
    recognition?.abort();
  });
}

function setupRecognition() {
  recognition = createRecognizer({
    lang: "pt-BR",
    onInterim(text) {
      if (!sessionActive || state !== "listening") return;
      showInterim(text);
    },
    onFinal(text) {
      if (!sessionActive || state !== "listening") return;
      handleUserText(text);
    },
    onError(error) {
      if (error === "not-allowed" || error === "service-not-allowed") {
        recognitionBlocked = true;
        if (sessionActive) openComposer("Microfone bloqueado. Digite sua resposta.");
        updateToggle();
        return;
      }

      if (error === "network" && sessionActive && state === "listening") {
        openComposer("Falha no reconhecimento. Tente novamente ou digite.");
      }
    },
    onEnd() {
      if (
        !sessionActive ||
        state !== "listening" ||
        recognitionBlocked ||
        voicePreviewState !== "idle"
      ) {
        return;
      }

      window.clearTimeout(listeningTimer);
      listeningTimer = window.setTimeout(() => {
        if (!sessionActive || state !== "listening" || !dom.composer.hidden) return;
        beginRecognition();
      }, 600);
    },
  });
}

/* ============================================================
   Boot
   ============================================================ */

async function boot() {
  setupTheme();

  const storedMode = readStoredMode();
  if (MODE_COPY[storedMode]) conversationMode = storedMode;
  applyModeCopy();

  bindEvents();
  setupRecognition();

  const params = new URLSearchParams(window.location.search);

  if (params.get("preview") === "conversation") {
    seedPreview();
  } else {
    setState("idle");
  }

  mode = await detectMode();
  setConnection(mode);

  if (mode === "live") {
    setupVoicePicker().catch((error) => {
      console.warn("[socrates] falha ao carregar o seletor de vozes", error);
    });
  } else {
    conversationMode = "interview";
    applyModeCopy();
  }

  const forced = params.get("state");
  if (forced && STATE_COPY[forced]) setState(forced);

  if (params.get("mini") === "1") openFallbackMini();
}

boot();
