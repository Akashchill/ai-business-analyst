import express from 'express';
import { runAgentPipeline } from '../agents/orchestrator.js';
import { getDatabaseSchema, testConnection } from '../config/database.js';
import { saveQuery, getHistory, clearHistory } from '../services/historyService.js';
import { getSuggestedQuestions } from '../services/aiService.js';
import { getDocumentStats } from '../services/ragService.js';
import { optionalAuth, requireQueryAccess } from '../middleware/auth.js';
import { getCachedQuery, setCachedQuery } from '../services/queryCache.js';
import { getRedisStatus } from '../config/redis.js';

const router = express.Router();

/** Simple in-memory schema cache (mirrors orchestrator TTL). */
const schemaCache = { data: null, ts: 0, dbType: null };
const SCHEMA_TTL_MS = 5 * 60_000;

const MAX_QUESTION_LENGTH = 2000;
const MAX_HISTORY_ITEMS = 20;
const MAX_HISTORY_MESSAGE_LENGTH = 4000;

function validateQueryInput(body) {
  const { question, history = [] } = body;

  if (!question?.trim()) return { error: 'Question is required' };
  if (question.length > MAX_QUESTION_LENGTH) {
    return { error: `Question exceeds maximum length (${MAX_QUESTION_LENGTH} characters)` };
  }
  if (!Array.isArray(history)) return { error: 'history must be an array' };
  if (history.length > MAX_HISTORY_ITEMS) {
    return { error: `history exceeds maximum of ${MAX_HISTORY_ITEMS} messages` };
  }
  for (const msg of history) {
    if (!msg || typeof msg.content !== 'string') {
      return { error: 'Each history item must have a content string' };
    }
    if (msg.content.length > MAX_HISTORY_MESSAGE_LENGTH) {
      return { error: `History message exceeds maximum length (${MAX_HISTORY_MESSAGE_LENGTH} characters)` };
    }
  }
  return null;
}

function sendSse(res, event, data) {
  if (res.writableEnded || res.destroyed) return;
  try {
    const json = JSON.stringify(data, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
    res.write(`event: ${event}\ndata: ${json}\n\n`);
    if (typeof res.flush === 'function') res.flush();
  } catch (err) {
    console.error('SSE write failed:', err.message);
  }
}

function startSseKeepAlive(req, res) {
  req.setTimeout(0);
  res.setTimeout(0);
  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(heartbeat);
      return;
    }
    res.write(': keepalive\n\n');
    if (typeof res.flush === 'function') res.flush();
  }, 15_000);
  const stop = () => clearInterval(heartbeat);
  req.on('close', stop);
  res.on('close', stop);
  return stop;
}

function saveHistoryEntry(req, sessionId, question, result) {
  return saveQuery({
    sessionId: req.user?.id || sessionId,
    userId: req.user?.id,
    question,
    sql: result.sql,
    result: { rows: result.rows, rowCount: result.rowCount, duration: result.duration },
    insight: result.insight?.summary || '',
    chartType: result.chartType,
  });
}

function withHistoryMeta(result, historyEntry, extra = {}) {
  return {
    ...result,
    ...extra,
    historyId: historyEntry.id,
    timestamp: new Date().toISOString(),
  };
}

function rememberResult(question, dbType, result) {
  void setCachedQuery(question, dbType, result);
}

function replayCachedSse(res, cached, lookupMs) {
  const steps = [{ agent: 'cache', status: 'done', duration: lookupMs }];
  sendSse(res, 'step', { steps });
  return { ...cached, cached: true, totalDuration: lookupMs, steps };
}

