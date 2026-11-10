import { ObjectId } from "mongodb";
import { DEFAULT_MODE, resolveMode } from "../chat/modes.js";
import { config } from "../config.js";
import { getDb } from "../db.js";
import { DEFAULT_LANGUAGE, resolveLanguage } from "../languages.js";
import { runSummaryGeneration } from "../sessions/summary.js";
import {
  SUMMARY_PROMPT_VERSION,
  SUMMARY_SCHEMA_VERSION,
} from "../sessions/summary-schema.js";

const MAX_MESSAGES = 200;
const MAX_MESSAGE_CHARS = 8000;
const MAX_TRANSCRIPT_CHARS = 200_000;
const STALE_GENERATION_MS = 10 * 60 * 1000;

function parseSessionId(value) {
  if (typeof value !== "string" || !ObjectId.isValid(value)) return null;
  return new ObjectId(value);
}

function parseSessionBody(body) {
  const requestedMode = typeof body?.mode === "string" ? body.mode : "";
  const requestedLanguage =
    typeof body?.language === "string" ? body.language : "";
  const mode =
    resolveMode(requestedMode) ?? resolveMode(DEFAULT_MODE);
  const language =
    resolveLanguage(requestedLanguage) ??
    resolveLanguage(DEFAULT_LANGUAGE);
  const voice =
    typeof body?.voice === "string" ? body.voice.trim().slice(0, 80) : null;

  return { mode: mode.id, language: language.id, voice };
}

function parseMessages(body) {
  if (!Array.isArray(body?.messages)) {
    return { error: "messages deve ser um array" };
  }

  const messages = [];
  let total = 0;

  for (const entry of body.messages) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.role !== "user" && entry.role !== "assistant") continue;
    const content =
      typeof entry.content === "string" ? entry.content.trim() : "";
    if (!content) continue;
    if (content.length > MAX_MESSAGE_CHARS) {
      return { error: "mensagem muito longa" };
    }

    total += content.length;
    if (total > MAX_TRANSCRIPT_CHARS || messages.length >= MAX_MESSAGES) {
      return { error: "transcrição muito longa" };
    }

    messages.push({
      role: entry.role,
      content,
      turnIndex: messages.length,
      createdAt: new Date(),
    });
  }

  if (messages.length < 2) {
    return { error: "conversa curta demais para gerar resumo" };
  }

  return { messages };
}

async function database(request, reply) {
  try {
    return await getDb();
  } catch (error) {
    request.log.error(
      { message: error?.message ?? "erro desconhecido" },
      "mongodb indisponível",
    );
    reply.code(503).send({
      error: "storage_unavailable",
      message: "O banco de resumos está indisponível.",
    });
    return null;
  }
}

function publicSummary(doc) {
  return {
    id: doc._id.toString(),
    sessionId: doc.sessionId.toString(),
    version: doc.version ?? 1,
    status: doc.status ?? "ready",
    title: doc.title ?? "",
    overview: doc.overview ?? "",
    sections: doc.sections ?? [],
    openQuestions: doc.openQuestions ?? [],
    nextSteps: doc.nextSteps ?? [],
    conceptIndex: doc.conceptIndex ?? [],
    language: doc.language ?? null,
    mode: doc.mode ?? null,
    turnCount: doc.turnCount ?? 0,
    model: doc.model ?? null,
    promptVersion: doc.promptVersion ?? null,
    createdAt: doc.createdAt ?? null,
    updatedAt: doc.updatedAt ?? null,
    error: doc.error ?? null,
  };
}

