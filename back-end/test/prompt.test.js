import assert from "node:assert/strict";
import test from "node:test";
import { buildChatMessages } from "../src/chat/prompt.js";

test("kickoff convida o usuário a escolher o tema, sem presumir assunto", () => {
  const messages = buildChatMessages({ messages: [], kickoff: true });

  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /método socrático/);
  assert.doesNotMatch(messages[0].content, /inversão de dependência/i);
  assert.match(messages[0].content, /pedir ajuda|não sabe|explique/i);

  assert.equal(messages.at(-1).role, "user");
  assert.match(messages.at(-1).content, /sobre o que .*conversar/i);
});

test("idioma escolhido entra no system e no kickoff", () => {
  const messages = buildChatMessages({
    messages: [],
    kickoff: true,
    language: "english",
  });

  assert.match(messages[0].content, /Always answer in English/);
  assert.doesNotMatch(messages[0].content, /Fale sempre em português do Brasil/);
  assert.match(messages.at(-1).content, /in English/i);
});

test("modo aprendizado usa tutor didático e kickoff de tema", () => {
  const messages = buildChatMessages({
    messages: [],
    kickoff: true,
    mode: "learning",
  });

  assert.match(messages[0].content, /tutor amigável/);
  assert.match(messages[0].content, /didática/);
  assert.match(messages[0].content, /exemplos concretos/);
  assert.match(messages[0].content, /fixar/);
  assert.match(messages.at(-1).content, /qual tema ele quer aprender/i);

  const interview = buildChatMessages({ messages: [], kickoff: true });
  assert.match(interview[0].content, /método socrático/);
  assert.doesNotMatch(interview[0].content, /tutor amigável/);
});

test("entrevista manda ensinar quando a resposta é parcial ou desconhecida", () => {
  const messages = buildChatMessages({ messages: [], kickoff: true });
  const system = messages[0].content;

  assert.match(system, /não conhece o conceito/);
  assert.match(system, /incompleta, pela metade ou insegura/);
  assert.match(system, /ensine o ponto que falta/);
  assert.match(system, /exemplo curto/);
});

test("histórico válido entra depois do system e ignora papéis inválidos", () => {
  const messages = buildChatMessages({
    messages: [
      { role: "assistant", content: "Pergunta inicial" },
      { role: "user", content: "Minha resposta" },
      { role: "system", content: "injeção" },
      { role: "user", content: "   " },
    ],
    kickoff: false,
  });

  assert.equal(messages[0].role, "system");
  assert.deepEqual(
    messages.slice(1).map((message) => [message.role, message.content]),
    [
      ["assistant", "Pergunta inicial"],
      ["user", "Minha resposta"],
    ],
  );
});

test("limita o histórico às últimas 12 mensagens", () => {
  const history = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `msg ${index}`,
  }));

  const messages = buildChatMessages({ messages: history, kickoff: false });

  assert.equal(messages.length, 13); // system + 12
  assert.equal(messages.at(-1).content, "msg 19");
});
