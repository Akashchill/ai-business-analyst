export class AuthError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'AuthError';
  }
}

/** Relative base so requests go through Next.js rewrites (/api → backend). */
const API_BASE = '';

const DEFAULT_TIMEOUT_MS = 5000;

/** Shared fetch with AbortController timeout (default 5s). */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) throw new AuthError(data.error || 'Please sign in to continue', 401);
    if (res.status === 403) throw new AuthError(data.error || 'You do not have permission for this action', 403);
    throw new Error(data.error || 'Request failed');
  }
  return data as T;
}

export interface User {
  id: string; email: string; name: string; role: 'admin' | 'manager' | 'analyst';
  permissions: Record<string, boolean>;
}

export async function login(email: string, password: string): Promise<{ token: string; user: User }> {
  const res = await fetchWithTimeout(`${API_BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error((await res.json()).error || 'Login failed');
  return res.json();
}

export async function getMe(token: string): Promise<User> {
  const res = await fetchWithTimeout(`${API_BASE}/api/auth/me`, { headers: authHeader(token) });
  if (!res.ok) throw new Error('Unauthorized');
  const data = await res.json();
  return data.user;
}

export function authHeader(token?: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ── Agent Query ───────────────────────────────────────────────────────────────

export interface InsightReport {
  summary: string;
  keyFindings: string[];
  trends?: string;
  recommendations: string[];
  severity: 'positive' | 'neutral' | 'warning' | 'critical';
  confidence?: number;
}

export interface AgentStep {
  agent: string; status: string; duration?: number;
}

export interface AgentResult {
  success: boolean;
  question: string;
  intent?: 'greeting' | 'analytics_sql' | 'company_documents' | 'general_business' | 'out_of_scope';
  responseMode?: 'direct' | 'analytics' | 'declined';
  plan?: { needsSQL: boolean; needsDocuments: boolean; complexity: string; questionType: string };
  sql: string | null;
  sqlExplanation: string | null;
  rows: Record<string, unknown>[];
  rowCount: number;
  fields?: { name: string }[];
  duration: number;
  chartType: 'bar' | 'line' | 'pie' | 'table' | 'number';
  chartConfig?: { xKey: string; yKey: string; title: string };
  ragAnswer: string | null;
  ragSources: string[];
  ragConfidence?: number;
  sqlRetries?: number;
  insight: InsightReport;
  steps: AgentStep[];
  totalDuration: number;
  historyId?: string;
  timestamp?: string;
  error?: string;
}

export async function agentQuery(
  question: string,
  token?: string | null,
  history: { role: string; content: string }[] = [],
  dbType = 'postgresql'
): Promise<AgentResult> {
  const res = await fetchWithTimeout(`${API_BASE}/api/agent/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader(token) },
    body: JSON.stringify({ question, history, dbType }),
  }, 60_000);
  return handleResponse<AgentResult>(res);
}

export type AgentStreamEvent =
  | { event: 'step'; data: { steps: AgentStep[] } }
  | { event: 'partial'; data: Partial<AgentResult> }
  | { event: 'insight'; data: Partial<InsightReport> }
  | { event: 'token'; data: { text: string; field?: 'rag' } }
  | { event: 'done'; data: AgentResult }
  | { event: 'error'; data: { error: string } };

function parseSseChunk(buffer: string): { events: AgentStreamEvent[]; rest: string } {
  const events: AgentStreamEvent[] = [];
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';

  for (const part of parts) {
    if (!part.trim()) continue;
    let event = 'message';
    let data = '';
    for (const line of part.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7).trim();
      else if (line.startsWith('data: ')) data += line.slice(6);
    }
    if (!data) continue;
    try {
      events.push({ event, data: JSON.parse(data) } as AgentStreamEvent);
    } catch {
      // skip malformed chunk
    }
  }

  return { events, rest };
}

