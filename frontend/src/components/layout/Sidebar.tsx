'use client';
import { useState, useEffect } from 'react';
import { History, Database, Trash2, ChevronRight, TableProperties, Clock, CheckCircle2, XCircle, BookOpen, BookmarkCheck, LogOut, User, Shield } from 'lucide-react';
import { fetchHistory, fetchSchema, checkHealth } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';
import Link from 'next/link';

type Tab = 'history' | 'schema';

interface SidebarProps {
  onSelectHistory: (q: string) => void;
  refreshKey?: number;
}

export default function Sidebar({ onSelectHistory, refreshKey }: SidebarProps) {
  const { user, token, logout } = useAuth();
  const [tab, setTab] = useState<Tab>('history');
  const [history, setHistory] = useState<any[]>([]);
  const [schema, setSchema] = useState<any>({});
  const [expanded, setExpanded] = useState<string|null>(null);
  const [dbStatus, setDbStatus] = useState<string>('checking');

  useEffect(() => { loadHistory(); }, [token, refreshKey]);
  useEffect(() => {
    if (tab === 'schema' && !Object.keys(schema).length) loadSchema();
    if (tab === 'history') loadHistory();
  }, [tab]);
  useEffect(() => {
    checkHealth().then(h => setDbStatus(h.database));
  }, []);

  async function loadHistory() {
    const h = await fetchHistory(token);
    setHistory(h);
  }
  async function loadSchema() {
    const data = await fetchSchema(token);
    setSchema((data as any).schema || {});
  }

  function rel(iso: string) {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60_000) return 'now';
    if (diff < 3_600_000) return `${Math.floor(diff/60_000)}m`;
    if (diff < 86_400_000) return `${Math.floor(diff/3_600_000)}h`;
    return new Date(iso).toLocaleDateString();
  }

  const roleColor = user?.role === 'admin' ? 'text-red-400 bg-red-500/10 border-red-500/20'
    : user?.role === 'manager' ? 'text-amber-400 bg-amber-500/10 border-amber-500/20'
    : 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';

  return (
    <aside className="w-64 bg-slate-900 border-r border-slate-800 flex flex-col h-full">
      {/* User info */}
      {user && (
        <div className="p-3 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-indigo-900 border border-indigo-700 flex items-center justify-center flex-shrink-0">
              <User size={14} className="text-indigo-400" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-white truncate">{user.name}</p>
              <span className={`text-[10px] border px-1.5 py-0.5 rounded-full ${roleColor}`}>{user.role}</span>
            </div>
            <button onClick={logout} className="text-slate-600 hover:text-slate-300 transition-colors" title="Sign out">
              <LogOut size={13} />
            </button>
          </div>
        </div>
      )}

      {/* Nav links */}
      <div className="p-2 border-b border-slate-800 space-y-0.5">
        <Link href="/documents" className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-slate-800 text-xs text-slate-400 hover:text-white transition-colors">
          <BookOpen size={13} className="text-cyan-500" /> Documents
          {user?.permissions?.canUploadDocs && <Shield size={10} className="text-cyan-600 ml-auto" />}
        </Link>
        <Link href="/reports" className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-slate-800 text-xs text-slate-400 hover:text-white transition-colors">
          <BookmarkCheck size={13} className="text-indigo-500" /> Saved Reports
        </Link>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-800">
        {(['history','schema'] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-[11px] font-medium uppercase tracking-widest transition-colors ${
              tab === t ? 'text-indigo-400 border-b-2 border-indigo-500' : 'text-slate-600 hover:text-slate-300'
            }`}>
            {t === 'history' ? <History size={12} /> : <Database size={12} />}{t}
          </button>
        ))}
      </div>

      {/* History */}
      {tab === 'history' && (
        <div className="flex-1 overflow-y-auto">
          {history.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-slate-600">No queries yet.</div>
          ) : (
            <ul>
              {history.map((entry: any) => (
                <li key={entry.id}>
                  <button onClick={() => onSelectHistory(entry.question)}
                    className="w-full text-left px-3 py-2 hover:bg-slate-800 transition-colors group">
                    <div className="flex items-start gap-2">
                      {entry.error
                        ? <XCircle size={11} className="text-red-500 mt-0.5 flex-shrink-0" />
                        : <CheckCircle2 size={11} className="text-emerald-500 mt-0.5 flex-shrink-0" />}
                      <div className="min-w-0 flex-1">
                        <p className="text-[11px] text-slate-400 truncate group-hover:text-white">{entry.question}</p>
                        <div className="flex gap-2 mt-0.5 text-[10px] text-slate-600">
                          <span className="flex items-center gap-0.5"><Clock size={8} />{rel(entry.timestamp)}</span>
                          {!entry.error && <span>{entry.rowCount} rows</span>}
                        </div>
                      </div>
                      <ChevronRight size={10} className="text-slate-700 group-hover:text-slate-500 flex-shrink-0 mt-0.5" />
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Schema */}
      {tab === 'schema' && (
        <div className="flex-1 overflow-y-auto py-1">
          <div className={`mx-3 mb-2 text-[10px] flex items-center gap-1.5 px-2 py-1 rounded-md ${dbStatus === 'connected' ? 'text-emerald-400 bg-emerald-500/10' : 'text-red-400 bg-red-500/10'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${dbStatus === 'connected' ? 'bg-emerald-400' : 'bg-red-400'}`} />
            PostgreSQL {dbStatus}
          </div>
          {Object.entries(schema).map(([table, info]: any) => (
            <div key={table}>
              <button onClick={() => setExpanded(expanded === table ? null : table)}
                className="w-full flex items-center gap-2 px-3 py-2 hover:bg-slate-800 transition-colors">
                <TableProperties size={12} className="text-indigo-500 flex-shrink-0" />
                <span className="text-[11px] text-slate-300 flex-1 text-left">{table}</span>
                <span className="text-[9px] text-slate-600">{info.columns.length}</span>
                <ChevronRight size={10} className={`text-slate-700 transition-transform ${expanded === table ? 'rotate-90' : ''}`} />
              </button>
              {expanded === table && (
                <ul className="bg-slate-950/50 pb-1">
                  {info.columns.map((col: any) => (
                    <li key={col.name} className="flex items-center gap-2 px-5 py-0.5">
                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${col.isPrimaryKey ? 'bg-amber-400' : col.isForeignKey ? 'bg-cyan-400' : 'bg-slate-600'}`} />
                      <span className="text-[10px] text-slate-500 flex-1">{col.name}</span>
                      <span className="text-[9px] text-slate-700">{col.type}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
