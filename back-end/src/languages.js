// Idiomas do TTS e da conversa. "auto" existe no MLX, mas não entra no seletor:
// o reconhecimento de fala e o prompt precisam de um locale concreto.
export const LANGUAGES = [
  {
    id: "portuguese",
    label: "Português",
    name: "Portuguese",
    locale: "pt-BR",
    sample: "Olá. Esta é a minha voz.",
  },
  {
    id: "english",
    label: "English",
    name: "English",
    locale: "en-US",
    sample: "Hello. This is my voice.",
  },
  {
    id: "spanish",
    label: "Español",
    name: "Spanish",
    locale: "es-ES",
    sample: "Hola. Esta es mi voz.",
  },
  {
    id: "french",
    label: "Français",
    name: "French",
    locale: "fr-FR",
    sample: "Bonjour. C'est ma voix.",
  },
  {
    id: "italian",
    label: "Italiano",
    name: "Italian",
    locale: "it-IT",
    sample: "Ciao. Questa è la mia voce.",
  },
  {
    id: "german",
    label: "Deutsch",
    name: "German",
    locale: "de-DE",
    sample: "Hallo. Das ist meine Stimme.",
  },
  {
    id: "japanese",
    label: "日本語",
    name: "Japanese",
    locale: "ja-JP",
    sample: "こんにちは。これが私の声です。",
  },
  {
    id: "korean",
    label: "한국어",
    name: "Korean",
    locale: "ko-KR",
    sample: "안녕하세요. 제 목소리입니다.",
  },
  {
    id: "chinese",
    label: "中文",
    name: "Chinese",
    locale: "zh-CN",
    sample: "你好。这是我的声音。",
  },
  {
    id: "russian",
    label: "Русский",
    name: "Russian",
    locale: "ru-RU",
    sample: "Здравствуйте. Это мой голос.",
  },
];

export const DEFAULT_LANGUAGE = "portuguese";

const byId = new Map(LANGUAGES.map((language) => [language.id, language]));

export function resolveLanguage(value) {
  if (typeof value !== "string") return null;
  return byId.get(value.trim().toLowerCase()) ?? null;
}
