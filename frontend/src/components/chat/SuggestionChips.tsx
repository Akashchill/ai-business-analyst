'use client';
import { Sparkles } from 'lucide-react';

interface Props { suggestions: string[]; onSelect: (q: string) => void; }

export default function SuggestionChips({ suggestions, onSelect }: Props) {
  if (!suggestions.length) return null;
  return (
    <div className="px-4 py-3 border-t border-slate-800">
      <div className="flex items-center gap-1.5 mb-2">
        <Sparkles size={11} className="text-amber-400" />
        <span className="text-[10px] text-slate-600 uppercase tracking-widest">Try asking</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {suggestions.slice(0, 5).map((q, i) => (
          <button key={i} onClick={() => onSelect(q)}
            className="text-xs px-3 py-1.5 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white border border-slate-700 hover:border-indigo-600 transition-all">
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}
