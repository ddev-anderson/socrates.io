import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";

async function withApp(t) {
  const app = await buildApp({ logger: false });
  t.after(async () => {
    await app.close();
  });
  return app;
}

test("GET /api/health descreve o estado do orquestrador", async (t) => {
  const app = await withApp(t);

  const response = await app.inject({ method: "GET", url: "/api/health" });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"], /application\/json/);

  const body = response.json();
  assert.equal(body.service, "socrates-backend");
  assert.equal(body.version, "0.1.0");
  assert.equal(typeof body.ok, "boolean");
  assert.equal(body.chat, body.ok ? "live" : "pending");
  assert.equal(body.tts, "mock");
  assert.equal(typeof body.deepseek, "string");
});

test("serve o front-end na raiz", async (t) => {
  const app = await withApp(t);

  const response = await app.inject({ method: "GET", url: "/" });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"], /text\/html/);
  assert.match(response.body, /socrates --interview/);
  assert.match(response.body, /\.\/style\/styles\.css/);
});

test("serve o CSS e a fonte Inter", async (t) => {
  const app = await withApp(t);

  const css = await app.inject({ method: "GET", url: "/style/styles.css" });
  assert.equal(css.statusCode, 200);
  assert.match(css.headers["content-type"], /text\/css/);

  const font = await app.inject({
    method: "GET",
    url: "/fonts/InterVariable.woff2",
  });
  assert.equal(font.statusCode, 200);
  assert.match(font.headers["content-type"], /font\/woff2/);
});

test("API desconhecida responde JSON 404", async (t) => {
  const app = await withApp(t);

  const response = await app.inject({ method: "GET", url: "/api/nao-existe" });

  assert.equal(response.statusCode, 404);
  assert.match(response.headers["content-type"], /application\/json/);
  assert.equal(response.json().error, "not_found");
});
