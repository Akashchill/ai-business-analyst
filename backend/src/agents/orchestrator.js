/**
 * Agent Orchestrator
 *   0. IntentClassifier — greeting | analytics_sql | company_documents | general_business | out_of_scope
 *   1. SQL / RAG pipeline (routed by intent)
 */

import { generateAgentText, generateAgentObject, streamAgentText, streamAgentObject } from '../config/ai.js';
import { z } from 'zod';
import { getDatabaseSchema, executeQuery } from '../config/database.js';
import { retrieveRelevantChunks, getDocumentStats } from '../services/ragService.js';
import { validateSql } from '../utils/sqlGuard.js';
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
  sql: z.string().nullable(),
  explanation: z.string(),
  confidence: z.number(),
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

  if (emit) {
    let lastSummary = '';
    const insight = await streamAgentObject({
      prompt,
      schema: insightSchema,
      maxOutputTokens: 700,
      onPartial: (partial) => {
        if (partial?.summary && typeof partial.summary === 'string') {
          const delta = partial.summary.slice(lastSummary.length);
          if (delta) emit('token', { text: delta });
          lastSummary = partial.summary;
        }
      },
    });
    return sanitizeInsight(insight);
  }

  const insight = await generateAgentObject({ prompt, schema: insightSchema, maxOutputTokens: 700 });
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

