'use client';
import { useState, useEffect, useRef, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { Send, BarChart3, RefreshCw, PanelLeftClose, PanelLeftOpen, LogIn } from 'lucide-react';
import MessageBubble from '@/components/chat/MessageBubble';
import { useAuth } from '@/hooks/useAuth';
import { agentQueryStream, fetchSuggestions, AgentResult, AuthError } from '@/lib/api';

const Sidebar = dynamic(() => import('@/components/layout/Sidebar'), {
  ssr: false,
  loading: () => (
    <aside className="w-64 bg-slate-900 border-r border-slate-800 flex-shrink-0 animate-pulse" />
  ),
});

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content?: string;
  result?: AgentResult;
  loading?: boolean;
  streaming?: boolean;
}

function emptyStreamingResult(question: string): AgentResult {
  return {
    success: true,
    question,
    sql: null,
    sqlExplanation: null,
    rows: [],
    rowCount: 0,
    duration: 0,
    chartType: 'table',
    ragAnswer: null,
    ragSources: [],
    steps: [],
    totalDuration: 0,
    insight: { summary: '', keyFindings: [], recommendations: [], severity: 'neutral' },
  };
}

function mergeAgentResult(prev: AgentResult, next: Partial<AgentResult>): AgentResult {
  return {
    ...prev,
    ...next,
    insight: next.insight ? { ...prev.insight, ...next.insight } : prev.insight,
    ragAnswer: next.ragAnswer ?? prev.ragAnswer,
    ragSources: next.ragSources?.length ? next.ragSources : prev.ragSources,
    rows: next.rows ?? prev.rows,
    steps: next.steps?.length ? next.steps : prev.steps,
    chartConfig: next.chartConfig !== undefined ? next.chartConfig : prev.chartConfig,
  };
}

const STARTER_QUESTIONS = [
  'How many users are there?',
  'What is total revenue this month?',
  'Show top 10 customers by spend',
  'What are monthly sales trends this year?',
];

