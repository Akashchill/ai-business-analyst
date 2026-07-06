import { v4 as uuidv4 } from 'uuid';
const store = new Map();
const MAX = 500;

export function saveQuery({ sessionId, userId, question, sql, result, insight, chartType, error }) {
  const id = uuidv4();
  const entry = {
    id, sessionId: userId || sessionId, question, sql,
    rowCount: result?.rowCount || 0, insight, chartType,
    error: error || null, timestamp: new Date().toISOString(), duration: result?.duration || 0,
  };
  store.set(id, entry);
  if (store.size > MAX) store.delete(store.keys().next().value);
  return entry;
}

export function getHistory(sessionId, limit = 30) {
  return [...store.values()]
    .filter(e => !sessionId || e.sessionId === sessionId)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, limit);
}

export function clearHistory(sessionId) {
  if (sessionId) { for (const [id, e] of store) if (e.sessionId === sessionId) store.delete(id); }
  else store.clear();
}
