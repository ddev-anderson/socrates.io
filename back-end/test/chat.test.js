import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";

async function startApp(t, chatStream) {
  const app = await buildApp({ logger: false, chatStream });
  t.after(async () => {
    await app.close();
  });

  await app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = app.server.address();
  return `http://127.0.0.1:${port}`;
}

test("POST /api/chat transmite tokens e done em SSE", async (t) => {
  let received = null;

  const base = await startApp(t, async function* (input) {
    received = input;
    yield "Esta é uma pergunta suficientemente longa. ";
    yield "E outra.";
  });

  const response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [], kickoff: true }),
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);

  const body = await response.text();
  assert.match(body, /^: connected/m);
  assert.match(body, /"type":"token","text":"Esta é uma pergunta suficientemente longa\. "/);
  assert.match(body, /"type":"token","text":"E outra\."/);
  assert.match(
    body,
    /"type":"sentence","index":0,"text":"Esta é uma pergunta suficientemente longa\."/,
  );
  assert.match(body, /"type":"sentence","index":1,"text":"E outra\."/);
  assert.match(body, /"type":"done"/);

  assert.equal(received.kickoff, true);
  assert.equal(received.language, "portuguese");
  assert.equal(received.mode, "interview");
  assert.deepEqual(received.messages, []);
});

test("POST /api/chat aceita o modo aprendizado", async (t) => {
  let received = null;

  const base = await startApp(t, async function* (input) {
    received = input;
    yield "Vamos aprender isso com um exemplo. ";
  });

  const response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [], kickoff: true, mode: "learning" }),
  });

  const body = await response.text();
  assert.match(body, /"type":"done"/);
  assert.equal(received.mode, "learning");
});

test("modo inválido responde 400", async (t) => {
  const base = await startApp(t, async function* () {
    yield "não deveria rodar";
  });

  const response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [], kickoff: true, mode: "palestra" }),
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "invalid_body");
});

test("idioma inválido responde 400", async (t) => {
  const base = await startApp(t, async function* () {
    yield "não deveria rodar";
  });

  const response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [], kickoff: true, language: "klingon" }),
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "invalid_body");
});

test("erro do provider vira evento error no SSE", async (t) => {
  const base = await startApp(t, async function* () {
    throw new Error("boom");
  });

  const response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "oi" }],
      kickoff: false,
    }),
  });

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /"type":"error","message":"Falha ao gerar a resposta\."/);
});

test("corpo inválido responde 400 em JSON", async (t) => {
  const base = await startApp(t, async function* () {
    yield "não deveria rodar";
  });

  const response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: "não é um array" }),
  });

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, "invalid_body");
});