async function intentClassifier(question, hasDocuments) {
  const prompt = `Classify the user message for a Business Analytics assistant.

User message: "${question}"
Company documents uploaded: ${hasDocuments}

Intents (pick exactly one):
- greeting: hellos, thanks, small talk, "hi", "how are you"
- analytics_sql: questions answerable by querying a database (counts, totals, trends, sales, users, orders, metrics)
- company_documents: questions about uploaded company files, policies, reports, internal docs
- general_business: general business advice or concepts that do NOT need live database or document lookup
- out_of_scope: unrelated topics (jokes, coding homework, personal chat, trivia, anything outside business analytics)`;

  try {
    return await generateAgentObject({ prompt, schema: intentSchema, maxOutputTokens: 200 });
  } catch {
    // Short messages without data keywords → greeting; otherwise try analytics
    const q = question.trim().toLowerCase();
    if (/^(hi|hello|hey|thanks|thank you|good morning|good evening)\b/.test(q)) {
      return { intent: 'greeting', confidence: 0.9, reasoning: 'heuristic' };
    }
    if (q.length < 20 && !/\?/.test(q)) {
      return { intent: 'greeting', confidence: 0.7, reasoning: 'heuristic' };
    }
    return { intent: 'analytics_sql', confidence: 0.5, reasoning: 'fallback' };
  }
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

  if (emit) {
    return streamAgentText({
      system,
      messages,
      maxOutputTokens: 400,
      onChunk: (text) => emit('token', { text }),
    });
  }

  return generateAgentText({ system, messages, maxOutputTokens: 400 });
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

async function plannerAgent(question, intent, hasDocuments) {
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
- expectsRows: true if the user likely expects non-empty SQL results`;

  try {
    const plan = await generateAgentObject({ prompt, schema: plannerSchema, maxOutputTokens: 280 });
    if (intent === 'analytics_sql') {
      plan.needsSQL = true;
      plan.needsDocuments = false;
    }
    if (intent === 'company_documents') {
      plan.needsSQL = false;
      plan.needsDocuments = hasDocuments;
      if (!plan.docReason) plan.docReason = `Search documents for: ${question.trim()}`;
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

async function sqlAgent(question, schema, plan, conversationHistory = [], priorAttempt = null) {
  const schemaText = schemaToText(schema);
  const system = `You are an expert PostgreSQL analyst.

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
- If the query is impossible with this schema, set sql to null`;

  const messages = [
    ...conversationHistory.slice(-4).map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: question },
  ];

  if (priorAttempt?.sql) {
    const schemaSection = priorAttempt.schema
      ? `\n\nDatabase schema (verify table/column names):\n${schemaToText(priorAttempt.schema)}`
      : '';
    messages.push({
      role: 'user',
      content: `Your previous SQL failed validation, errored at runtime, or returned 0 rows when data was expected. Fix it.

Planner context:
- SQL reason: ${plan.sqlReason}
- Question type: ${plan.questionType}
- Complexity: ${plan.complexity}

Previous SQL:
${priorAttempt.sql}

Error / issue:
${priorAttempt.error}${schemaSection}

Return corrected SQL that passes validation (single SELECT only) and answers the question.`,
    });
  }

  try {
    return await generateAgentObject({ system, messages, schema: sqlSchema, maxOutputTokens: 1000 });
  } catch {
    return { sql: null, explanation: 'Failed to generate SQL', confidence: 0 };
  }
}

async function runSqlWithGuard(question, schema, plan, conversationHistory, dbType) {
  let sqlMeta = null;
  let sqlResult = null;
  let sqlRetries = 0;
  let priorAttempt = null;

  for (let attempt = 0; attempt <= SQL_MAX_RETRIES; attempt++) {
    sqlMeta = await sqlAgent(question, schema, plan, conversationHistory, priorAttempt);

    if (!sqlMeta.sql) break;

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

      // Valid SQL + 0 rows: do not retry when schema has tables — empty data
      // is usually migrations/seed, not something more LLM attempts will fix.
      const empty = !sqlResult.rows || sqlResult.rows.length === 0;
      const hasTables = schema && Object.keys(schema).length > 0;
      if (empty && expectsSqlRows(plan) && hasTables) {
        break;
      }
      if (empty && expectsSqlRows(plan) && attempt < SQL_MAX_RETRIES) {
        sqlMeta.error = 'Query returned 0 rows but the question expects data. Check filters, date ranges, joins, and table/column names.';
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

const RAG_MIN_SIMILARITY = 0.55;

async function ragAgent(question, emit) {
  const chunks = await retrieveRelevantChunks(question, 5);
  const relevant = chunks.filter(c => c.similarity >= RAG_MIN_SIMILARITY);
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

  const answer = emit
    ? await streamAgentText({ prompt, maxOutputTokens: 400, onChunk: (text) => emit('token', { text, field: 'rag' }) })
    : await generateAgentText({ prompt, maxOutputTokens: 400 });
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

async function visualizationAgent(question, rows, plan) {
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

Column roles could not be determined by rules alone. Choose the best chart type and axis mapping.`;

  try {
    return await generateAgentObject({ prompt, schema: visualizationSchema, maxOutputTokens: 200 });
  } catch {
    return { chartType: rules.chartType, chartConfig: rules.chartConfig };
  }
}

// ── 5. Insight Agent ──────────────────────────────────────────────────────────

async function insightAgent({ question, plan, sqlResult, sqlMeta, ragResult, emit }) {
  const hasSqlRows = Boolean(sqlResult?.rows?.length);
  const hasRag = Boolean(ragResult?.answer && !ragResult.noContext);

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
        const text = emit
          ? await streamAgentText({
            prompt: `${parts.join('\n\n')}\n\nQuestion: "${question}"\nType: ${plan.questionType}\nFocus: ${plan.sqlReason || plan.docReason}\nRespond in plain text: a 2-3 sentence executive summary using only the numbers above.`,
            maxOutputTokens: 500,
            onChunk: (chunk) => emit('token', { text: chunk }),
          })
          : await generateAgentText({
            prompt: `${parts.join('\n\n')}\n\nQuestion: "${question}"\nType: ${plan.questionType}\nFocus: ${plan.sqlReason || plan.docReason}\nRespond in plain text: a 2-3 sentence executive summary using only the numbers above.`,
            maxOutputTokens: 500,
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
  const hasDocuments = docStats.documentCount > 0;

  // Step 0: Intent classification
  pushRunningStep(steps, 'intent', emit);
  const classification = await intentClassifier(question, hasDocuments);
  finishStep(steps, 0);
  emitSteps(emit, steps);
  const { intent } = classification;

  // Greeting / general business → direct LLM reply
  if (intent === 'greeting' || intent === 'general_business') {
    pushRunningStep(steps, 'chat', emit);
    const message = await directChatAgent(question, intent, conversationHistory, emit);
    finishStep(steps, 1);
    emitSteps(emit, steps);
    return makeDirectResponse({
      question,
      intent,
      responseMode: 'direct',
      message: message.trim(),
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
  const plan = await plannerAgent(question, intent, hasDocuments);
  finishStep(steps, steps.length - 1);
  emitSteps(emit, steps);

  let sqlResult = null;
  let sqlMeta = null;
  let sqlRetries = 0;
  let ragResult = null;
  let ragConfidence = null;
  let vizResult = null;

  const schema = plan.needsSQL ? await getCachedSchema(dbType) : null;
  const tasks = [];

  if (plan.needsSQL) {
    tasks.push((async () => {
      const stepIdx = steps.length;
      pushRunningStep(steps, 'sql', emit);
      const sqlRun = await runSqlWithGuard(question, schema, plan, conversationHistory, dbType);
      sqlMeta = sqlRun.sqlMeta;
      sqlResult = sqlRun.sqlResult;
      sqlRetries = sqlRun.sqlRetries;
      finishStep(steps, stepIdx);
      emitSteps(emit, steps);
    })());
  }

  if (plan.needsDocuments && hasDocuments) {
    tasks.push((async () => {
      const stepIdx = steps.length;
      pushRunningStep(steps, 'rag', emit);
      ragResult = await ragAgent(question, emit);
      finishStep(steps, stepIdx);
      emitSteps(emit, steps);
    })());
  }

  await Promise.all(tasks);

  if (intent === 'company_documents' && plan.needsDocuments && hasDocuments && !ragResult) {
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
    vizResult = await visualizationAgent(question, sqlResult.rows, plan);
    finishStep(steps, stepIdx);
    emitSteps(emit, steps);
  }

  if (emit) {
    emit('partial', {
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
      insight: {
        summary: '',
        keyFindings: [],
        recommendations: [],
        severity: 'neutral',
      },
      steps: steps.map((s) => ({ ...s })),
      totalDuration: Date.now() - startTime,
      success: true,
    });
  }

  const stepIdx = steps.length;
  pushRunningStep(steps, 'insight', emit);
  const insight = await insightAgent({ question, plan, sqlResult, sqlMeta, ragResult, emit });
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
