import { MongoClient } from "mongodb";
import { config } from "./config.js";

// Conexão preguiçosa: o chat e o TTS continuam funcionando mesmo sem MongoDB.
// As rotas de sessão/resumo chamam getDb() e recebem um erro 503 se o banco
// não estiver disponível.
let client = null;
let dbPromise = null;
let indexesPromise = null;

async function ensureIndexes(db) {
  if (!indexesPromise) {
    indexesPromise = Promise.all([
      db.collection("sessions").createIndex({ ownerId: 1, startedAt: -1 }),
      db
        .collection("summaries")
        .createIndex({ sessionId: 1 }, { unique: true }),
      db.collection("summaries").createIndex({ ownerId: 1, createdAt: -1 }),
    ]).catch((error) => {
      indexesPromise = null;
      throw error;
    });
  }
  return indexesPromise;
}

export async function getDb() {
  if (!dbPromise) {
    const nextClient = new MongoClient(config.mongoUri, {
      serverSelectionTimeoutMS: 1500,
      connectTimeoutMS: 2000,
    });
    client = nextClient;

    dbPromise = nextClient
      .connect()
      .then(async () => {
        const db = nextClient.db(config.mongoDb);
        await ensureIndexes(db);
        return db;
      })
      .catch((error) => {
        dbPromise = null;
        indexesPromise = null;
        if (client === nextClient) client = null;
        nextClient.close().catch(() => {});
        throw error;
      });
  }

  return dbPromise;
}

export async function closeDb() {
  const current = client;
  client = null;
  dbPromise = null;
  indexesPromise = null;

  if (!current) return;
  await current.close().catch(() => {});
}
