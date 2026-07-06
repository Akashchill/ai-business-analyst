import express from 'express';
import { runAgentPipeline } from '../agents/orchestrator.js';
import { getDatabaseSchema, testConnection } from '../config/database.js';
import { saveQuery, getHistory, clearHistory } from '../services/historyService.js';
import { getSuggestedQuestions } from '../services/aiService.js';
import { getDocumentStats } from '../services/ragService.js';
import { optionalAuth, requireQueryAccess } from '../middleware/auth.js';

const router = express.Router();

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

// POST /api/agent/query — full multi-agent pipeline
router.post('/agent/query', requireQueryAccess, async (req, res) => {
  const inputError = validateQueryInput(req.body);
  if (inputError) return res.status(400).json(inputError);

  const { question, sessionId = 'default', history = [], dbType = 'postgresql' } = req.body;

  try {
    const result = await runAgentPipeline(question, {
      sessionId,
      conversationHistory: history,
      dbType,
    });

    // Save to history
    const historyEntry = saveQuery({
      sessionId: req.user?.id || sessionId,
      userId: req.user?.id,
      question,
      sql: result.sql,
      result: { rows: result.rows, rowCount: result.rowCount, duration: result.duration },
      insight: result.insight?.summary || '',
      chartType: result.chartType,
    });

    return res.json({ ...result, historyId: historyEntry.id, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('Agent pipeline error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/schema
router.get('/schema', requireQueryAccess, async (req, res) => {
  try {
    const schema = await getDatabaseSchema(req.query.dbType || 'postgresql');
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

// GET /api/suggestions
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
    documents: docStats,
    timestamp: new Date().toISOString(),
    version: '2.0.0',
  });
});

export default router;