export default async function sessionsRoutes(app) {
  app.post("/api/sessions", async (request, reply) => {
    const ownerId = config.ownerId;

    const db = await database(request, reply);
    if (!db) return;

    const { mode, language, voice } = parseSessionBody(request.body);
    const now = new Date();

    const { insertedId } = await db.collection("sessions").insertOne({
      ownerId,
      mode,
      language,
      voice,
      status: "active",
      startedAt: now,
      endedAt: null,
      messages: [],
      turnCount: 0,
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
    });

    return reply.code(201).send({
      sessionId: insertedId.toString(),
      startedAt: now.toISOString(),
    });
  });

  app.post("/api/sessions/:id/end", async (request, reply) => {
    const ownerId = config.ownerId;

    const sessionId = parseSessionId(request.params.id);
    if (!sessionId) return reply.code(400).send({ error: "invalid_session" });

    const parsed = parseMessages(request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "invalid_messages", message: parsed.error });
    }

    const db = await database(request, reply);
    if (!db) return;

    const sessions = db.collection("sessions");
    const summaries = db.collection("summaries");
    const session = await sessions.findOne({ _id: sessionId, ownerId });
    if (!session) return reply.code(404).send({ error: "session_not_found" });

    const now = new Date();
    const messages = parsed.messages;
    const turnCount = messages.length;

    await sessions.updateOne(
      { _id: sessionId, ownerId },
      {
        $set: {
          messages,
          turnCount,
          status: "ended",
          endedAt: now,
          updatedAt: now,
        },
      },
    );

    const existing = await summaries.findOne({ sessionId, ownerId });
    const version = (existing?.version ?? 0) + 1;

    await summaries.updateOne(
      { sessionId, ownerId },
      {
        $set: {
          status: "generating",
          error: null,
          version,
          mode: session.mode,
          language: session.language,
          turnCount,
          sessionStartedAt: session.startedAt ?? now,
          model: config.deepseekModel,
          promptVersion: SUMMARY_PROMPT_VERSION,
          schemaVersion: SUMMARY_SCHEMA_VERSION,
          updatedAt: now,
        },
        $setOnInsert: {
          createdAt: now,
          title: "",
          overview: "",
          sections: [],
          openQuestions: [],
          nextSteps: [],
          conceptIndex: [],
        },
      },
      { upsert: true },
    );

    const summaryDoc = await summaries.findOne({ sessionId, ownerId });
    if (!summaryDoc) {
      return reply.code(500).send({ error: "summary_not_created" });
    }

    void runSummaryGeneration({
      db,
      session: { ...session, messages, turnCount, endedAt: now },
      summaryId: summaryDoc._id,
      logger: request.log,
    });

    return reply.code(202).send({
      status: "generating",
      sessionId: sessionId.toString(),
      version,
    });
  });

  app.get("/api/sessions/:id/summary", async (request, reply) => {
    const ownerId = config.ownerId;

    const sessionId = parseSessionId(request.params.id);
    if (!sessionId) return reply.code(400).send({ error: "invalid_session" });

    const db = await database(request, reply);
    if (!db) return;

    const summaries = db.collection("summaries");
    const summary = await summaries.findOne({ sessionId, ownerId });
    if (!summary) return reply.code(404).send({ error: "summary_not_found" });

    if (
      summary.status === "generating" &&
      Date.now() - new Date(summary.updatedAt ?? 0).getTime() >
        STALE_GENERATION_MS
    ) {
      await summaries.updateOne(
        { _id: summary._id },
        {
          $set: {
            status: "failed",
            error: "generation_timeout",
            updatedAt: new Date(),
          },
        },
      );
      summary.status = "failed";
      summary.error = "generation_timeout";
    }

    if (summary.status === "generating") {
      return reply.code(202).send({
        status: "generating",
        sessionId: sessionId.toString(),
      });
    }

    if (summary.status === "failed") {
      return reply.code(502).send({
        status: "failed",
        error: summary.error ?? "summary_failed",
        retryable: true,
      });
    }

    return reply.send({ status: "ready", summary: publicSummary(summary) });
  });

  app.post("/api/sessions/:id/summary/retry", async (request, reply) => {
    const ownerId = config.ownerId;

    const sessionId = parseSessionId(request.params.id);
    if (!sessionId) return reply.code(400).send({ error: "invalid_session" });

    const db = await database(request, reply);
    if (!db) return;

    const session = await db.collection("sessions").findOne({
      _id: sessionId,
      ownerId,
    });
    if (!session) return reply.code(404).send({ error: "session_not_found" });
    if (!Array.isArray(session.messages) || session.messages.length < 2) {
      return reply.code(400).send({ error: "empty_session" });
    }

    const summaries = db.collection("summaries");
    const existing = await summaries.findOne({ sessionId, ownerId });
    if (!existing) return reply.code(404).send({ error: "summary_not_found" });

    if (existing.status === "generating") {
      return reply.code(202).send({
        status: "generating",
        sessionId: sessionId.toString(),
      });
    }

    const version = (existing.version ?? 0) + 1;
    await summaries.updateOne(
      { _id: existing._id },
      {
        $set: {
          status: "generating",
          error: null,
          version,
          updatedAt: new Date(),
        },
      },
    );

    void runSummaryGeneration({
      db,
      session,
      summaryId: existing._id,
      logger: request.log,
    });

    return reply.code(202).send({
      status: "generating",
      sessionId: sessionId.toString(),
      version,
    });
  });

  app.get("/api/sessions", async (request, reply) => {
    const ownerId = config.ownerId;

    const db = await database(request, reply);
    if (!db) return;

    const requested = Number(request.query?.limit);
    const limit = Number.isFinite(requested)
      ? Math.min(50, Math.max(1, Math.floor(requested)))
      : 20;

    const docs = await db
      .collection("summaries")
      .find({ ownerId })
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(limit)
      .toArray();

    return {
      sessions: docs.map((doc) => ({
        id: doc._id.toString(),
        sessionId: doc.sessionId.toString(),
        version: doc.version ?? 1,
        status: doc.status ?? "ready",
        title: doc.title ?? "",
        overview: doc.overview ?? "",
        conceptIndex: doc.conceptIndex ?? [],
        language: doc.language ?? null,
        mode: doc.mode ?? null,
        turnCount: doc.turnCount ?? 0,
        createdAt: doc.createdAt ?? null,
        updatedAt: doc.updatedAt ?? null,
        error: doc.error ?? null,
      })),
    };
  });
}
