import assert from "node:assert/strict";
import test from "node:test";
import { buildSummaryPrompt } from "../src/sessions/summary.js";
import {
  parseSummaryJson,
  slugifyConcept,
  validateSummary,
} from "../src/sessions/summary-schema.js";

test("normaliza resumo, funde conceitos repetidos e gera slugs", () => {
  const summary = validateSummary({
    title: "  Clean   Architecture ",
    overview: "",
    sections: [
      {
        title: "Clean Architecture",
        summary: "O núcleo não depende de banco, framework ou tela.",
        keyPoints: ["O núcleo fica isolado.", "O núcleo fica isolado.", "As dependências apontam para dentro."],
      },
      {
        title: "Clean Architecture",
        summary:
          "Uma explicação mais longa sobre separar regras de negócio das ferramentas externas.",
        keyPoints: ["Adaptadores ficam na borda."],
      },
      {
        title: "Inversão de Dependência",
        summary: "O módulo de alto nível define a abstração.",
      },
    ],
  });

  assert.equal(summary.title, "Clean Architecture");
  assert.equal(summary.sections.length, 2);
  assert.equal(summary.sections[0].conceptKey, "clean-architecture");
  assert.deepEqual(summary.sections[0].keyPoints, [
    "O núcleo fica isolado.",
    "As dependências apontam para dentro.",
    "Adaptadores ficam na borda.",
  ]);
  assert.deepEqual(summary.conceptIndex, [
    "clean-architecture",
    "inversao-de-dependencia",
  ]);
  assert.match(summary.overview, /separar regras/);
});

test("limita o número de seções e remove duplicatas dos pontos", () => {
  const sections = Array.from({ length: 9 }, (_, index) => ({
    title: `Conceito ${index}`,
    summary: `Explicação do conceito ${index}.`,
    keyPoints: ["Ponto A", "Ponto A", "Ponto B"],
  }));

  const summary = validateSummary({ title: "Sessão", sections });
  assert.equal(summary.sections.length, 6);
  assert.deepEqual(summary.sections[0].keyPoints, ["Ponto A", "Ponto B"]);
});

test("rejeita resumo sem seções", () => {
  assert.throws(() => validateSummary({ title: "Vazio", sections: [] }));
});

test("extrai JSON mesmo com cercas de markdown", () => {
  const parsed = parseSummaryJson(
    '```json\n{"title":"T","sections":[{"title":"X","summary":"Y"}]}\n```',
  );
  assert.equal(parsed.title, "T");
  assert.equal(parsed.sections[0].title, "X");
});

test("prompt do resumo inclui idioma e transcrição numerada", () => {
  const prompt = buildSummaryPrompt({
    mode: "learning",
    language: "portuguese",
    messages: [
      { role: "assistant", content: "O que você quer aprender?" },
      { role: "user", content: "Quero entender Clean Architecture." },
    ],
  });

  assert.match(prompt.user, /Idioma da conversa: Portuguese/);
  assert.match(prompt.user, /Modo: aprendizagem/);
  assert.match(prompt.user, /\[0\] Tutor: O que você quer aprender\?/);
  assert.match(prompt.user, /\[1\] Aluno: Quero entender Clean Architecture\./);
  assert.match(prompt.system, /SOMENTE com um objeto JSON válido/);
});

test("slug de conceito remove acentos e normaliza separadores", () => {
  assert.equal(
    slugifyConcept("Inversão de Dependência & Clean Architecture"),
    "inversao-de-dependencia-clean-architecture",
  );
});
