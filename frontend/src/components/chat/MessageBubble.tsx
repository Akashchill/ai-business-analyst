'use client';
import { useState } from 'react';
import dynamic from 'next/dynamic';
import { Download, Code2, ChevronDown, ChevronUp, Clock, Rows3, BookmarkPlus, Check } from 'lucide-react';
import InsightCard from '@/components/insights/InsightCard';
import { AgentResult, highlightSQL, exportToCSV, saveReport } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';

const ChartRenderer = dynamic(() => import('@/components/charts/ChartRenderer'), {
  ssr: false,
  loading: () => (
    <div className="h-48 rounded-xl bg-slate-800/60 animate-pulse" />
  ),
});

interface MessageProps {
  role: 'user' | 'assistant';
  content?: string;
  result?: AgentResult;
  loading?: boolean;
}

export default function MessageBubble({ role, content, result, loading }: MessageProps) {
  const { token } = useAuth();
  const [showSQL, setShowSQL] = useState(false);
  const [showTable, setShowTable] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  if (role === 'user') {
    return (
      <div className="flex justify-end mb-4 animate-fade-in">
        <div className="max-w-xl bg-indigo-600 text-white rounded-2xl rounded-tr-sm px-4 py-3 text-sm leading-relaxed shadow-lg">
          {content}
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex gap-3 mb-4 animate-fade-in">
        <div className="w-8 h-8 rounded-full bg-indigo-900 border border-indigo-700 flex items-center justify-center flex-shrink-0 mt-1">
          <span className="text-xs">🤖</span>
        </div>
        <div className="bg-slate-800 border border-slate-700 rounded-2xl rounded-tl-sm px-4 py-4">
          <div className="flex gap-2 items-center mb-1">
            <div className="flex gap-1">
              <span className="typing-dot" /><span className="typing-dot" /><span className="typing-dot" />
            </div>
            <span className="text-xs text-slate-500 animate-pulse">Running agent pipeline…</span>
          </div>
        </div>
      </div>
    );
  }

  if (!result) return null;

  const isDirectReply = result.responseMode === 'direct' || result.responseMode === 'declined';
  const hasChart = result.success && !isDirectReply && result.rows.length > 0 && result.chartType !== 'table';
  const hasTable = result.success && !isDirectReply && result.rows.length > 0;

  async function handleSave() {
    if (!token || !result || saved) return;
    setSaving(true);
    try {
      const name = result.question.slice(0, 60);
      await saveReport({ name, question: result.question, result, isPublic: false }, token);
      setSaved(true);
    } catch (e) { console.error(e); }
    finally { setSaving(false); }
  }

  return (
    <div className="flex gap-3 mb-5 animate-slide-up">
      <div className="w-8 h-8 rounded-full bg-indigo-900 border border-indigo-700 flex items-center justify-center flex-shrink-0 mt-1">
        <span className="text-xs">🤖</span>
      </div>

      <div className="flex-1 min-w-0 space-y-2">
        {/* Error */}
        {!result.success && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 text-sm text-red-400">
            ⚠️ {result.error || 'Could not process this question.'}
          </div>
        )}

        {/* Chart */}
        {hasChart && (
          <div className="bg-slate-800/80 border border-slate-700 rounded-2xl overflow-hidden">
            {result.chartConfig?.title && (
              <div className="px-4 pt-3 pb-1">
                <p className="text-xs text-slate-400 font-medium">{result.chartConfig.title}</p>
              </div>
            )}
            <div className="px-2 py-2">
              <ChartRenderer type={result.chartType} rows={result.rows} config={result.chartConfig} />
            </div>
            {/* Stats row */}
            <div className="flex items-center gap-4 px-4 py-2 border-t border-slate-700/50 text-xs text-slate-500">
              <span className="flex items-center gap-1"><Rows3 size={11} />{result.rowCount.toLocaleString()} rows</span>
              {result.duration > 0 && <span className="flex items-center gap-1"><Clock size={11} />{result.duration}ms</span>}
              <div className="flex-1" />
              {hasTable && (
                <button onClick={() => exportToCSV(result.rows, 'query_result.csv')}
                  className="flex items-center gap-1 hover:text-slate-300 transition-colors">
                  <Download size={11} /> Export CSV
                </button>
              )}
              {token && (
                <button onClick={handleSave} disabled={saving || saved}
                  className="flex items-center gap-1 hover:text-indigo-400 transition-colors disabled:opacity-50">
                  {saved ? <Check size={11} className="text-emerald-400" /> : <BookmarkPlus size={11} />}
                  {saved ? 'Saved' : saving ? 'Saving…' : 'Save'}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Insight Card */}
        {result.success && result.insight && (
          <InsightCard
            insight={result.insight}
            ragAnswer={result.ragAnswer}
            ragSources={result.ragSources}
            steps={result.steps}
            totalDuration={result.totalDuration}
          />
        )}

        {/* SQL accordion */}
        {result.sql && (
          <div>
            <button onClick={() => setShowSQL(!showSQL)}
              className="flex items-center gap-1.5 text-xs text-slate-600 hover:text-slate-300 transition-colors px-1">
              <Code2 size={12} />{showSQL ? 'Hide' : 'View'} SQL
              {showSQL ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
            {showSQL && (
              <div className="mt-1 bg-slate-900 border border-slate-700 rounded-xl p-4 font-mono text-xs leading-6 overflow-x-auto animate-fade-in">
                <pre className="text-slate-300 whitespace-pre-wrap"
                  dangerouslySetInnerHTML={{ __html: highlightSQL(result.sql) }} />
              </div>
            )}
          </div>
        )}

        {/* Raw table toggle */}
        {hasChart && hasTable && (
          <div>
            <button onClick={() => setShowTable(!showTable)}
              className="flex items-center gap-1.5 text-xs text-slate-600 hover:text-slate-300 transition-colors px-1">
              <Rows3 size={12} />{showTable ? 'Hide' : 'View'} raw table
              {showTable ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
            {showTable && (
              <div className="mt-1 bg-slate-900 border border-slate-700 rounded-xl overflow-hidden animate-fade-in">
                <ChartRenderer type="table" rows={result.rows} />
              </div>
            )}
          </div>
        )}

        {/* Table-only result */}
        {!hasChart && hasTable && (
          <div className="bg-slate-900 border border-slate-700 rounded-xl overflow-hidden">
            <ChartRenderer type="table" rows={result.rows} />
            <div className="flex items-center gap-3 px-4 py-2 border-t border-slate-800 text-xs text-slate-600">
              <span>{result.rowCount.toLocaleString()} rows</span>
              <div className="flex-1" />
              <button onClick={() => exportToCSV(result.rows, 'query.csv')}
                className="flex items-center gap-1 hover:text-slate-300 transition-colors">
                <Download size={11} /> Export CSV
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
