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
  "e.g",
  "i.e",
]);

const SENTENCE_END = /(?:[.!?…]+(?=\s|$)|[。！？]+)/g;

export function sanitizeForSpeech(value) {
  if (typeof value !== "string") return "";

  let text = value;

  text = text.replace(/```[\s\S]*?```/g, " ");
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/https?:\/\/\S+/gi, " ");
  text = text.replace(/<\/?[a-z][^>]*>/gi, " ");
  text = text.replace(/[*_~#>|]+/g, " ");
  text = text.replace(/^\s*[-•]\s+/gm, " ");
  text = text.replace(/^\s*\d+[.)]\s+/gm, " ");
  text = text.replace(/[\p{Extended_Pictographic}️‍]/gu, " ");
  text = text.replace(/\s+/g, " ").trim();

  return text;
}

export function createSentenceSplitter({
  firstMinChars = 18,
  minChars = 55,
  // Com TTS por sentença inteira, prefira esperar a pontuação em vez de
  // cortar uma frase longa no meio de uma oração.
  maxChars = 600,
} = {}) {
  let buffer = "";
  let emitted = 0;
  let first = true;

  function takeCut() {
    const minLength = first ? firstMinChars : minChars;

    SENTENCE_END.lastIndex = 0;
    let match;

    while ((match = SENTENCE_END.exec(buffer)) !== null) {
      const end = match.index + match[0].length;
      if (end > maxChars) break;

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

    if (buffer.length > maxChars) {
      const window = buffer.slice(0, maxChars);
      const cut = window.lastIndexOf(" ");
      if (cut > minLength) return cut;
      // Chinês/japonês não usam espaços; corta no limite para não travar o áudio.
      return maxChars;
    }

    return 0;
  }

  return {
    push(delta) {
      if (typeof delta !== "string" || !delta) return [];
      buffer += delta;

      const sentences = [];
      let cut;

      while ((cut = takeCut()) > 0) {
        const raw = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut).trimStart();

        const text = sanitizeForSpeech(raw);
        if (text) {
          sentences.push({ index: emitted, text });
          emitted += 1;
        }

        first = false;
      }

      return sentences;
    },

    flush() {
      const raw = buffer.trim();
      buffer = "";

      const text = sanitizeForSpeech(raw);
      if (!text) return [];

      first = false;
      const sentence = { index: emitted, text };
      emitted += 1;
      return [sentence];
    },

    get bufferedChars() {
      return buffer.length;
    },
  };
}
