/**
 * Vercel AI SDK — single module for all LLM + embedding calls.
 *
 * Chat (.env):
 *   AI_PROVIDER=google          # google | anthropic | openai
 *   AI_MODEL=gemini-2.5-flash
 *   GEMINI_API_KEY=...
 *
 * Embeddings (.env):
 *   AI_EMBED_MODEL=gemini-embedding-001
 *   AI_EMBED_DIMENSIONS=1536      # pgvector HNSW max is 2000
 */
import { generateText, generateObject, streamText, streamObject, embed, embedMany } from 'ai';
import { createGoogle } from '@ai-sdk/google';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import dotenv from 'dotenv';
import { secretEnv } from './secrets.js';

dotenv.config();

const PROVIDER = (process.env.AI_PROVIDER || 'google').toLowerCase();
const MODEL_ID = process.env.AI_MODEL || 'gemini-2.5-flash';
const EMBED_MODEL = process.env.AI_EMBED_MODEL || 'gemini-embedding-001';
const EMBED_DIMENSIONS = parseInt(process.env.AI_EMBED_DIMENSIONS || '1536', 10);

function resolveGeminiApiKey() {
  return (
    secretEnv('GEMINI_API_KEY') ||
    secretEnv('GOOGLE_GENERATIVE_AI_API_KEY') ||
    ''
  );
}

const googleProvider = createGoogle({
  apiKey: resolveGeminiApiKey(),
});

const chatProviders = {
  google: googleProvider,
  anthropic: createAnthropic({ apiKey: secretEnv('ANTHROPIC_API_KEY') }),
  openai: createOpenAI({ apiKey: secretEnv('OPENAI_API_KEY') }),
};

export function getChatModel() {
  const factory = chatProviders[PROVIDER];
  if (!factory) {
    throw new Error(`Unknown AI_PROVIDER "${PROVIDER}". Use google, anthropic, or openai.`);
  }
  return factory(MODEL_ID);
}

export function getEmbeddingModel() {
  assertEmbeddingConfigured();
  return googleProvider.embedding(EMBED_MODEL);
}

function googleChatOptions() {
  return {
    google: {
      // 2.5 Flash thinking tokens steal the JSON budget and break generateObject.
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
}

function googleEmbedOptions(taskType) {
  return {
    google: {
      outputDimensionality: EMBED_DIMENSIONS,
      taskType,
    },
  };
}

function normalizeL2(values) {
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return values;
  return values.map(v => v / norm);
}

function assertKeyForProvider(provider) {
  const keys = {
    google: resolveGeminiApiKey(),
    anthropic: secretEnv('ANTHROPIC_API_KEY'),
    openai: secretEnv('OPENAI_API_KEY'),
  };
  const key = keys[provider]?.trim();
  if (!key || /your-key|your-api-key/i.test(key) || key.startsWith('{')) {
    const hints = {
      google: 'Set GEMINI_API_KEY in backend/.env or ECS Secrets (https://aistudio.google.com/apikey).',
      anthropic: 'Set ANTHROPIC_API_KEY in backend/.env (https://console.anthropic.com/settings/keys).',
      openai: 'Set OPENAI_API_KEY in backend/.env (https://platform.openai.com/api-keys).',
    };
    throw new Error(
      `AI provider "${provider}" is not configured. ${hints[provider]} ` +
      `Restart the server after updating .env.`
    );
  }
}

export function assertAiConfigured() {
  assertKeyForProvider(PROVIDER);
}

export function assertEmbeddingConfigured() {
  assertKeyForProvider('google');
}

/** Plain-text generation. Use for answers that are not structured JSON. */
export async function generateAgentText({ system, prompt, messages, maxOutputTokens = 1024 }) {
  assertAiConfigured();

  const { text } = await generateText({
    model: getChatModel(),
    system,
    ...(messages ? { messages } : { prompt }),
    maxOutputTokens,
    providerOptions: googleChatOptions(),
  });

  return text;
}

/** Stream plain-text tokens; optional onChunk called for each delta. */
export async function streamAgentText({ system, prompt, messages, maxOutputTokens = 1024, onChunk }) {
  assertAiConfigured();

  const result = streamText({
    model: getChatModel(),
    system,
    ...(messages ? { messages } : { prompt }),
    maxOutputTokens,
    providerOptions: googleChatOptions(),
  });

  let text = '';
  for await (const chunk of result.textStream) {
    text += chunk;
    if (onChunk) onChunk(chunk);
  }
  return text;
}

/** Stream structured JSON; onPartial called with each partial object update. */
export async function streamAgentObject({ system, prompt, messages, schema, maxOutputTokens = 1024, onPartial }) {
  assertAiConfigured();

  const result = streamObject({
    model: getChatModel(),
    schema,
    system,
    ...(messages ? { messages } : { prompt }),
    maxOutputTokens,
    providerOptions: googleChatOptions(),
  });

  if (onPartial) {
    for await (const partial of result.partialObjectStream) {
      onPartial(partial);
    }
  }

  const { object } = await result;
  return object;
}

/** Structured JSON via AI SDK generateObject + Zod schema. */
export async function generateAgentObject({ system, prompt, messages, schema, maxOutputTokens = 1024 }) {
  assertAiConfigured();

  const { object } = await generateObject({
    model: getChatModel(),
    schema,
    system,
    ...(messages ? { messages } : { prompt }),
    maxOutputTokens,
    providerOptions: googleChatOptions(),
  });

  return object;
}

/**
 * Embed a single string (RAG document chunk or query).
 * @param {'RETRIEVAL_DOCUMENT'|'RETRIEVAL_QUERY'} taskType
 */
export async function embedText(text, taskType = 'RETRIEVAL_DOCUMENT') {
  const { embedding } = await embed({
    model: getEmbeddingModel(),
    value: text,
    providerOptions: googleEmbedOptions(taskType),
  });

  if (embedding.length !== EMBED_DIMENSIONS) {
    throw new Error(`Unexpected embedding shape: got ${embedding.length} dims, expected ${EMBED_DIMENSIONS}`);
  }

  return normalizeL2(embedding);
}

/**
 * Embed many strings in one AI SDK call (auto-chunked by the SDK).
 */
export async function embedBatch(texts, taskType = 'RETRIEVAL_DOCUMENT') {
  if (!texts.length) return [];

  const { embeddings } = await embedMany({
    model: getEmbeddingModel(),
    values: texts,
    providerOptions: googleEmbedOptions(taskType),
    maxParallelCalls: 5,
  });

  return embeddings.map((vec) => {
    if (vec.length !== EMBED_DIMENSIONS) {
      throw new Error(`Unexpected embedding shape: got ${vec.length} dims, expected ${EMBED_DIMENSIONS}`);
    }
    return normalizeL2(vec);
  });
}

/** pgvector literal: '[0.1,-0.2,...]' */
export function toVectorLiteral(embedding) {
  return `[${embedding.join(',')}]`;
}

// Back-compat alias
export const getAiModel = getChatModel;

export {
  PROVIDER as AI_PROVIDER,
  MODEL_ID as AI_MODEL,
  EMBED_MODEL,
  EMBED_DIMENSIONS,
};
