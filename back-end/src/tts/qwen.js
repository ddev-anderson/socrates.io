import { config } from "../config.js";

export async function synthesizeWithQwen({ text, language, speaker, signal }) {
  const timeoutSignal = AbortSignal.timeout(config.ttsTimeoutMs);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  const response = await fetch(new URL("/v1/audio/speech", config.ttsUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "audio/wav",
    },
    body: JSON.stringify({
      text,
      language: language ?? "Portuguese",
      speaker: speaker ?? config.ttsSpeaker,
    }),
    signal: combinedSignal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const error = new Error(`TTS respondeu ${response.status}`);
    error.status = response.status;
    error.detail = detail.slice(0, 500);
    throw error;
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/json")) {
    throw new Error("TTS retornou um erro em JSON");
  }

  const audio = Buffer.from(await response.arrayBuffer());
  if (!audio.length) throw new Error("TTS retornou áudio vazio");

  return audio;
}

export async function openQwenSpeechStream({ text, language, speaker, signal }) {
  const timeoutSignal = AbortSignal.timeout(config.ttsTimeoutMs);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  const response = await fetch(
    new URL("/v1/audio/speech/stream", config.ttsUrl),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        text,
        language: language ?? "Portuguese",
        speaker: speaker ?? config.ttsSpeaker,
      }),
      signal: combinedSignal,
    },
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const error = new Error(`TTS stream respondeu ${response.status}`);
    error.status = response.status;
    error.detail = detail.slice(0, 500);
    throw error;
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("text/event-stream")) {
    await response.body?.cancel().catch(() => {});
    throw new Error("TTS stream não retornou SSE");
  }

  if (!response.body) throw new Error("TTS stream sem corpo");

  return response;
}
