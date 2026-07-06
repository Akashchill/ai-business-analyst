// Lightweight suggestion helper used by analytics route
import { z } from 'zod';
import { getDatabaseSchema } from '../config/database.js';
import { generateAgentObject } from '../config/ai.js';

const suggestionsSchema = z.object({
  questions: z.array(z.string()).min(1).max(8),
});

let cache = null, cacheTs = 0;

export async function getSuggestedQuestions() {
  try {
    if (!cache || Date.now() - cacheTs > 10 * 60_000) {
      const schema = await getDatabaseSchema('postgresql');
      const tables = Object.keys(schema).join(', ') || 'users, orders, products';
      const { questions } = await generateAgentObject({
        prompt: `Database tables: ${tables}. Suggest 6 useful business analytics questions a user could ask.`,
        schema: suggestionsSchema,
        maxOutputTokens: 400,
      });
      cache = questions;
      cacheTs = Date.now();
    }
    return cache;
  } catch {
    return [];
  }
}
