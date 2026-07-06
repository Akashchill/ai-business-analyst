import { v4 as uuidv4 } from 'uuid';
const reports = new Map();

export function saveReport({ name, description, question, result, createdBy, isPublic = false }) {
  const id = uuidv4();
  const report = {
    id, name, description: description || '', question,
    sql: result.sql, rows: result.rows, rowCount: result.rowCount,
    chartType: result.chartType, chartConfig: result.chartConfig,
    insight: result.insight, createdBy, isPublic,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  reports.set(id, report);
  return report;
}

export function listReports(userId, role) {
  return [...reports.values()]
    .filter(r => r.isPublic || r.createdBy === userId || role === 'admin' || role === 'manager')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export function getReport(id) { return reports.get(id) || null; }
export function updateReport(id, u) {
  const r = reports.get(id); if (!r) return null;
  const updated = { ...r, ...u, updatedAt: new Date().toISOString() };
  reports.set(id, updated); return updated;
}
export function deleteReport(id) { return reports.delete(id); }