// POST /api/agent/query — full multi-agent pipeline (JSON or SSE stream)
router.post('/agent/query', requireQueryAccess, async (req, res) => {
  const inputError = validateQueryInput(req.body);
  if (inputError) return res.status(400).json(inputError);

  const { question, sessionId = 'default', history = [], dbType = 'postgresql', stream = false } = req.body;

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Content-Encoding', 'identity');
    res.flushHeaders?.();

    const stopKeepAlive = startSseKeepAlive(req, res);
    try {
      const cacheStarted = Date.now();
      const cached = await getCachedQuery(question, dbType);
      if (cached) {
        const lookupMs = Date.now() - cacheStarted;
        const result = replayCachedSse(res, cached, lookupMs);
        const historyEntry = saveHistoryEntry(req, sessionId, question, result);
        sendSse(res, 'done', withHistoryMeta(result, historyEntry, { cached: true }));
        return res.end();
      }

      const result = await runAgentPipeline(question, {
        sessionId,
        conversationHistory: history,
        dbType,
        onEvent: (event, data) => sendSse(res, event, data),
      });

      rememberResult(question, dbType, result);
      const historyEntry = saveHistoryEntry(req, sessionId, question, result);

      sendSse(res, 'done', withHistoryMeta(result, historyEntry));
      return res.end();
    } catch (err) {
      console.error('Agent pipeline error:', err);
      sendSse(res, 'error', { success: false, error: err.message });
      return res.end();
    } finally {
      stopKeepAlive();
    }
  }

  try {
    const cacheStarted = Date.now();
    const cached = await getCachedQuery(question, dbType);
    if (cached) {
      const lookupMs = Date.now() - cacheStarted;
      const result = {
        ...cached,
        cached: true,
        totalDuration: lookupMs,
        steps: [{ agent: 'cache', status: 'done', duration: lookupMs }],
      };
      const historyEntry = saveHistoryEntry(req, sessionId, question, result);
      return res.json(withHistoryMeta(result, historyEntry, { cached: true }));
    }

    const result = await runAgentPipeline(question, {
      sessionId,
      conversationHistory: history,
      dbType,
    });

    rememberResult(question, dbType, result);
    const historyEntry = saveHistoryEntry(req, sessionId, question, result);

    return res.json(withHistoryMeta(result, historyEntry));
  } catch (err) {
    console.error('Agent pipeline error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/schema
router.get('/schema', requireQueryAccess, async (req, res) => {
  try {
    const dbType = req.query.dbType || 'postgresql';
    if (
      schemaCache.data &&
      schemaCache.dbType === dbType &&
      Date.now() - schemaCache.ts < SCHEMA_TTL_MS
    ) {
      return res.json({
        schema: schemaCache.data,
        tableCount: Object.keys(schemaCache.data).length,
        cached: true,
      });
    }
    const schema = await getDatabaseSchema(dbType);
    schemaCache.data = schema;
    schemaCache.ts = Date.now();
    schemaCache.dbType = dbType;
    res.json({ schema, tableCount: Object.keys(schema).length });
  } catch (err) {
    res.status(500).json({ error: 'Schema fetch failed: ' + err.message });
  }
});

// GET /api/history
router.get('/history', optionalAuth, (req, res) => {
  const { sessionId, limit = 30 } = req.query;
  const id = req.user?.id || sessionId || 'default';
  res.json({ history: getHistory(id, parseInt(limit)) });
});

// DELETE /api/history
router.delete('/history', optionalAuth, (req, res) => {
  clearHistory(req.user?.id || req.query.sessionId);
  res.json({ success: true });
});

// GET /api/suggestions — returns instantly (static/cache); AI refresh is background-only
router.get('/suggestions', async (req, res) => {
  try {
    const suggestions = await getSuggestedQuestions();
    res.json({ suggestions });
  } catch {
    res.json({ suggestions: [] });
  }
});

// GET /api/health
router.get('/health', async (req, res) => {
  const dbOk = await testConnection();
  let docStats = { documentCount: 0, chunkCount: 0, docTypes: [] };
  try {
    docStats = await getDocumentStats();
  } catch {
    // RAG tables/extension may not be migrated yet — health check shouldn't fail because of that
  }
  res.json({
    status: dbOk ? 'ok' : 'degraded',
    database: dbOk ? 'connected' : 'disconnected',
    redis: getRedisStatus(),
    documents: docStats,
    timestamp: new Date().toISOString(),
    version: '2.0.0',
  });
});

export default router;
