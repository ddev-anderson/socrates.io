import { config } from "../config.js";
import { synthesizeSpeech } from "../tts/index.js";
import { createMockSpeechStream } from "../tts/mock.js";
import { openQwenSpeechStream } from "../tts/qwen.js";
import {
  FALLBACK_VOICE,
  VOICES,
  resolveVoice,
} from "../tts/voices.js";
import {
  DEFAULT_LANGUAGE,
  LANGUAGES,
  resolveLanguage,
} from "../languages.js";
import { DEFAULT_MODE, MODES } from "../chat/modes.js";

function parseSpeechBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "invalid_body" };
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return { error: "invalid_text" };
  if (text.length > 1000) return { error: "text_too_long" };

  if (body.language !== undefined && typeof body.language !== "string") {
    return { error: "invalid_language" };
  }

  const requestedLanguage =
    typeof body.language === "string" ? body.language.trim() : "";
  const selectedLanguage = requestedLanguage
    ? resolveLanguage(requestedLanguage)
    : null;

  if (requestedLanguage && !selectedLanguage) {
    return { error: "invalid_language" };
  }

  const language =
    selectedLanguage?.id ??
    resolveLanguage(config.ttsLanguage)?.id ??
    DEFAULT_LANGUAGE;

  const requestedSpeaker =
    typeof body.speaker === "string" ? body.speaker.trim() : "";
  const speaker = requestedSpeaker ? resolveVoice(requestedSpeaker) : null;

  if (requestedSpeaker && !speaker) return { error: "invalid_speaker" };

  return { text, language, speaker: speaker?.id ?? null };
}

function defaultVoice() {
  return resolveVoice(config.ttsSpeaker)?.id ?? FALLBACK_VOICE;
}

function beginSse(reply, provider) {
  reply.hijack();

  const raw = reply.raw;
  raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "X-TTS-Provider": provider,
  });
  raw.flushHeaders?.();
  raw.setTimeout?.(0);

  return raw;
}

export default async function ttsRoutes(app) {
  app.get("/api/voices", async () => {
    const defaultLanguage =
      resolveLanguage(config.ttsLanguage) ??
      resolveLanguage(DEFAULT_LANGUAGE) ??
      LANGUAGES[0];

    return {
      default: defaultVoice(),
      defaultLanguage: defaultLanguage.id,
      defaultMode: DEFAULT_MODE,
      modes: MODES,
      voices: VOICES,
      languages: LANGUAGES.map(({ id, label, locale, sample }) => ({
        id,
        label,
        locale,
        sample,
      })),
      sample: defaultLanguage.sample,
    };
  });

  app.post("/api/tts", async (request, reply) => {
    const parsed = parseSpeechBody(request.body);
    if (parsed.error) return reply.code(400).send({ error: parsed.error });

    const controller = new AbortController();
    const onClose = () => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    reply.raw.on("close", onClose);

    try {
      const audio = await synthesizeSpeech({
        text: parsed.text,
        language: parsed.language,
        speaker: parsed.speaker,
        signal: controller.signal,
      });

      if (reply.raw.writableEnded || reply.raw.destroyed) return;

      return reply
        .header("Content-Type", "audio/wav")
        .header("Cache-Control", "no-store")
        .header("Content-Length", audio.length)
        .send(audio);
    } catch (error) {
      request.log.error(
        {
          name: error?.name ?? null,
          status: error?.status ?? null,
          message: error?.message ?? "erro desconhecido",
          provider: config.ttsProvider,
        },
        "falha no TTS",
      );

      if (reply.raw.writableEnded || reply.raw.destroyed) return;

      if (controller.signal.aborted) {
        return reply.code(499).send({ error: "tts_aborted" });
      }

      return reply.code(502).send({ error: "tts_failed" });
    } finally {
      reply.raw.off("close", onClose);
    }
  });

  app.post("/api/tts/stream", async (request, reply) => {
    const parsed = parseSpeechBody(request.body);
    if (parsed.error) return reply.code(400).send({ error: parsed.error });

    const controller = new AbortController();
    let finished = false;

    const onClose = () => {
      if (!finished) controller.abort();
    };
    reply.raw.on("close", onClose);

    try {
      if (config.ttsProvider === "qwen") {
        const upstream = await openQwenSpeechStream({
          text: parsed.text,
          language: parsed.language,
          speaker: parsed.speaker,
          signal: controller.signal,
        });

        if (reply.raw.destroyed) {
          await upstream.body?.cancel().catch(() => {});
          return;
        }

        const raw = beginSse(reply, "qwen");

        try {
          for await (const chunk of upstream.body) {
            if (raw.destroyed) break;
            raw.write(chunk);
          }
        } catch (error) {
          if (raw.destroyed) return;

          if (error?.name !== "AbortError") {
            request.log.error(
              {
                name: error?.name ?? null,
                message: error?.message ?? "erro desconhecido",
                provider: config.ttsProvider,
              },
              "falha no stream do TTS",
            );
            raw.write(
              `data: ${JSON.stringify({
                type: "error",
                message: "tts_stream_failed",
              })}\n\n`,
            );
          }
        }

        finished = true;
        if (!raw.destroyed) raw.end();
        return;
      }

      const payload = createMockSpeechStream(parsed.text);
      if (reply.raw.destroyed) return;

      const raw = beginSse(reply, "mock");
      finished = true;
      raw.end(payload);
      return;
    } catch (error) {
      request.log.error(
        {
          name: error?.name ?? null,
          status: error?.status ?? null,
          message: error?.message ?? "erro desconhecido",
          provider: config.ttsProvider,
        },
        "falha no stream do TTS",
      );

      if (controller.signal.aborted || reply.raw.destroyed) return;

      return reply.code(502).send({ error: "tts_stream_failed" });
    } finally {
      reply.raw.off("close", onClose);
    }
  });
}
