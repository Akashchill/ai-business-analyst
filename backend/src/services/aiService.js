// Lightweight suggestion helper used by analytics route
import { z } from 'zod';
import { getDatabaseSchema } from '../config/database.js';
import { generateAgentObject } from '../config/ai.js';

const suggestionsSchema = z.object({
  questions: z.array(z.string()).min(1).max(8),
});

/** Instant defaults — never block page load on schema + LLM. */
export const DEFAULT_SUGGESTIONS = [
  'How many users are there?',
  'What is total revenue this month?',
  'Show top 10 customers by spend',
  'What are monthly sales trends this year?',
  'Which products have the highest margins?',
  'How many orders were placed last week?',
];

let cache = null, cacheTs = 0;
let refreshInFlight = false;

/**
 * Returns suggestions immediately (cache or static defaults).
 * Optionally kicks off a background AI refresh when cache is cold/stale.
 */
export async function getSuggestedQuestions({ refresh = false } = {}) {
  if (cache && Date.now() - cacheTs < 10 * 60_000) {
    return cache;
  }

  // Cold / stale: return defaults instantly; refresh AI list in background
  if (refresh || !cache) {
    refreshSuggestionsInBackground();
  }
  return cache || DEFAULT_SUGGESTIONS;
}

async function refreshSuggestionsInBackground() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    const schema = await getDatabaseSchema('postgresql');
    const tables = Object.keys(schema).join(', ') || 'users, orders, products';
    const { questions } = await generateAgentObject({
      prompt: `Database tables: ${tables}. Suggest 6 useful business analytics questions a user could ask.`,
      schema: suggestionsSchema,
      maxOutputTokens: 400,
    });
    if (questions?.length) {
      cache = questions;
      cacheTs = Date.now();
    }
  } catch {
    // Keep defaults / previous cache on failure
    if (!cache) {
      cache = DEFAULT_SUGGESTIONS;
      cacheTs = Date.now();
    }
  } finally {
    refreshInFlight = false;
  }
}

/** Pre-warm suggestion cache on server startup (non-blocking). */
export function prewarmSuggestionCache() {
  refreshSuggestionsInBackground();
}
