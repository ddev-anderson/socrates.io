import { config } from "../config.js";
import { createMockWav } from "./mock.js";
import { synthesizeWithQwen } from "./qwen.js";

export async function synthesizeSpeech({ text, language, speaker, signal }) {
  if (config.ttsProvider === "qwen") {
    return synthesizeWithQwen({ text, language, speaker, signal });
  }

  return createMockWav(text);
}
