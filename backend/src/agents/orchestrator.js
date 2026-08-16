/**
 * Agent Orchestrator
 *   0. IntentClassifier — greeting | analytics_sql | company_documents | general_business | out_of_scope
 *   1. SQL / RAG pipeline (routed by intent)
 */

import { generateAgentText, generateAgentObject, streamAgentText, streamAgentObject } from '../config/ai.js';
import { z } from 'zod';
import { getDatabaseSchema, executeQuery } from '../config/database.js';
import { retrieveRelevantChunks, getDocumentStats } from '../services/ragService.js';
import { validateSql, extractSqlFromText } from '../utils/sqlGuard.js';
import { sanitizeInsight } from '../utils/outputGuard.js';
import { buildInsightFromData, shouldUseLlmInsight, isAiQuotaError } from '../utils/insightBuilder.js';
import { pickChartByRules } from '../utils/chartRules.js';

const SQL_MAX_RETRIES = 1;

const INTENTS = ['greeting', 'analytics_sql', 'company_documents', 'general_business', 'out_of_scope'];

const intentSchema = z.object({
  intent: z.enum(['greeting', 'analytics_sql', 'company_documents', 'general_business', 'out_of_scope']),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

const plannerSchema = z.object({
  needsSQL: z.boolean(),
  needsDocuments: z.boolean(),
  sqlReason: z.string(),
  docReason: z.string().nullish(),
  complexity: z.enum(['simple', 'moderate', 'complex']),
  questionType: z.enum(['metric', 'trend', 'comparison', 'ranking', 'breakdown', 'explanation']),
  expectsRows: z.boolean().optional(),
});

const sqlSchema = z.object({
  sql: z.preprocess(
    (v) => (v == null ? '' : String(v)),
    z.string().min(1),
  ),
  explanation: z.preprocess((v) => (v == null ? '' : String(v)), z.string()),
  confidence: z.preprocess((v) => {
    const n = typeof v === 'number' ? v : parseFloat(String(v));
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
  }, z.number().min(0).max(1)),
});

const visualizationSchema = z.object({
  chartType: z.enum(['bar', 'line', 'pie', 'number', 'table']),
  chartConfig: z.object({
    xKey: z.string(),
    yKey: z.string(),
    title: z.string(),
  }).nullable(),
  reasoning: z.string().optional(),
});

const insightSchema = z.object({
  summary: z.string().describe('2-3 sentence executive summary with specific numbers'),
  keyFindings: z.preprocess((v) => (v == null ? [] : v), z.array(z.string())),
  trends: z.string().nullish(),
  recommendations: z.preprocess((v) => (v == null ? [] : v), z.array(z.string())),
  severity: z.preprocess(
    (v) => (typeof v === 'string' ? v.toLowerCase().trim() : v),
    z.enum(['positive', 'neutral', 'warning', 'critical']),
  ),
  confidence: z.preprocess(
    (v) => (v == null || v === '' ? undefined : v),
    z.coerce.number().min(0).max(1).optional(),
  ),
});

const schemaCache = { data: null, ts: 0 };
async function getCachedSchema(dbType) {
  if (schemaCache.data && Date.now() - schemaCache.ts < 5 * 60_000) return schemaCache.data;
  schemaCache.data = await getDatabaseSchema(dbType);
  schemaCache.ts = Date.now();
  return schemaCache.data;
}

function schemaToText(schema) {
  const lines = ['## Database Schema'];
  for (const [table, { columns }] of Object.entries(schema)) {
    lines.push(`\nTable: \`${table}\``);
    for (const c of columns) {
      let s = `  - ${c.name} (${c.type})`;
      if (c.isPrimaryKey) s += ' [PK]';
      if (c.isForeignKey) s += ` [FK→${c.foreignTable}.${c.foreignColumn}]`;
      lines.push(s);
    }
  }
  return lines.join('\n');
}

function finishStep(steps, idx) {
  steps[idx] = { ...steps[idx], status: 'done', duration: Date.now() - steps[idx].startedAt };
}

function emitSteps(emit, steps) {
  if (emit) emit('step', { steps: steps.map((s) => ({ ...s })) });
}

function pushRunningStep(steps, agent, emit) {
  steps.push({ agent, status: 'running', startedAt: Date.now() });
  emitSteps(emit, steps);
}

function safeJsonStringify(value) {
  return JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
}

/** Stream LLM output only for text the user will see. Internal agents stay buffered. */
function streamUserText(emit, opts) {
  if (emit) return streamAgentText(opts);
  const { onChunk, ...rest } = opts;
  return generateAgentText(rest);
}

function streamUserObject(emit, opts) {
  if (emit) return streamAgentObject(opts);
  const { onPartial, ...rest } = opts;
  return generateAgentObject(rest);
}

function insightSnapshot(partial) {
  if (!partial || typeof partial !== 'object') return {};
  const out = {};
  if (typeof partial.summary === 'string') out.summary = partial.summary;
  if (Array.isArray(partial.keyFindings)) {
    out.keyFindings = partial.keyFindings.filter((x) => typeof x === 'string');
  }
  if (Array.isArray(partial.recommendations)) {
    out.recommendations = partial.recommendations.filter((x) => typeof x === 'string');
  }
  if (typeof partial.trends === 'string') out.trends = partial.trends;
  if (['positive', 'neutral', 'warning', 'critical'].includes(partial.severity)) {
    out.severity = partial.severity;
  }
  return out;
}

function buildInsightPromptParts({ sqlResult, sqlMeta, ragResult }) {
  const parts = [];

  if (sqlResult?.rows?.length) {
    parts.push(`## Database Results\nQuery returned ${sqlResult.rowCount} rows.\nSample: ${safeJsonStringify(sqlResult.rows.slice(0, 20))}`);
  } else if (sqlMeta?.sql) {
    parts.push(`## SQL Attempted\n${sqlMeta.sql}`);
    if (sqlMeta.error) parts.push(`Error: ${sqlMeta.error}`);
    if (sqlMeta.explanation) parts.push(`Note: ${sqlMeta.explanation}`);
  } else if (sqlMeta?.explanation) {
    parts.push(`## SQL Agent\n${sqlMeta.explanation}`);
  }

  if (ragResult?.answer && !ragResult.noContext) {
    parts.push(`## Document Insights\n${ragResult.answer}\nSources: ${(ragResult.sources || []).join(', ')}`);
  }

  return parts;
}

async function generateLlmInsight({ question, plan, parts, emit }) {
  const prompt = `You are a senior business analyst. Analyze this data and provide executive-level insights.

Question: "${question}"
Question type: ${plan.questionType}
Complexity: ${plan.complexity}
Analysis focus: ${plan.sqlReason || plan.docReason || 'general analytics'}

${parts.join('\n\n')}

Rules:
- Use ONLY numbers and metrics explicitly present in the Database Results or Document Insights above
- Do not invent, estimate, or extrapolate figures not in the provided data
- If data is insufficient to answer, say so clearly in the summary
- Keep recommendations grounded in the evidence provided`;

  const insight = await streamUserObject(emit, {
    prompt,
    schema: insightSchema,
    maxOutputTokens: 700,
    onPartial: (partial) => {
      const snap = insightSnapshot(partial);
      if (emit && Object.keys(snap).length) emit('insight', snap);
    },
  });
  return sanitizeInsight(insight);
}

function makeDirectResponse({ question, intent, responseMode, message, steps, startTime }) {
  return {
    question,
    intent,
    responseMode,
    plan: null,
    sql: null,
    sqlExplanation: null,
    rows: [],
    rowCount: 0,
    fields: [],
    duration: 0,
    chartType: 'table',
    chartConfig: null,
    ragAnswer: null,
    ragSources: [],
    insight: {
      summary: message,
      keyFindings: [],
      recommendations: [],
      severity: responseMode === 'declined' ? 'neutral' : 'positive',
    },
    steps,
    totalDuration: Date.now() - startTime,
    success: true,
  };
}

// ── 0. Intent Classifier ──────────────────────────────────────────────────────

async function intentClassifier(question, hasDocuments, emit) {
  const prompt = `Classify the user message for a Business Analytics assistant.

User message: "${question}"
Company documents uploaded: ${hasDocuments}

Intents (pick exactly one):
- greeting: hellos, thanks, small talk, "hi", "how are you"
- analytics_sql: questions answerable by querying a database (counts, totals, trends, sales, users, orders, metrics)
- company_documents: questions about uploaded company files, policies, reports, internal docs, OR asking about a specific person/product/company/topic that may appear in those documents (e.g. "tell me about Medyn", "what is our leave policy", "summarize the Q3 report")
- general_business: ONLY generic business advice with no need to look up THIS company's data or docs (e.g. "what is EBITDA", "tips for cash flow")
- out_of_scope: unrelated topics (jokes, coding homework, personal chat, trivia, anything outside business analytics)

Rules:
- If documents are uploaded (true) and the question asks to explain/describe/"tell me about" a named topic, person, product, policy, or company — choose company_documents (NOT analytics_sql, NOT general_business).
- Prefer analytics_sql ONLY when the answer needs database metrics/aggregations (counts, totals, trends, rankings over tables).
- "tell me about X" / "what is our policy" style questions are company_documents when docs exist, even if X sounds like a business term.`;

  try {
    const result = await generateAgentObject({ prompt, schema: intentSchema, maxOutputTokens: 1024 });
    return correctIntent(result, question, hasDocuments);
  } catch {
    return heuristicIntent(question, hasDocuments);
  }
}

function looksLikeDocumentQuestion(question) {
  const q = question.trim().toLowerCase();
  if (!q) return false;
  if (/\b(document|policy|handbook|uploaded|pdf|report|contract|sop|guideline|leave policy|hr policy)\b/.test(q)) return true;
  if (/\b(tell me about|what (is|are)|who is|explain|describe|summarize|summary of)\b/.test(q)) return true;
  return false;
}

function looksLikeAnalyticsQuestion(question) {
  const q = question.trim().toLowerCase();
  return /\b(count|total|sum|average|avg|trend|sales|revenue|orders?|users?|how many|top \d+|metric)\b/.test(q);
}

/** Docs exist + document-style phrasing + not a metric question → must use RAG. */
function shouldPreferDocuments(question, hasDocuments) {
  return Boolean(
    hasDocuments &&
    looksLikeDocumentQuestion(question) &&
    !looksLikeAnalyticsQuestion(question),
  );
}

function correctIntent(result, question, hasDocuments) {
  if (!result?.intent) return heuristicIntent(question, hasDocuments);

  // When docs exist, document-style questions must search uploads — never SQL-only or general knowledge.
  if (
    shouldPreferDocuments(question, hasDocuments) &&
    result.intent !== 'company_documents' &&
    result.intent !== 'greeting'
  ) {
    return {
      ...result,
      intent: 'company_documents',
      confidence: Math.max(result.confidence || 0.6, 0.8),
      reasoning: `${result.reasoning || 'classifier'}; corrected to company_documents (docs available, document-style question)`,
    };
  }

  return result;
}

function heuristicIntent(question, hasDocuments) {
  const q = question.trim().toLowerCase();
  if (/^(hi|hello|hey|thanks|thank you|good morning|good evening)\b/.test(q)) {
    return { intent: 'greeting', confidence: 0.9, reasoning: 'heuristic' };
  }
  if (shouldPreferDocuments(question, hasDocuments)) {
    return { intent: 'company_documents', confidence: 0.8, reasoning: 'heuristic-docs' };
  }
  if (looksLikeAnalyticsQuestion(question)) {
    return { intent: 'analytics_sql', confidence: 0.7, reasoning: 'heuristic-sql' };
  }
  if (q.length < 20 && !/\?/.test(q)) {
    return { intent: 'greeting', confidence: 0.7, reasoning: 'heuristic' };
  }
  return { intent: hasDocuments ? 'company_documents' : 'analytics_sql', confidence: 0.5, reasoning: 'fallback' };
}

/** Force RAG-only plan for document-style questions when uploads exist. */
function forceDocumentPlan(plan, question) {
  return {
    ...plan,
    needsSQL: false,
    needsDocuments: true,
    sqlReason: '',
    docReason: plan.docReason || `Find relevant passages in uploaded documents for: ${question.trim()}`,
    questionType: 'explanation',
    expectsRows: false,
  };
}

// ── Direct LLM response (greeting / general_business) ─────────────────────────

async function directChatAgent(question, intent, conversationHistory = [], emit) {
  const system = intent === 'greeting'
    ? `You are a friendly AI Business Analytics assistant. Respond warmly and briefly. Mention you can answer database analytics questions or search uploaded company documents. Keep it to 2-4 sentences.`
    : `You are a knowledgeable business advisor. Answer the question clearly and concisely. You do not have live database or document access for this reply — if they need numbers from their data, suggest asking an analytics question.`;

  const messages = [
    ...conversationHistory.slice(-6).map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: question },
  ];

  let text = '';
  return streamUserText(emit, {
    system,
    messages,
    maxOutputTokens: 400,
    onChunk: (chunk) => {
      text += chunk;
      if (emit) emit('insight', { summary: text });
    },
  });
}

function planFromIntent(intent, hasDocuments, question = '') {
  const q = question.toLowerCase();

  let questionType = 'metric';
  if (/trend|over time|monthly|yearly|quarterly|growth|by (day|week|month|year)/.test(q)) questionType = 'trend';
  else if (/top|bottom|rank|highest|lowest|best|worst|leading/.test(q)) questionType = 'ranking';
  else if (/compare|vs\.?|versus|difference between/.test(q)) questionType = 'comparison';
  else if (/breakdown|by category|by region|per |split by|group by/.test(q)) questionType = 'breakdown';
  else if (/explain|what is|describe|policy|document/.test(q)) questionType = 'explanation';

  let complexity = 'moderate';
  if (/join|across|correlat|cohort|funnel|multiple tables/.test(q)) complexity = 'complex';
  else if (/count|total|how many|sum|average|avg/.test(q)) complexity = 'simple';

  if (intent === 'analytics_sql') {
    return {
      needsSQL: true,
      needsDocuments: false,
      sqlReason: `Answer "${question.trim()}" with a ${questionType} query over business tables`,
      docReason: '',
      complexity,
      questionType,
      expectsRows: questionType !== 'explanation',
    };
  }
  if (intent === 'company_documents') {
    return {
      needsSQL: false,
      needsDocuments: hasDocuments,
      sqlReason: '',
      docReason: `Find relevant passages in uploaded documents for: ${question.trim()}`,
      complexity,
      questionType: 'explanation',
      expectsRows: false,
    };
  }
  return {
    needsSQL: true,
    needsDocuments: false,
    sqlReason: `Retrieve data to answer: ${question.trim()}`,
    docReason: '',
    complexity,
    questionType,
    expectsRows: true,
  };
}

async function plannerAgent(question, intent, hasDocuments, emit) {
  // Hard route: never let document-style questions fall through to SQL-only when docs exist.
  if (intent === 'company_documents' || shouldPreferDocuments(question, hasDocuments)) {
    return planFromIntent('company_documents', hasDocuments, question);
  }

  const prompt = `Plan how to answer this business analytics question.

Question: "${question}"
Classified intent: ${intent}
Documents available: ${hasDocuments}

Return a routing plan:
- needsSQL: query the business database
- needsDocuments: search uploaded company documents
- sqlReason: why SQL is needed (specific to this question)
- docReason: why document search is needed (if any)
- complexity: simple | moderate | complex
- questionType: metric | trend | comparison | ranking | breakdown | explanation
- expectsRows: true if the user likely expects non-empty SQL results

Rules:
- If intent is company_documents, set needsSQL=false and needsDocuments=true (when documents available).
- If intent is analytics_sql, set needsSQL=true. Only set needsDocuments=true if the question also asks about policies/reports/uploaded files.
- Do not choose SQL for "tell me about X" / policy / document explanation questions.`;

  try {
    const plan = await generateAgentObject({ prompt, schema: plannerSchema, maxOutputTokens: 1024 });
    if (shouldPreferDocuments(question, hasDocuments)) {
      return forceDocumentPlan(plan, question);
    }
    if (intent === 'analytics_sql') {
      plan.needsSQL = true;
      // Keep optional hybrid RAG only when the question also references docs/policies.
      if (!looksLikeDocumentQuestion(question)) {
        plan.needsDocuments = false;
      } else if (hasDocuments) {
        plan.needsDocuments = true;
      }
    }
    if (intent === 'company_documents') {
      return forceDocumentPlan(plan, question);
    }
    if (plan.needsSQL && !plan.sqlReason) {
      plan.sqlReason = `Answer "${question.trim()}" via SQL`;
    }
    if (plan.expectsRows == null) {
      plan.expectsRows = plan.questionType !== 'explanation';
    }
    return plan;
  } catch {
    return planFromIntent(intent, hasDocuments, question);
  }
}

function expectsSqlRows(plan) {
  return plan.needsSQL && plan.expectsRows !== false;
}

// ── 2. SQL Agent ──────────────────────────────────────────────────────────────

function buildSqlPrompt(question, schema, plan, priorAttempt = null) {
  const schemaText = schemaToText(schema);

  const retryBlock = priorAttempt?.sql
    ? `\nThe SELECT you just wrote for THIS question failed. Rewrite a new SELECT for the same question — do not return the failed statement unchanged.
Failed SQL:
${priorAttempt.sql}
Error / issue:
${priorAttempt.error}
`
    : '';

  return `You are an expert PostgreSQL analyst.

${schemaText}

Planner routing:
- Why SQL is needed: ${plan.sqlReason}
- Question type: ${plan.questionType}
- Complexity: ${plan.complexity}
- User expects data rows: ${expectsSqlRows(plan) ? 'yes' : 'no'}

Rules:
- ONLY generate a single SELECT statement (no INSERT/UPDATE/DELETE/DDL)
- Queries are validated in code before execution — they must pass the SQL guard (SELECT-only, no multiple statements, row LIMIT cap)
- Add LIMIT 500 to queries that may return many rows
- Use table aliases
- Write a brand-new SELECT for this question only. Do not reuse, adapt, or copy any earlier query.
- Do not add month/date WHERE filters unless this question explicitly asks for a time range.
- Top selling / top products: GROUP BY product name, ORDER BY SUM(quantity) or SUM(total) DESC. Do not require a date filter.
- If a time filter would likely match no rows, omit it or use the latest available ordered_at values instead of NOW()-based months.
- Always produce a SELECT. Never return an empty sql field.

${retryBlock}
Question: ${question}

Reply with a single PostgreSQL SELECT only. No markdown, no JSON.`;
}

async function sqlAgent(question, schema, plan, priorAttempt = null) {
  const errors = [];
  const prompt = buildSqlPrompt(question, schema, plan, priorAttempt);

  try {
    const text = await generateAgentText({ prompt, maxOutputTokens: 4096 });
    const sql = extractSqlFromText(text);
    if (sql) return { sql, explanation: 'Generated SQL', confidence: 0.7 };
    if (text?.trim()) errors.push(`model returned no SELECT (got: ${text.trim().slice(0, 180)})`);
    else errors.push('model returned empty text');
  } catch (textErr) {
    console.warn('SQL text generation failed:', textErr.message);
    errors.push(textErr.message);
  }

  try {
    const result = await generateAgentObject({
      prompt: `${prompt}\n\nReturn JSON with sql, explanation, and confidence.`,
      schema: sqlSchema,
      maxOutputTokens: 4096,
    });
    if (result?.sql) return result;
    if (result?.explanation) errors.push(result.explanation);
  } catch (err) {
    console.warn('SQL generateObject failed:', err.message);
    errors.push(err.message);
  }

  return {
    sql: null,
    explanation: errors.length ? `Failed to generate SQL: ${errors.join(' | ')}` : 'Failed to generate SQL',
    confidence: 0,
  };
}

async function runSqlWithGuard(question, schema, plan, dbType, emit) {
  let sqlMeta = null;
  let sqlResult = null;
  let sqlRetries = 0;
  let priorAttempt = null;

  for (let attempt = 0; attempt <= SQL_MAX_RETRIES; attempt++) {
    sqlMeta = await sqlAgent(question, schema, plan, priorAttempt);

    if (!sqlMeta.sql) {
      sqlMeta.error = sqlMeta.explanation || 'SQL agent returned no query';
      break;
    }

    const validation = validateSql(sqlMeta.sql, { schema, maxRows: 500 });
    if (!validation.ok) {
      sqlMeta.error = validation.error;
      priorAttempt = { sql: sqlMeta.sql, error: validation.error, schema };
      if (attempt < SQL_MAX_RETRIES) {
        sqlRetries++;
        continue;
      }
      break;
    }

    sqlMeta.sql = validation.sql;

    try {
      sqlResult = await executeQuery(sqlMeta.sql, [], dbType);
      sqlMeta.error = undefined;

      const empty = !sqlResult.rows || sqlResult.rows.length === 0;
      if (empty && expectsSqlRows(plan) && attempt < SQL_MAX_RETRIES) {
        sqlMeta.error = 'Query returned 0 rows. Drop or widen date filters, avoid NOW()-based months if data is older, and verify JOINs and column names.';
        priorAttempt = { sql: sqlMeta.sql, error: sqlMeta.error, schema };
        sqlResult = null;
        sqlRetries++;
        continue;
      }

      break;
    } catch (e) {
      sqlMeta.error = e.message;
      priorAttempt = { sql: sqlMeta.sql, error: e.message, schema };
      if (attempt < SQL_MAX_RETRIES) {
        sqlRetries++;
        continue;
      }
    }
  }

  return { sqlMeta, sqlResult, sqlRetries };
}

// ── 3. RAG Agent ──────────────────────────────────────────────────────────────

// Cosine similarity floor. Slightly soft so short queries ("tell me about policy")
// still surface the best available chunks when the corpus is small.
const RAG_MIN_SIMILARITY = 0.42;
const RAG_FALLBACK_MIN_SIMILARITY = 0.28;

async function ragAgent(question, emit) {
  const chunks = await retrieveRelevantChunks(question, 5);
  let relevant = chunks.filter(c => c.similarity >= RAG_MIN_SIMILARITY);
  // With sparse corpora, take the best chunk(s) rather than returning nothing.
  if (!relevant.length && chunks.length) {
    const best = chunks[0];
    if (best.similarity >= RAG_FALLBACK_MIN_SIMILARITY) {
      relevant = chunks.filter(c => c.similarity >= Math.max(RAG_FALLBACK_MIN_SIMILARITY, best.similarity - 0.08)).slice(0, 3);
    }
  }
  if (!relevant.length) return null;

  const context = relevant.map((c) =>
    `[Source: ${c.docName} | relevance: ${(c.similarity * 100).toFixed(0)}%]\n${c.text}`
  ).join('\n\n---\n\n');

  const prompt = `Answer ONLY using the document excerpts below. Do not use outside knowledge.

Question: "${question}"

${context}

Rules:
- Answer only from the provided chunks; if they do not contain enough information, respond exactly: "I don't have enough information in the uploaded documents to answer that question."
- Cite source filenames inline (e.g. "According to [filename], ...") for every factual claim
- Plain text, 3-5 sentences`;

  const answer = await streamUserText(emit, {
    prompt,
    maxOutputTokens: 400,
    onChunk: (text) => { if (emit) emit('token', { text, field: 'rag' }); },
  });
  const topSimilarity = relevant[0]?.similarity ?? 0;

  return {
    answer: answer.trim(),
    sources: [...new Set(relevant.map(c => c.docName))],
    chunkCount: relevant.length,
    topSimilarity,
    ragConfidence: topSimilarity,
  };
}

const RAG_NO_CONTEXT_MESSAGE =
  "I couldn't find relevant information in your uploaded documents for this question. Try rephrasing or upload documents that cover this topic.";

// ── 4. Visualization Agent ────────────────────────────────────────────────────

function isRenderableChart(viz) {
  return Boolean(viz?.chartType && viz.chartType !== 'table' && viz.chartConfig?.xKey && viz.chartConfig?.yKey);
}

function resolveViz(llm, rules) {
  if (isRenderableChart(llm)) return { chartType: llm.chartType, chartConfig: llm.chartConfig };
  if (isRenderableChart(rules)) return { chartType: rules.chartType, chartConfig: rules.chartConfig };
  return { chartType: llm?.chartType || rules.chartType || 'table', chartConfig: llm?.chartConfig || rules.chartConfig || null };
}

async function visualizationAgent(question, rows, plan, emit) {
  if (!rows?.length) return { chartType: 'table', chartConfig: null };

  const rules = pickChartByRules(question, rows, plan.questionType);
  if (!rules.ambiguous) {
    return { chartType: rules.chartType, chartConfig: rules.chartConfig };
  }

  const keys = Object.keys(rows[0]);
  const sample = rows.slice(0, 3);

  const prompt = `Question: "${question}"
Question type: ${plan.questionType}
Complexity: ${plan.complexity}
SQL reason: ${plan.sqlReason}
Data columns: ${keys.join(', ')}
Sample rows: ${JSON.stringify(sample)}
Row count: ${rows.length}
Suggested chart: ${rules.chartType}${rules.chartConfig ? ` (x=${rules.chartConfig.xKey}, y=${rules.chartConfig.yKey})` : ''}

Choose the best chart type and axis mapping.
Prefer bar, line, pie, or number whenever there is a category/date column and at least one numeric measure.
Only use table when the data cannot reasonably be visualized.
If multiple numeric columns exist, pick the measure that best answers the question as yKey.`;

  try {
    const llm = await generateAgentObject({ prompt, schema: visualizationSchema, maxOutputTokens: 200 });
    return resolveViz(llm, rules);
  } catch {
    return { chartType: rules.chartType, chartConfig: rules.chartConfig };
  }
}

// ── 5. Insight Agent ──────────────────────────────────────────────────────────

async function insightAgent({ question, plan, sqlResult, sqlMeta, ragResult, emit }) {
  const hasSqlRows = Boolean(sqlResult?.rows?.length);
  const hasRag = Boolean(ragResult?.answer && !ragResult.noContext);

  // Document-only path with no useful chunks: surface RAG message, not SQL seeding advice.
  if (!hasSqlRows && !hasRag && (ragResult?.noContext || (plan.needsDocuments && !plan.needsSQL))) {
    return sanitizeInsight({
      summary: ragResult?.answer || RAG_NO_CONTEXT_MESSAGE,
      keyFindings: [],
      recommendations: [
        'Try rephrasing with terms that appear in your documents',
        'Upload additional PDFs/Word files that cover this topic',
      ],
      severity: 'neutral',
    });
  }

  // Empty SQL result: never call the insight LLM (~3s saved)
  if (sqlMeta?.sql && !hasSqlRows && !hasRag) {
    return sanitizeInsight({
      summary: 'The query ran successfully but returned no rows. Check that migrations have been applied and seed data exists for the tables involved.',
      keyFindings: [`SQL attempted: ${sqlMeta.sql}`],
      recommendations: [
        'Verify analytics tables are migrated and seeded',
        'Try broadening filters or rephrasing the question',
      ],
      severity: 'neutral',
    });
  }

  if (!hasSqlRows && !hasRag) {
    return sanitizeInsight({
      summary: sqlMeta?.explanation || sqlMeta?.error
        || 'Could not generate a database query for this question.',
      keyFindings: [
        ...(sqlMeta?.error ? [sqlMeta.error] : []),
        ...(sqlMeta?.explanation && sqlMeta.explanation !== sqlMeta.error ? [sqlMeta.explanation] : []),
      ],
      recommendations: [
        'Try a simpler question such as "top 10 products by revenue"',
        'Avoid carrying over a previous month/date filter unless you still want that range',
      ],
      severity: 'warning',
    });
  }

  const deterministic = buildInsightFromData({ question, sqlResult, ragResult });
  const useLlm = shouldUseLlmInsight(sqlResult);

  if (deterministic && !useLlm) {
    return sanitizeInsight(deterministic);
  }

  if (sqlMeta?.error && !hasSqlRows) {
    return sanitizeInsight({
      summary: `The database query could not be completed: ${sqlMeta.error}`,
      keyFindings: sqlMeta.sql ? [`SQL attempted: ${sqlMeta.sql}`] : [],
      recommendations: ['Try rephrasing your question or check that the relevant tables exist.'],
      severity: 'warning',
    });
  }

  const parts = buildInsightPromptParts({ sqlResult, sqlMeta, ragResult });
  const hasDataParts = hasSqlRows || hasRag;

  if (useLlm && hasDataParts && parts.length) {
    try {
      return await generateLlmInsight({ question, plan, parts, emit });
    } catch (err) {
      console.warn('Insight LLM failed, falling back to local:', err.message);
      if (deterministic) return sanitizeInsight(deterministic);
      if (isAiQuotaError(err)) {
        return sanitizeInsight({
          summary: 'AI quota limit reached and no local summary could be built. See the data table above.',
          keyFindings: [],
          recommendations: [],
          severity: 'neutral',
        });
      }
      try {
        let summary = '';
        const text = await streamUserText(emit, {
          prompt: `${parts.join('\n\n')}\n\nQuestion: "${question}"\nType: ${plan.questionType}\nFocus: ${plan.sqlReason || plan.docReason}\nRespond in plain text: a 2-3 sentence executive summary using only the numbers above.`,
          maxOutputTokens: 500,
          onChunk: (chunk) => {
            summary += chunk;
            if (emit) emit('insight', { summary });
          },
        });
        return sanitizeInsight({
          summary: text.trim(),
          keyFindings: [],
          recommendations: [],
          severity: 'neutral',
        });
      } catch {
        if (deterministic) return sanitizeInsight(deterministic);
      }
    }
  }

  if (deterministic) {
    return sanitizeInsight(deterministic);
  }

  return sanitizeInsight({
    summary: 'No data available for this question. Try rephrasing or check that analytics tables are seeded and documents are uploaded.',
    keyFindings: sqlMeta?.sql ? [`SQL attempted: ${sqlMeta.sql}`] : [],
    recommendations: [],
    severity: 'neutral',
  });
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export async function runAgentPipeline(question, options = {}) {
  const { conversationHistory = [], dbType = 'postgresql', onEvent } = options;
  const emit = onEvent ? (type, data) => onEvent(type, data) : null;
  const steps = [];
  const startTime = Date.now();

  let docStats = { documentCount: 0 };
  try {
    docStats = await getDocumentStats();
  } catch (err) {
    console.warn('RAG tables unavailable:', err.message);
  }
  // Prefer chunkCount so we only claim RAG is available when vectors exist.
  const hasDocuments = (docStats.chunkCount || 0) > 0 || docStats.documentCount > 0;

  // Step 0: Intent classification
  pushRunningStep(steps, 'intent', emit);
  let classification = await intentClassifier(question, hasDocuments, emit);
  // Belt-and-suspenders: never let document-style Qs stay on analytics_sql when uploads exist.
  if (shouldPreferDocuments(question, hasDocuments) && classification.intent !== 'company_documents') {
    classification = {
      ...classification,
      intent: 'company_documents',
      confidence: Math.max(classification.confidence || 0.6, 0.85),
      reasoning: `${classification.reasoning || 'classifier'}; pipeline override → company_documents`,
    };
  }
  finishStep(steps, 0);
  emitSteps(emit, steps);
  let { intent } = classification;

  // Greeting / general business → direct LLM reply
  if (intent === 'greeting' || intent === 'general_business') {
    pushRunningStep(steps, 'chat', emit);
    const message = await directChatAgent(question, intent, conversationHistory, emit);
    finishStep(steps, 1);
    emitSteps(emit, steps);
    const text = (message || '').trim() || (
      intent === 'greeting'
        ? 'Hi! I can answer questions about your database or search your uploaded company documents.'
        : 'I could not generate a reply. Try asking about your uploaded documents or a database metric.'
    );
    return makeDirectResponse({
      question,
      intent,
      responseMode: 'direct',
      message: text,
      steps,
      startTime,
    });
  }

  // Out of scope → graceful decline
  if (intent === 'out_of_scope') {
    return makeDirectResponse({
      question,
      intent,
      responseMode: 'declined',
      message: `I'm a business analytics assistant — I can help with database questions (e.g. "How many orders this month?") or searching your uploaded company documents. I can't help with that topic, but feel free to ask something along those lines.`,
      steps,
      startTime,
    });
  }

  // Company documents but none uploaded
  if (intent === 'company_documents' && !hasDocuments) {
    return makeDirectResponse({
      question,
      intent,
      responseMode: 'declined',
      message: `No company documents are uploaded yet. Go to the Documents page to upload PDFs, Word, Excel, or text files, then ask questions about their content.`,
      steps,
      startTime,
    });
  }

  // Planner: routing + question metadata for downstream agents
  pushRunningStep(steps, 'planner', emit);
  let plan = await plannerAgent(question, intent, hasDocuments, emit);
  if (shouldPreferDocuments(question, hasDocuments)) {
    intent = 'company_documents';
    plan = forceDocumentPlan(plan, question);
  }
  finishStep(steps, steps.length - 1);
  emitSteps(emit, steps);

  let sqlResult = null;
  let sqlMeta = null;
  let sqlRetries = 0;
  let ragResult = null;
  let ragConfidence = null;
  let vizResult = null;

  const emitAnalyticsPartial = () => {
    if (!emit) return;
    const payload = {
      question,
      intent,
      responseMode: 'analytics',
      plan,
      sql: sqlMeta?.sql || null,
      sqlExplanation: sqlMeta?.explanation || null,
      sqlRetries: sqlRetries || undefined,
      ragConfidence,
      steps: steps.map((s) => ({ ...s })),
      totalDuration: Date.now() - startTime,
      success: true,
    };
    if (sqlResult) {
      payload.rows = sqlResult.rows || [];
      payload.rowCount = sqlResult.rowCount || 0;
      payload.fields = sqlResult.fields || [];
      payload.duration = sqlResult.duration || 0;
    }
    if (vizResult) {
      payload.chartType = vizResult.chartType;
      payload.chartConfig = vizResult.chartConfig;
    }
    if (ragResult) {
      payload.ragAnswer = ragResult.answer || null;
      payload.ragSources = ragResult.sources || [];
    }
    emit('partial', payload);
  };

  const schema = plan.needsSQL ? await getCachedSchema(dbType) : null;
  const tasks = [];

  if (plan.needsSQL) {
    tasks.push((async () => {
      const stepIdx = steps.length;
      pushRunningStep(steps, 'sql', emit);
      const sqlRun = await runSqlWithGuard(question, schema, plan, dbType, emit);
      sqlMeta = sqlRun.sqlMeta;
      sqlResult = sqlRun.sqlResult;
      sqlRetries = sqlRun.sqlRetries;
      if (sqlResult?.rows?.length) {
        const rules = pickChartByRules(question, sqlResult.rows, plan.questionType);
        vizResult = { chartType: rules.chartType, chartConfig: rules.chartConfig };
      }
      finishStep(steps, stepIdx);
      emitSteps(emit, steps);
      emitAnalyticsPartial();
    })());
  }

  if (plan.needsDocuments && hasDocuments) {
    tasks.push((async () => {
      const stepIdx = steps.length;
      pushRunningStep(steps, 'rag', emit);
      ragResult = await ragAgent(question, emit);
      finishStep(steps, stepIdx);
      emitSteps(emit, steps);
      emitAnalyticsPartial();
    })());
  }

  await Promise.all(tasks);

  // Document-primary path: always surface a RAG outcome (answer or explicit no-context).
  if (plan.needsDocuments && !plan.needsSQL && hasDocuments && !ragResult) {
    ragResult = {
      answer: RAG_NO_CONTEXT_MESSAGE,
      sources: [],
      chunkCount: 0,
      topSimilarity: 0,
      ragConfidence: 0,
      noContext: true,
    };
  }

  if (ragResult?.ragConfidence != null) {
    ragConfidence = ragResult.ragConfidence;
  }

  if (sqlResult?.rows?.length) {
    const stepIdx = steps.length;
    pushRunningStep(steps, 'visualization', emit);
    vizResult = await visualizationAgent(question, sqlResult.rows, plan, emit);
    finishStep(steps, stepIdx);
    emitSteps(emit, steps);
  }

  emitAnalyticsPartial();

  const stepIdx = steps.length;
  pushRunningStep(steps, 'insight', emit);
  const insight = await insightAgent({ question, plan, sqlResult, sqlMeta, ragResult, emit });
  if (emit) emit('insight', insight);
  finishStep(steps, stepIdx);
  emitSteps(emit, steps);

  return {
    question,
    intent,
    responseMode: 'analytics',
    plan,
    sql: sqlMeta?.sql || null,
    sqlExplanation: sqlMeta?.explanation || null,
    rows: sqlResult?.rows || [],
    rowCount: sqlResult?.rowCount || 0,
    fields: sqlResult?.fields || [],
    duration: sqlResult?.duration || 0,
    chartType: vizResult?.chartType || 'table',
    chartConfig: vizResult?.chartConfig || null,
    ragAnswer: ragResult?.answer || null,
    ragSources: ragResult?.sources || [],
    ragConfidence,
    sqlRetries: sqlRetries || undefined,
    insight,
    steps,
    totalDuration: Date.now() - startTime,
    success: true,
  };
}

export { INTENTS };
