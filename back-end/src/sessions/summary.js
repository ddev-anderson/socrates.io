import { getDeepSeekClient } from "../chat/deepseek.js";
import { resolveMode } from "../chat/modes.js";
import { config } from "../config.js";
import { DEFAULT_LANGUAGE, resolveLanguage } from "../languages.js";
import {
  SUMMARY_PROMPT_VERSION,
  SUMMARY_SCHEMA_VERSION,
  parseSummaryJson,
  validateSummary,
} from "./summary-schema.js";

const MAX_TRANSCRIPT_CHARS = 60_000;

const SYSTEM_PROMPT = `Você é um tutor especialista em criar material de fixação a partir de conversas de aprendizagem.
Sua tarefa é transformar a conversa em um resumo de estudo organizado por conceito, que o aluno possa reler depois e lembrar do conteúdo.
Regras:
- Baseie-se apenas no que foi discutido. Não invente fatos, fontes ou tópicos que não apareçam na conversa.
- Se um exemplo padrão ajudar a fixar, use-o, mas mantenha-o coerente com o que foi explicado.
- Escreva no idioma da conversa.
- Cada seção deve ser autossuficiente: nada de "como vimos acima" ou "conforme o tutor disse".
- Resuma o que o aluno aprendeu, não as perguntas do tutor.
- Use de 2 a 6 seções, uma por conceito principal. Se a conversa for curta, uma seção basta.
- conceptKey deve ser um slug em minúsculas, sem acentos, com hífens (ex.: clean-architecture).
- Responda SOMENTE com um objeto JSON válido, sem markdown e sem texto fora do JSON.`;

const SUMMARY_SHAPE = `{
  "title": "título curto da sessão",
  "overview": "um parágrafo curto resumindo o que foi aprendido",
  "sections": [
    {
      "conceptKey": "slug-do-conceito",
      "title": "nome do conceito",
      "summary": "explicação em 3 a 5 frases, autossuficiente",
      "keyPoints": ["ponto-chave 1", "ponto-chave 2", "ponto-chave 3"],
      "example": "um exemplo concreto",
      "analogy": "uma analogia curta (pode ser vazia)",
      "commonMistake": "um erro comum (pode ser vazio)",
      "checkQuestion": { "question": "pergunta de checagem", "answer": "resposta" },
      "flashcards": [{ "front": "pergunta", "back": "resposta" }],
      "turns": [2, 4]
    }
  ],
  "openQuestions": ["dúvida que ficou em aberto"],
  "nextSteps": ["o que estudar ou praticar depois"],
  "conceptIndex": ["slug-do-conceito"]
}`;

export function buildTranscript(messages) {
  const lines = [];
  let total = 0;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const role = message.role === "user" ? "Aluno" : "Tutor";
    const line = `[${index}] ${role}: ${message.content}`;
    if (total + line.length > MAX_TRANSCRIPT_CHARS) break;
    lines.push(line);
    total += line.length + 1;
  }

  return lines.join("\n");
}

export function buildSummaryPrompt({ messages, mode, language }) {
  const languageName =
    resolveLanguage(language)?.name ?? resolveLanguage(DEFAULT_LANGUAGE)?.name;
  const modeLabel =
    resolveMode(mode)?.id === "learning" ? "aprendizagem" : "entrevista";
  const transcript = buildTranscript(messages);

  const user = `Idioma da conversa: ${languageName}
Modo: ${modeLabel}
Transcrição:
${transcript}

Gere o resumo de fixação no formato JSON abaixo:
${SUMMARY_SHAPE}`;

  return { system: SYSTEM_PROMPT, user };
}

async function callModel({ system, user, signal }) {
  const client = getDeepSeekClient();
  const response = await client.chat.completions.create(
    {
      model: config.deepseekModel,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
      max_tokens: 2200,
      response_format: { type: "json_object" },
    },
    { signal },
  );

  const content = response.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("o modelo não retornou conteúdo");
  }
  return content;
}

function parseAndValidate(content) {
  return validateSummary(parseSummaryJson(content));
}

export async function generateSummary({ messages, mode, language, signal }) {
  const { system, user } = buildSummaryPrompt({ messages, mode, language });

  const first = await callModel({ system, user, signal });

  try {
    return parseAndValidate(first);
  } catch (error) {
    const repair = await callModel({
      system,
      user: `${user}

A resposta anterior não passou na validação (${error.message}).
Resposta anterior (trecho):
${first.slice(0, 8000)}

Corrija o JSON e responda SOMENTE com o objeto válido.`,
      signal,
    });

    return parseAndValidate(repair);
  }
}

function safeErrorCode(error) {
  if (error?.code === "deepseek_not_configured") {
    return "deepseek_not_configured";
  }
  if (error?.name === "AbortError" || error?.code === "ABORT_ERR") {
    return "generation_timeout";
  }
  if (error?.name === "ZodError" || /resumo (inválido|sem seções)/.test(error?.message ?? "")) {
    return "invalid_summary";
  }
  if (error?.status === 401 || error?.status === 402 || error?.status === 429) {
    return `deepseek_${error.status}`;
  }
  return "summary_failed";
}

export async function runSummaryGeneration({
  db,
  session,
  summaryId,
  logger,
}) {
  const summaries = db.collection("summaries");

  try {
    const summary = await generateSummary({
      messages: session.messages ?? [],
      mode: session.mode,
      language: session.language,
    });

    await summaries.updateOne(
      { _id: summaryId, ownerId: session.ownerId },
      {
        $set: {
          status: "ready",
          title: summary.title,
          overview: summary.overview,
          sections: summary.sections,
          openQuestions: summary.openQuestions,
          nextSteps: summary.nextSteps,
          conceptIndex: summary.conceptIndex,
          language: session.language,
          mode: session.mode,
          turnCount: session.turnCount ?? 0,
          sessionStartedAt: session.startedAt ?? null,
          model: config.deepseekModel,
          promptVersion: SUMMARY_PROMPT_VERSION,
          schemaVersion: SUMMARY_SCHEMA_VERSION,
          error: null,
          updatedAt: new Date(),
        },
      },
    );
  } catch (error) {
    const code = safeErrorCode(error);
    logger?.error(
      {
        name: error?.name ?? null,
        status: error?.status ?? null,
        code: error?.code ?? null,
        message: error?.message ?? "erro desconhecido",
        sessionId: session._id?.toString?.() ?? null,
      },
      "falha ao gerar resumo da sessão",
    );

    await summaries
      .updateOne(
        { _id: summaryId, ownerId: session.ownerId },
        {
          $set: {
            status: "failed",
            error: code,
            updatedAt: new Date(),
          },
        },
      )
      .catch(() => {});
  }
}
