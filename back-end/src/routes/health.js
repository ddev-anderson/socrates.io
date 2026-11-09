import { config } from "../config.js";

export default async function healthRoutes(app) {
  app.get("/api/health", async () => ({
    ok: config.ready,
    ready: config.ready,
    service: config.appName,
    version: config.version,
    chat: config.ready ? "live" : "pending",
    tts: config.ttsProvider,
    deepseek: config.hasDeepSeekKey ? "configured" : "missing",
    time: new Date().toISOString(),
  }));
}
