// Vozes CustomVoice do checkpoint Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit.
// Chelsie e Ethan existem na documentação do Qwen, mas não neste checkpoint.
// Mantenha esta lista alinhada com SUPPORTED_SPEAKERS em server-voz/app.py.
export const VOICES = [
  { id: "Serena", label: "Serena" },
  { id: "Vivian", label: "Vivian" },
  { id: "Ono_Anna", label: "Ono Anna" },
  { id: "Sohee", label: "Sohee" },
  { id: "Ryan", label: "Ryan" },
  { id: "Aiden", label: "Aiden" },
  { id: "Dylan", label: "Dylan" },
  { id: "Eric", label: "Eric" },
  { id: "Uncle_Fu", label: "Uncle Fu" },
];

export const FALLBACK_VOICE = "Serena";

const byId = new Map(VOICES.map((voice) => [voice.id.toLowerCase(), voice]));

export function resolveVoice(value) {
  if (typeof value !== "string") return null;
  return byId.get(value.trim().toLowerCase()) ?? null;
}
