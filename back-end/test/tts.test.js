import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";

async function startApp(t) {
  const app = await buildApp({ logger: false });
  t.after(async () => {
    await app.close();
  });

  await app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = app.server.address();
  return `http://127.0.0.1:${port}`;
}

test("POST /api/tts devolve um WAV válido no provider mock", async (t) => {
  const base = await startApp(t);

  const response = await fetch(`${base}/api/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Olá mundo.", language: "Portuguese" }),
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /audio\/wav/);

  const audio = Buffer.from(await response.arrayBuffer());
  assert.ok(audio.length > 44);
  assert.equal(audio.toString("ascii", 0, 4), "RIFF");
  assert.equal(audio.toString("ascii", 8, 12), "WAVE");
  assert.equal(audio.readUInt32LE(24), 24_000);
  assert.equal(audio.readUInt16LE(34), 16);
  assert.ok(audio.readUInt32LE(40) > 0);
});

test("texto vazio responde 400", async (t) => {
  const base = await startApp(t);

  const response = await fetch(`${base}/api/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "   " }),
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "invalid_text");
});

test("POST /api/tts/stream devolve chunks SSE no provider mock", async (t) => {
  const base = await startApp(t);

  const response = await fetch(`${base}/api/tts/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Olá em streaming.", language: "Portuguese" }),
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  assert.equal(response.headers.get("x-tts-provider"), "mock");

  const body = await response.text();
  assert.match(body, /^: connected/);

  const events = body
    .split("\n\n")
    .filter((block) => block.startsWith("data: "))
    .map((block) => JSON.parse(block.slice("data: ".length)));

  const chunk = events.find((event) => event.audio);
  const done = events.find((event) => event.type === "done");

  assert.ok(chunk);
  assert.equal(chunk.index, 0);
  assert.equal(chunk.final, true);
  assert.equal(chunk.sample_rate, 24_000);
  assert.ok(chunk.audio_ms > 0);
  assert.ok(done);
  assert.equal(done.chunks, 1);

  const wav = Buffer.from(chunk.audio, "base64");
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.ok(wav.readUInt32LE(40) > 0);
});

test("/api/tts/stream valida o corpo", async (t) => {
  const base = await startApp(t);

  const response = await fetch(`${base}/api/tts/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "" }),
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "invalid_text");
});

test("GET /api/voices lista as vozes disponíveis e o padrão", async (t) => {
  const base = await startApp(t);

  const response = await fetch(`${base}/api/voices`);
  assert.equal(response.status, 200);

  const data = await response.json();
  assert.equal(data.default, "Serena");
  assert.equal(data.defaultLanguage, "portuguese");
  assert.equal(data.defaultMode, "interview");
  assert.equal(data.modes.length, 2);
  assert.ok(data.modes.some((mode) => mode.id === "learning"));
  assert.equal(data.voices.length, 9);
  assert.ok(data.voices.some((voice) => voice.id === "Serena"));
  assert.ok(data.voices.some((voice) => voice.id === "Uncle_Fu"));
  assert.ok(!data.voices.some((voice) => voice.id === "Chelsie"));
  assert.ok(!data.voices.some((voice) => voice.id === "Ethan"));
  assert.equal(data.languages.length, 10);
  assert.ok(data.languages.some((language) => language.id === "english"));
  assert.ok(
    data.languages.every(
      (language) => language.label && language.locale && language.sample,
    ),
  );
  assert.match(data.sample, /voz/i);
});

test("idioma desconhecido responde 400", async (t) => {
  const base = await startApp(t);

  const response = await fetch(`${base}/api/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Hello.", language: "klingon" }),
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "invalid_language");
});

test("voz desconhecida responde 400", async (t) => {
  const base = await startApp(t);

  const response = await fetch(`${base}/api/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Olá.", speaker: "VozInexistente" }),
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "invalid_speaker");
});