/** Stream agent pipeline via SSE — calls onEvent for each update, returns final result. */
export async function agentQueryStream(
  question: string,
  token: string | null | undefined,
  history: { role: string; content: string }[] = [],
  onEvent: (event: AgentStreamEvent) => void,
  dbType = 'postgresql',
): Promise<AgentResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);

  try {
    const res = await fetch(`${API_BASE}/api/agent/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(token) },
      body: JSON.stringify({ question, history, dbType, stream: true }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) throw new AuthError(data.error || 'Please sign in to continue', 401);
      if (res.status === 403) throw new AuthError(data.error || 'You do not have permission for this action', 403);
      throw new Error(data.error || 'Request failed');
    }

    if (!res.body) throw new Error('Streaming not supported');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalResult: AgentResult | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseChunk(buffer);
      buffer = parsed.rest;

      for (const evt of parsed.events) {
        onEvent(evt);
        if (evt.event === 'done') finalResult = evt.data;
        if (evt.event === 'error') throw new Error(evt.data.error || 'Stream failed');
      }
    }

    if (!finalResult) throw new Error('Stream ended without a result');
    return finalResult;
  } finally {
    clearTimeout(timer);
  }
}

// ── Documents ─────────────────────────────────────────────────────────────────

export interface Document {
  id: string; filename: string; docType: string; uploadedAt: string;
  chunkCount: number; characterCount: number; preview: string;
  fileSizeBytes?: number | null;
  hasOriginalFile?: boolean;
  downloadAvailable?: boolean;
}

export async function uploadDocument(file: File, docType: string, token: string): Promise<Document> {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('docType', docType);
  const res = await fetchWithTimeout(`${API_BASE}/api/docs/upload`, {
    method: 'POST', headers: authHeader(token), body: fd,
  }, 60_000);
  if (!res.ok) throw new Error((await res.json()).error || 'Upload failed');
  const data = await res.json();
  return data.document;
}

export async function listDocuments(token: string): Promise<Document[]> {
  const res = await fetchWithTimeout(`${API_BASE}/api/docs`, { headers: authHeader(token) });
  if (!res.ok) return [];
  const data = await res.json();
  return data.documents;
}

export async function deleteDocument(id: string, token: string): Promise<void> {
  await fetchWithTimeout(`${API_BASE}/api/docs/${id}`, { method: 'DELETE', headers: authHeader(token) });
}

export async function getDocumentDownloadUrl(
  id: string,
  token: string
): Promise<{ downloadUrl: string; filename: string; expiresIn?: number }> {
  const res = await fetchWithTimeout(`${API_BASE}/api/docs/${id}/download`, { headers: authHeader(token) });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Download failed');
  }
  return res.json();
}

// ── Reports ───────────────────────────────────────────────────────────────────

export interface Report {
  id: string; name: string; description: string; question: string;
  sql: string | null; rows: Record<string, unknown>[];
  rowCount: number; chartType: string; chartConfig?: { xKey: string; yKey: string; title: string };
  insight: InsightReport; isPublic: boolean; createdBy: string;
  createdAt: string; updatedAt: string;
}

export async function saveReport(data: Partial<Report> & { name: string; result: AgentResult }, token: string): Promise<Report> {
  const res = await fetchWithTimeout(`${API_BASE}/api/reports`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader(token) },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error((await res.json()).error || 'Save failed');
  return (await res.json()).report;
}

export async function listReports(token: string): Promise<Report[]> {
  const res = await fetchWithTimeout(`${API_BASE}/api/reports`, { headers: authHeader(token) });
  if (!res.ok) return [];
  return (await res.json()).reports;
}

export async function deleteReport(id: string, token: string): Promise<void> {
  await fetchWithTimeout(`${API_BASE}/api/reports/${id}`, { method: 'DELETE', headers: authHeader(token) });
}

export async function scheduleReport(
  reportId: string,
  { cron, emails, format }: { cron: string; emails: string[]; format: string },
  token: string
) {
  const res = await fetchWithTimeout(`${API_BASE}/api/reports/${reportId}/schedule`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader(token) },
    body: JSON.stringify({ cron, emails, format }),
  });
  if (!res.ok) throw new Error((await res.json()).error || 'Schedule failed');
  return (await res.json()).schedule;
}

// ── History + Schema ──────────────────────────────────────────────────────────

export async function fetchHistory(token?: string | null) {
  const res = await fetchWithTimeout(`${API_BASE}/api/history?limit=30`, { headers: authHeader(token) });
  if (!res.ok) return [];
  return (await res.json()).history;
}

export async function fetchSuggestions(): Promise<string[]> {
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/suggestions`);
    return (await res.json()).suggestions || [];
  } catch { return []; }
}

export async function fetchSchema(token?: string | null) {
  const res = await fetchWithTimeout(`${API_BASE}/api/schema`, { headers: authHeader(token) });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      const data = await res.json().catch(() => ({}));
      throw new AuthError(data.error || 'Please sign in to continue', res.status);
    }
    return {};
  }
  return res.json();
}

export async function checkHealth() {
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/health`);
    return res.json();
  } catch { return { status: 'error', database: 'disconnected' }; }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

export function highlightSQL(sql: string): string {
  const kws = ['SELECT','FROM','WHERE','JOIN','LEFT','RIGHT','INNER','OUTER','ON','GROUP BY',
    'ORDER BY','HAVING','LIMIT','OFFSET','AS','AND','OR','NOT','IN','IS','NULL','LIKE',
    'BETWEEN','DISTINCT','COUNT','SUM','AVG','MAX','MIN','WITH','UNION','ALL','CASE',
    'WHEN','THEN','ELSE','END','INSERT','UPDATE','DELETE'];
  let h = sql;
  kws.forEach(kw => {
    h = h.replace(new RegExp(`\\b(${kw})\\b`, 'gi'), `<span class="sql-keyword">$1</span>`);
  });
  h = h.replace(/'([^']*)'/g, `<span class="sql-string">'$1'</span>`);
  h = h.replace(/\b(\d+)\b/g, `<span class="sql-number">$1</span>`);
  return h;
}

export function formatNumber(n: number): string {
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

export function exportToCSV(rows: Record<string, unknown>[], filename = 'export.csv') {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const csv = [
    headers.join(','),
    ...rows.map(row => headers.map(h => {
      const val = String(row[h] ?? '').replace(/"/g, '""');
      return val.includes(',') || val.includes('"') ? `"${val}"` : val;
    }).join(',')),
  ].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

export function severityColor(s?: string) {
  return s === 'positive' ? 'text-emerald-400' : s === 'warning' ? 'text-amber-400'
    : s === 'critical' ? 'text-red-400' : 'text-slate-300';
}

export function severityBg(s?: string) {
  return s === 'positive' ? 'bg-emerald-500/10 border-emerald-500/20'
    : s === 'warning' ? 'bg-amber-500/10 border-amber-500/20'
    : s === 'critical' ? 'bg-red-500/10 border-red-500/20'
    : 'bg-slate-800 border-slate-700';
}
