import { config } from "../config.js";
import { createSentenceSplitter } from "../chat/splitter.js";
import { DEFAULT_MODE, resolveMode } from "../chat/modes.js";
import {
  DEFAULT_LANGUAGE,
  resolveLanguage,
} from "../languages.js";

function parseChatBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "corpo JSON inválido" };
  }

  if (body.messages !== undefined && !Array.isArray(body.messages)) {
    return { error: "messages deve ser um array" };
  }

  if (body.kickoff !== undefined && typeof body.kickoff !== "boolean") {
    return { error: "kickoff deve ser booleano" };
  }

  if (body.language !== undefined && typeof body.language !== "string") {
    return { error: "language deve ser string" };
  }

  if (body.mode !== undefined && typeof body.mode !== "string") {
    return { error: "mode deve ser string" };
  }

  const requestedLanguage =
    typeof body.language === "string" ? body.language.trim() : "";
  const selectedLanguage = requestedLanguage
    ? resolveLanguage(requestedLanguage)
    : null;

  if (requestedLanguage && !selectedLanguage) {
    return { error: "idioma inválido" };
  }

  const requestedMode =
    typeof body.mode === "string" ? body.mode.trim() : "";
  const selectedMode = requestedMode ? resolveMode(requestedMode) : null;

  if (requestedMode && !selectedMode) {
    return { error: "modo inválido" };
  }

  const language =
    selectedLanguage ??
    resolveLanguage(config.ttsLanguage) ??
    resolveLanguage(DEFAULT_LANGUAGE);
  const mode = selectedMode ?? resolveMode(DEFAULT_MODE);

  const messages = [];

  for (const message of body.messages ?? []) {
    if (!message || typeof message !== "object") continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (typeof message.content !== "string") continue;

    const content = message.content.trim();
    if (!content) continue;
    if (content.length > 8000) return { error: "mensagem muito longa" };

    messages.push({ role: message.role, content });
  }

  return {
    messages: messages.slice(-40),
    kickoff: body.kickoff === true || messages.length === 0,
    language: language.id,
    mode: mode.id,
  };
}

function friendlyChatError(error) {
  const status = error?.status ?? error?.response?.status;
  if (status === 401) return "Chave da DeepSeek inválida.";
  if (status === 402) return "Saldo da DeepSeek esgotado.";
  if (status === 429) return "Muitas requisições à DeepSeek. Tente novamente em instantes.";
  if (status >= 500) return "A DeepSeek está indisponível no momento.";
  if (error?.code === "deepseek_not_configured") {
    return "O backend está sem a chave da DeepSeek.";
  }
  return "Falha ao gerar a resposta.";
}

export default async function chatRoutes(app, { streamChat } = {}) {
  if (typeof streamChat !== "function") {
    throw new Error("chatRoutes exige um provider streamChat");
  }

  app.post("/api/chat", async (request, reply) => {
    const parsed = parseChatBody(request.body);

    if (parsed.error) {
      return reply.code(400).send({ error: "invalid_body", message: parsed.error });
    }

    const controller = new AbortController();
    let finished = false;

    const onResponseClose = () => {
      if (finished) return;
      controller.abort();
    };

    reply.raw.on("close", onResponseClose);

    reply.hijack();
    const raw = reply.raw;

    raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    raw.write(": connected\n\n");
    raw.setTimeout(0);

    const send = (payload) => {
      if (raw.writableEnded || raw.destroyed) return;
      raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const heartbeat = setInterval(() => {
      if (raw.writableEnded || raw.destroyed) return;
      raw.write(": ping\n\n");
    }, 15_000);

    const startedAt = performance.now();
    let firstTokenAt = null;
    let tokenCount = 0;

    try {
      const stream = streamChat({
        messages: parsed.messages,
        kickoff: parsed.kickoff,
        language: parsed.language,
        mode: parsed.mode,
        signal: controller.signal,
      });
      const splitter = createSentenceSplitter();
      let sentenceCount = 0;

      for await (const token of stream) {
        if (controller.signal.aborted) break;
        if (typeof token !== "string" || !token) continue;

        if (firstTokenAt === null) firstTokenAt = performance.now();
        tokenCount += 1;
        send({ type: "token", text: token });

        for (const sentence of splitter.push(token)) {
          if (controller.signal.aborted) break;
          sentenceCount += 1;
          send({
            type: "sentence",
            index: sentence.index,
            text: sentence.text,
          });
        }
      }

      if (!controller.signal.aborted) {
        for (const sentence of splitter.flush()) {
          sentenceCount += 1;
          send({
            type: "sentence",
            index: sentence.index,
            text: sentence.text,
          });
        }

        send({ type: "done" });
        request.log.info(
          {
            durationMs: Math.round(performance.now() - startedAt),
            firstTokenMs:
              firstTokenAt === null ? null : Math.round(firstTokenAt - startedAt),
            tokens: tokenCount,
            sentences: sentenceCount,
            history: parsed.messages.length,
            kickoff: parsed.kickoff,
            language: parsed.language,
            mode: parsed.mode,
            model: config.deepseekModel,
          },
          "chat concluído",
        );
      }
    } catch (error) {
      if (controller.signal.aborted) {
        request.log.info({ code: error?.code ?? null }, "chat abortado pelo cliente");
      } else {
        request.log.error(
          {
            status: error?.status ?? error?.response?.status ?? null,
            code: error?.code ?? null,
            name: error?.name ?? null,
            message: error?.message ?? "erro desconhecido",
          },
          "falha no chat",
        );
        send({ type: "error", message: friendlyChatError(error) });
      }
    } finally {
      finished = true;
      clearInterval(heartbeat);
      raw.off("close", onResponseClose);
      if (!raw.writableEnded && !raw.destroyed) raw.end();
    }
  });
}
