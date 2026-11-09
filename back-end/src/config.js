import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_LANGUAGE, resolveLanguage } from "./languages.js";

const BACKEND_DIR = fileURLToPath(new URL("..", import.meta.url));
const APP_DIR = path.resolve(BACKEND_DIR, "..");

function resolveFrontendDir(value) {
  if (!value) return path.join(APP_DIR, "front-end");
  return path.isAbsolute(value) ? value : path.resolve(APP_DIR, value);
}

const frontendDir = resolveFrontendDir(process.env.FRONTEND_DIR);
const port = Number(process.env.PORT ?? 3000);
const ttsTimeoutMs = Number(process.env.TTS_TIMEOUT_MS ?? 45_000);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`PORT inválida: ${process.env.PORT ?? ""}`);
}

if (!Number.isFinite(ttsTimeoutMs) || ttsTimeoutMs < 1000) {
  throw new Error(`TTS_TIMEOUT_MS inválido: ${process.env.TTS_TIMEOUT_MS ?? ""}`);
}

if (!existsSync(path.join(frontendDir, "index.html"))) {
  throw new Error(
    `Front-end não encontrado em ${frontendDir}. Defina FRONTEND_DIR no .env.`,
  );
}

const hasDeepSeekKey = Boolean(process.env.DEEPSEEK_API_KEY);

export const config = {
  appName: "socrates-backend",
  version: "0.1.0",
  env: process.env.NODE_ENV ?? "development",
  host: process.env.HOST ?? "127.0.0.1",
  port,
  logLevel: process.env.LOG_LEVEL ?? "info",
  frontendDir,
  ttsProvider: process.env.TTS_PROVIDER ?? "mock",
  ttsUrl: process.env.TTS_URL ?? "http://127.0.0.1:8880",
  ttsSpeaker: process.env.TTS_SPEAKER ?? "Serena",
  ttsLanguage:
    resolveLanguage(process.env.TTS_LANGUAGE)?.id ?? DEFAULT_LANGUAGE,
  ttsTimeoutMs,
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
  deepseekModel: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
  hasDeepSeekKey,
  // B2: o chat live exige a chave. Sem ela o front-end fica em modo demo.
  ready: hasDeepSeekKey,
};