export default function HomePage() {
  const { user, token, loading: authLoading } = useAuth();
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>(STARTER_QUESTIONS);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const historyRef = useRef<{ role: string; content: string }[]>([]);

  // Load AI suggestions in background after idle — never block first paint
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchSuggestions()
        .then(s => { if (!cancelled && s.length) setSuggestions(s); })
        .catch(() => {});
    };
    let idleId: number | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      idleId = window.requestIdleCallback(load, { timeout: 3000 });
    } else {
      timeoutId = setTimeout(load, 2500);
    }
    return () => {
      cancelled = true;
      if (idleId != null && 'cancelIdleCallback' in window) window.cancelIdleCallback(idleId);
      if (timeoutId != null) clearTimeout(timeoutId);
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = useCallback(async (question: string) => {
    const q = question.trim();
    if (!q || isLoading) return;

    if (!token) {
      router.push('/login');
      return;
    }

    setInput('');
    const uid = `u_${Date.now()}`;
    const aid = `a_${Date.now()}`;

    setMessages(prev => [
      ...prev,
      { id: uid, role: 'user', content: q },
      { id: aid, role: 'assistant', loading: true },
    ]);
    setIsLoading(true);

    const priorHistory = historyRef.current.slice(-8);
    historyRef.current = [...priorHistory, { role: 'user', content: q }];

    try {
      const result = await agentQueryStream(q, token, priorHistory, (evt) => {
        setMessages(prev => prev.map(m => {
          if (m.id !== aid) return m;

          if (evt.event === 'step') {
            const partial = m.result ?? emptyStreamingResult(q);
            return {
              ...m,
              loading: true,
              streaming: true,
              result: { ...partial, steps: evt.data.steps },
            };
          }

          if (evt.event === 'partial') {
            const partial = m.result ?? emptyStreamingResult(q);
            return { ...m, loading: true, streaming: true, result: mergeAgentResult(partial, evt.data) };
          }

          if (evt.event === 'insight') {
            const partial = m.result ?? emptyStreamingResult(q);
            return {
              ...m,
              loading: true,
              streaming: true,
              result: {
                ...partial,
                insight: { ...partial.insight, ...evt.data },
              },
            };
          }

          if (evt.event === 'token') {
            const partial = m.result ?? emptyStreamingResult(q);
            if (evt.data.field === 'rag') {
              return {
                ...m,
                loading: true,
                streaming: true,
                result: {
                  ...partial,
                  ragAnswer: (partial.ragAnswer || '') + evt.data.text,
                },
              };
            }
            return {
              ...m,
              loading: true,
              streaming: true,
              result: {
                ...partial,
                insight: {
                  ...partial.insight,
                  summary: (partial.insight?.summary || '') + evt.data.text,
                },
              },
            };
          }

          return m;
        }));
      });

      setMessages(prev => prev.map(m => m.id === aid ? { ...m, loading: false, streaming: false, result } : m));
      historyRef.current = [...historyRef.current, { role: 'assistant', content: result.insight?.summary || '' }];
      setRefreshKey(k => k + 1);
    } catch (err: unknown) {
      if (err instanceof AuthError && err.status === 401) {
        router.push('/login');
        return;
      }
      const errResult: AgentResult = {
        success: false, question: q, sql: null, sqlExplanation: null,
        rows: [], rowCount: 0, duration: 0, chartType: 'table',
        ragAnswer: null, ragSources: [], steps: [], totalDuration: 0,
        insight: { summary: '', keyFindings: [], recommendations: [], severity: 'neutral' },
        error: err instanceof Error ? err.message : 'Something went wrong',
      };
      setMessages(prev => prev.map(m => m.id === aid ? { ...m, loading: false, streaming: false, result: errResult } : m));
    } finally {
      setIsLoading(false);
      inputRef.current?.focus();
    }
  }, [isLoading, token, router]);

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(input); }
  }

  const isEmpty = messages.length === 0;

  return (
    <div className="flex h-screen bg-surface-950 overflow-hidden">
      {sidebarOpen && (
        <Sidebar onSelectHistory={q => { setInput(q); inputRef.current?.focus(); }} refreshKey={refreshKey} />
      )}

      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="flex items-center gap-3 px-4 py-3 border-b border-slate-800 bg-slate-900/80 backdrop-blur-sm">
          <button onClick={() => setSidebarOpen(!sidebarOpen)} className="text-slate-500 hover:text-slate-300 transition-colors">
            {sidebarOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
          </button>
          <div className="w-7 h-7 rounded-lg bg-indigo-600 flex items-center justify-center">
            <BarChart3 size={14} className="text-white" />
          </div>
          <div>
            <span className="text-sm font-semibold text-white">AI Analytics</span>
            <span className="text-xs text-slate-500 ml-2 hidden sm:inline">Business Intelligence</span>
          </div>
          <div className="flex-1" />
          {authLoading ? (
            <span className="text-xs text-slate-600 flex items-center gap-1.5">
              <RefreshCw size={11} className="animate-spin" /> …
            </span>
          ) : !user ? (
            <button onClick={() => router.push('/login')}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs rounded-lg transition-colors">
              <LogIn size={13} /> Sign in
            </button>
          ) : (
            <span className="text-xs text-slate-500">{user.name}</span>
          )}
        </header>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {isEmpty ? (
            <div className="flex flex-col items-center justify-center h-full text-center gap-5 max-w-lg mx-auto">
              <div className="w-16 h-16 rounded-2xl bg-indigo-600/20 border border-indigo-600/30 flex items-center justify-center">
                <BarChart3 size={30} className="text-indigo-400" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-white mb-2">Ask your data anything</h1>
                <p className="text-sm text-slate-500 leading-relaxed">
                  Powered by a 5-agent AI pipeline: Planner → SQL → RAG → Visualization → Insight.
                  {!user && !authLoading && <><br/><span className="text-indigo-400 cursor-pointer" onClick={() => router.push('/login')}>Sign in</span> to ask questions and use analytics.</>}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2 w-full">
                {suggestions.slice(0, 4).map(q => (
                  <button key={q} onClick={() => handleSubmit(q)}
                    className="text-left text-xs p-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 hover:border-indigo-600 transition-all">
                    {q}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              {messages.map(msg => (
                <MessageBubble key={msg.id} role={msg.role} content={msg.content} result={msg.result} loading={msg.loading} streaming={msg.streaming} />
              ))}
              <div ref={bottomRef} />
            </>
          )}
        </div>

        {/* Input */}
        <div className="px-4 py-3 border-t border-slate-800 bg-slate-900/50">
          <div className="flex gap-2 items-end max-w-4xl mx-auto">
            <textarea
              ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKey}
              placeholder={user ? 'Ask anything about your data…' : 'Sign in to ask questions…'}
              rows={1} disabled={isLoading || !user}
              className="flex-1 bg-slate-800 border border-slate-700 focus:border-indigo-500 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-500 resize-none focus:outline-none focus:ring-1 focus:ring-indigo-500/50 transition-all"
              style={{ minHeight: 48, maxHeight: 160 }}
              onInput={e => { const t = e.currentTarget; t.style.height='auto'; t.style.height=Math.min(t.scrollHeight,160)+'px'; }}
            />
            <button onClick={() => handleSubmit(input)} disabled={!input.trim() || isLoading || !user}
              className="w-12 h-12 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-all shadow-lg hover:shadow-indigo-500/25 flex-shrink-0">
              {isLoading ? <RefreshCw size={15} className="text-white animate-spin" /> : <Send size={15} className="text-white" />}
            </button>
          </div>
          <p className="text-center text-[10px] text-slate-700 mt-1.5">Enter to send · Shift+Enter for new line</p>
        </div>
      </div>
    </div>
  );
}
