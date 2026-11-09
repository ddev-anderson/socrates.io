import assert from "node:assert/strict";
import test from "node:test";
import {
  createSentenceSplitter,
  sanitizeForSpeech,
} from "../src/chat/splitter.js";

test("sanitiza markdown, links, código e emojis", () => {
  const text = sanitizeForSpeech(
    "**Olá** [mundo](https://exemplo.com) 🙂\n\n```js\nconst x = 1;\n```",
  );

  assert.equal(text, "Olá mundo");
});

test("remove marcadores de ênfase e mantém texto falável", () => {
  const text = sanitizeForSpeech("Use `constructor` e _não_ faça # isso.");
  assert.equal(text, "Use constructor e não faça isso.");
});

test("emite sentença ao encontrar pontuação e faz flush do restante", () => {
  const splitter = createSentenceSplitter();

  assert.deepEqual(splitter.push("Esta é uma pergunta suficientemente longa. "), [
    { index: 0, text: "Esta é uma pergunta suficientemente longa." },
  ]);
  assert.deepEqual(splitter.push("E outra"), []);
  assert.deepEqual(splitter.flush(), [{ index: 1, text: "E outra" }]);
});

test("não corta em abreviações nem em decimais", () => {
  const splitter = createSentenceSplitter({ firstMinChars: 1 });

  assert.deepEqual(splitter.push("O Sr. Silva chegou às 3.5 horas. "), [
    { index: 0, text: "O Sr. Silva chegou às 3.5 horas." },
  ]);
});

test("reconhece pontuação CJK sem espaços", () => {
  const splitter = createSentenceSplitter({ firstMinChars: 4, minChars: 4 });

  assert.deepEqual(splitter.push("こんにちは。今日はいい天気ですね。"), [
    { index: 0, text: "こんにちは。" },
    { index: 1, text: "今日はいい天気ですね。" },
  ]);
});

test("flush entrega texto sem pontuação final", () => {
  const splitter = createSentenceSplitter();

  splitter.push("Sem pontuação final");
  assert.deepEqual(splitter.flush(), [
    { index: 0, text: "Sem pontuação final" },
  ]);
});
