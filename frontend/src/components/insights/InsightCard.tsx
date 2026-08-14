'use client';
import { TrendingUp, TrendingDown, AlertTriangle, CheckCircle, Lightbulb, Target, BookOpen, Zap } from 'lucide-react';
import { InsightReport, AgentStep, severityBg, severityColor } from '@/lib/api';

interface InsightCardProps {
  insight: InsightReport;
  ragAnswer?: string | null;
  ragSources?: string[];
  steps?: AgentStep[];
  totalDuration?: number;
  streaming?: boolean;
}

const severityIcon = (s?: string) => {
  if (s === 'positive') return <TrendingUp size={16} className="text-emerald-400" />;
  if (s === 'warning') return <AlertTriangle size={16} className="text-amber-400" />;
  if (s === 'critical') return <TrendingDown size={16} className="text-red-400" />;
  return <CheckCircle size={16} className="text-slate-400" />;
};

const agentIcon: Record<string, string> = {
  intent: '🎯', chat: '💬', planner: '🧠', sql: '🗄️', rag: '📚', visualization: '📊', insight: '💡',
};

export default function InsightCard({ insight, ragAnswer, ragSources, steps, totalDuration, streaming }: InsightCardProps) {
  if (!insight) return null;

  return (
    <div className="space-y-3 animate-slide-up">
      {/* Executive summary */}
      {insight.summary && (
        <div className={`border rounded-xl p-4 ${severityBg(insight.severity)}`}>
          <div className="flex items-start gap-3">
            <div className="mt-0.5">{severityIcon(insight.severity)}</div>
            <div className="flex-1">
              <p className={`text-sm font-medium leading-relaxed ${severityColor(insight.severity)}`}>
                {insight.summary}
                {streaming && (
                  <span className="inline-block w-1.5 h-4 ml-0.5 bg-indigo-400 animate-pulse align-middle" />
                )}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Key findings */}
      {insight.keyFindings?.length > 0 && (
        <div className="bg-slate-800/60 border border-slate-700/50 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <Zap size={13} className="text-indigo-400" />
            <span className="text-xs text-slate-400 uppercase tracking-widest font-medium">Key Findings</span>
          </div>
          <ul className="space-y-2">
            {insight.keyFindings.map((f, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-slate-300">
                <span className="w-5 h-5 rounded-full bg-indigo-600/20 text-indigo-400 text-[10px] flex items-center justify-center flex-shrink-0 mt-0.5 font-mono">
                  {i + 1}
                </span>
                {f}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Recommendations */}
      {insight.recommendations?.length > 0 && (
        <div className="bg-slate-800/60 border border-slate-700/50 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <Target size={13} className="text-emerald-400" />
            <span className="text-xs text-slate-400 uppercase tracking-widest font-medium">Recommended Actions</span>
          </div>
          <ul className="space-y-2">
            {insight.recommendations.map((r, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-slate-300">
                <span className="text-emerald-500 flex-shrink-0 mt-0.5">→</span>
                {r}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* RAG document findings */}
      {ragAnswer && (
        <div className="bg-cyan-500/5 border border-cyan-500/20 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <BookOpen size={13} className="text-cyan-400" />
            <span className="text-xs text-cyan-400 uppercase tracking-widest font-medium">From Documents</span>
          </div>
          <p className="text-sm text-slate-300 leading-relaxed">{ragAnswer}</p>
          {ragSources && ragSources.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {ragSources.map(s => (
                <span key={s} className="text-[10px] bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 px-2 py-0.5 rounded-full">
                  {s}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Agent pipeline trace */}
      {steps && steps.length > 0 && (
        <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-3">
          <p className="text-[10px] text-slate-600 uppercase tracking-widest mb-2">
            Agent Pipeline · {totalDuration ? `${totalDuration}ms total` : ''}
          </p>
          <div className="flex items-center gap-1 flex-wrap">
            {steps.map((step, i) => (
              <span key={i} className="flex items-center gap-1">
                <span className="text-[11px] bg-slate-800 border border-slate-700 px-2 py-0.5 rounded-full text-slate-400">
                  {agentIcon[step.agent] || '⚙️'} {step.agent}
                  {step.duration ? ` ${step.duration}ms` : ''}
                </span>
                {i < steps.length - 1 && <span className="text-slate-700">›</span>}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
