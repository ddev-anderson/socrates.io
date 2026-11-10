import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { config } from "./config.js";
import { streamChat as defaultChatStream } from "./chat/deepseek.js";
import { closeDb } from "./db.js";
import chatRoutes from "./routes/chat.js";
import healthRoutes from "./routes/health.js";
import sessionsRoutes from "./routes/sessions.js";
import ttsRoutes from "./routes/tts.js";

export async function buildApp({ logger, chatStream = defaultChatStream } = {}) {
  const app = Fastify({
    logger: logger === undefined ? { level: config.logLevel } : logger,
    bodyLimit: 1_000_000,
  });

  await app.register(chatRoutes, { streamChat: chatStream });
  await app.register(ttsRoutes);
  await app.register(healthRoutes);
  await app.register(sessionsRoutes);

  app.addHook("onClose", async () => {
    await closeDb();
  });

  await app.register(fastifyStatic, {
    root: config.frontendDir,
    prefix: "/",
    index: ["index.html"],
    maxAge: 0,
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "not_found", path: request.url });
    }
    return reply.code(404).send({ error: "not_found" });
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    return reply
      .code(status)
      .send({ error: status >= 500 ? "internal_error" : error.message });
  });

  return app;
}
