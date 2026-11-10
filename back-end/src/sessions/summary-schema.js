import { z } from "zod";

export const SUMMARY_PROMPT_VERSION = "learning-summary-v1";
export const SUMMARY_SCHEMA_VERSION = 1;

const MAX_SECTIONS = 6;

function cleanText(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanList(value, maxItems, maxChars) {
  if (!Array.isArray(value)) return [];
  const items = [];
  for (const entry of value) {
    const text = cleanText(entry, maxChars);
    if (!text) continue;
    if (!items.includes(text)) items.push(text);
    if (items.length >= maxItems) break;
  }
  return items;
}

export function slugifyConcept(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function normalizeFlashcard(raw) {
  if (!raw || typeof raw !== "object") return null;
  const front = cleanText(raw.front ?? raw.question, 300);
  const back = cleanText(raw.back ?? raw.answer, 600);
  if (!front || !back) return null;
  return { front, back };
}

function normalizeCheckQuestion(raw) {
  if (!raw || typeof raw !== "object") return null;
  const question = cleanText(raw.question, 400);
  const answer = cleanText(raw.answer, 800);
  if (!question || !answer) return null;
  return { question, answer };
}

function normalizeSection(raw, index) {
  if (!raw || typeof raw !== "object") return null;

  const title = cleanText(raw.title, 120);
  const conceptKey = slugifyConcept(raw.conceptKey || raw.key || title);
  const keyPoints = cleanList(raw.keyPoints ?? raw.points, 6, 300);
  let summary = cleanText(raw.summary ?? raw.explanation, 1200);
  if (!summary) summary = keyPoints.join(" ");
  if (!summary) return null;

  const turns = Array.isArray(raw.turns)
    ? raw.turns
        .map((turn) => Number(turn))
        .filter((turn) => Number.isInteger(turn) && turn >= 0 && turn <= 9999)
        .slice(0, 20)
    : [];

  const flashcards = Array.isArray(raw.flashcards)
    ? raw.flashcards.map(normalizeFlashcard).filter(Boolean).slice(0, 4)
    : [];

  return {
    conceptKey: conceptKey || `concept-${index + 1}`,
    title: title || conceptKey || `Conceito ${index + 1}`,
    summary,
    keyPoints,
    example: cleanText(raw.example, 800),
    analogy: cleanText(raw.analogy, 600),
    commonMistake: cleanText(raw.commonMistake ?? raw.mistake, 600),
    checkQuestion: normalizeCheckQuestion(raw.checkQuestion),
    flashcards,
    turns,
  };
}

function mergeSections(sections) {
  const byKey = new Map();

  for (const section of sections) {
    const existing = byKey.get(section.conceptKey);
    if (!existing) {
      byKey.set(section.conceptKey, section);
      continue;
    }

    // O modelo às vezes repete o mesmo conceito em seções diferentes; funde
    // os pontos sem duplicar e mantém a explicação mais longa.
    for (const point of section.keyPoints) {
      if (!existing.keyPoints.includes(point)) existing.keyPoints.push(point);
    }
    existing.keyPoints = existing.keyPoints.slice(0, 6);
    existing.flashcards = existing.flashcards.concat(section.flashcards).slice(0, 4);
    existing.turns = [...new Set([...existing.turns, ...section.turns])].slice(0, 20);
    if (section.summary.length > existing.summary.length) {
      existing.summary = section.summary;
    }
    if (!existing.example && section.example) existing.example = section.example;
    if (!existing.analogy && section.analogy) existing.analogy = section.analogy;
    if (!existing.commonMistake && section.commonMistake) {
      existing.commonMistake = section.commonMistake;
    }
    if (!existing.checkQuestion && section.checkQuestion) {
      existing.checkQuestion = section.checkQuestion;
    }
  }

  return [...byKey.values()].slice(0, MAX_SECTIONS);
}

export function normalizeSummary(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("resumo inválido");
  }

  const rawSections = Array.isArray(raw.sections)
    ? raw.sections
    : Array.isArray(raw.concepts)
      ? raw.concepts
      : [];

  const sections = mergeSections(
    rawSections
      .map((section, index) => normalizeSection(section, index))
      .filter(Boolean),
  );

  if (!sections.length) throw new Error("resumo sem seções");

  const overviewFallback = sections
    .map((section) => section.summary)
    .join(" ")
    .slice(0, 900);

  return {
    title: cleanText(raw.title, 140) || "Resumo da conversa",
    overview: cleanText(raw.overview, 900) || overviewFallback,
    sections,
    openQuestions: cleanList(raw.openQuestions, 6, 400),
    nextSteps: cleanList(raw.nextSteps, 6, 400),
    conceptIndex: sections.map((section) => section.conceptKey),
  };
}

export const summarySchema = z.object({
  title: z.string().min(1).max(140),
  overview: z.string().min(1).max(900),
  sections: z
    .array(
      z.object({
        conceptKey: z.string().min(1).max(64),
        title: z.string().min(1).max(120),
        summary: z.string().min(1).max(1200),
        keyPoints: z.array(z.string().max(300)).max(6),
        example: z.string().max(800),
        analogy: z.string().max(600),
        commonMistake: z.string().max(600),
        checkQuestion: z
          .object({
            question: z.string().max(400),
            answer: z.string().max(800),
          })
          .nullable(),
        flashcards: z
          .array(
            z.object({
              front: z.string().max(300),
              back: z.string().max(600),
            }),
          )
          .max(4),
        turns: z.array(z.number().int()).max(20),
      }),
    )
    .min(1)
    .max(MAX_SECTIONS),
  openQuestions: z.array(z.string().max(400)).max(6),
  nextSteps: z.array(z.string().max(400)).max(6),
  conceptIndex: z.array(z.string().max(64)).min(1).max(MAX_SECTIONS),
});

export function parseSummaryJson(text) {
  let value = String(text ?? "").trim();
  if (!value) throw new Error("resposta vazia do modelo");

  value = value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("resposta do modelo sem JSON");
  }

  return JSON.parse(value.slice(start, end + 1));
}

export function validateSummary(raw) {
  return summarySchema.parse(normalizeSummary(raw));
}
