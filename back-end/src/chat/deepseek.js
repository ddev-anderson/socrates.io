import OpenAI from "openai";
import { config } from "../config.js";
import { buildChatMessages } from "./prompt.js";

let client = null;

function getClient() {
  if (!config.hasDeepSeekKey) {
    const error = new Error("DEEPSEEK_API_KEY não configurada");
    error.code = "deepseek_not_configured";
    throw error;
  }

  if (!client) {
    client = new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: config.deepseekBaseUrl,
      timeout: 60_000,
      maxRetries: 0,
    });
  }

  return client;
}

export async function* streamChat({ messages, kickoff, language, mode, signal }) {
  const openai = getClient();
  const chatMessages = buildChatMessages({ messages, kickoff, language, mode });

  const stream = await openai.chat.completions.create(
    {
      model: config.deepseekModel,
      messages: chatMessages,
      stream: true,
      temperature: 0.7,
      max_tokens: 180,
    },
    { signal },
  );

  for await (const chunk of stream) {
    const token = chunk.choices?.[0]?.delta?.content;
    if (token) yield token;
  }
}
