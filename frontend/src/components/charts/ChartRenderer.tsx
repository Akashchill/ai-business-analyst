'use client';
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { formatNumber } from '@/lib/api';

const PALETTE = ['#6366f1','#22d3ee','#f59e0b','#10b981','#f43f5e','#a78bfa','#fb923c','#34d399'];
const tooltipStyle = {
  contentStyle: { background: '#1e293b', border: '1px solid #334155', borderRadius: 8, color: '#e2e8f0' },
  labelStyle: { color: '#94a3b8' }, itemStyle: { color: '#a5b4fc' },
};

interface ChartProps {
  type: 'bar' | 'line' | 'pie' | 'table' | 'number';
  rows: Record<string, unknown>[];
  config?: { xKey: string; yKey: string; title: string } | null;
}

export default function ChartRenderer({ type, rows, config }: ChartProps) {
  if (!rows?.length) return (
    <div className="flex items-center justify-center h-40 text-slate-500 text-sm">No data to display</div>
  );
  const keys = Object.keys(rows[0]);
  const xKey = config?.xKey || keys[0];
  const yKey = config?.yKey || keys[1] || keys[0];

  if (type === 'number') {
    const val = rows[0][yKey] ?? rows[0][keys[0]];
    const numVal = typeof val === 'number' ? val : parseFloat(String(val));
    return (
      <div className="flex flex-col items-center justify-center py-10">
        <div className="text-6xl font-bold text-indigo-400 tabular-nums">
          {isNaN(numVal) ? String(val) : formatNumber(numVal)}
        </div>
        <div className="mt-2 text-sm text-slate-400 uppercase tracking-widest">{yKey.replace(/_/g,' ')}</div>
      </div>
    );
  }

  if (type === 'table') {
    const cols = Object.keys(rows[0]);
    return (
      <div className="overflow-auto max-h-80 rounded-lg">
        <table className="data-table">
          <thead><tr>{cols.map(c => <th key={c}>{c.replace(/_/g,' ')}</th>)}</tr></thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>{cols.map(c => <td key={c}>{String(row[c] ?? '—')}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (type === 'pie') {
    const data = rows.slice(0, 8).map(r => ({ name: String(r[xKey]??''), value: parseFloat(String(r[yKey]??0)) }));
    return (
      <ResponsiveContainer width="100%" height={280}>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={100}
            label={({ name, percent }) => `${name} (${((percent ?? 0)*100).toFixed(0)}%)`} labelLine={false}>
            {data.map((_,i) => <Cell key={i} fill={PALETTE[i%PALETTE.length]} />)}
          </Pie>
          <Tooltip {...tooltipStyle} />
        </PieChart>
      </ResponsiveContainer>
    );
  }

  if (type === 'line') {
    return (
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={rows} margin={{ top:5, right:20, left:0, bottom:5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
          <XAxis dataKey={xKey} stroke="#475569" tick={{ fill:'#94a3b8', fontSize:11 }} />
          <YAxis stroke="#475569" tick={{ fill:'#94a3b8', fontSize:11 }} tickFormatter={v => formatNumber(Number(v))} />
          <Tooltip {...tooltipStyle} formatter={(v:unknown) => formatNumber(Number(v))} />
          <Legend wrapperStyle={{ color:'#94a3b8', fontSize:12 }} />
          <Line type="monotone" dataKey={yKey} stroke="#6366f1" strokeWidth={2} dot={{ fill:'#6366f1', r:3 }} activeDot={{ r:5 }} />
        </LineChart>
      </ResponsiveContainer>
    );
  }

  // bar
  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={rows} margin={{ top:5, right:20, left:0, bottom:5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
        <XAxis dataKey={xKey} stroke="#475569" tick={{ fill:'#94a3b8', fontSize:11 }} />
        <YAxis stroke="#475569" tick={{ fill:'#94a3b8', fontSize:11 }} tickFormatter={v => formatNumber(Number(v))} />
        <Tooltip {...tooltipStyle} formatter={(v:unknown) => formatNumber(Number(v))} />
        <Legend wrapperStyle={{ color:'#94a3b8', fontSize:12 }} />
        <Bar dataKey={yKey} fill="#6366f1" radius={[4,4,0,0]}>
          {rows.map((_,i) => <Cell key={i} fill={PALETTE[i%PALETTE.length]} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
