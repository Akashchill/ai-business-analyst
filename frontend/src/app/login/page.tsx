'use client';
import { useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { BarChart3, Loader2, Eye, EyeOff } from 'lucide-react';

const DEMO_ACCOUNTS = [
  { label: 'Admin', email: 'admin@company.com', password: 'admin123', color: 'text-red-400' },
  { label: 'Manager', email: 'manager@company.com', password: 'manager123', color: 'text-amber-400' },
  { label: 'Analyst', email: 'analyst@company.com', password: 'analyst123', color: 'text-emerald-400' },
];

export default function LoginPage() {
  const { login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      await login(email, password);
      router.push('/');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  function fillDemo(acc: typeof DEMO_ACCOUNTS[0]) {
    setEmail(acc.email); setPassword(acc.password); setError('');
  }

  return (
    <div className="min-h-screen bg-surface-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-indigo-600 flex items-center justify-center mb-4 shadow-lg shadow-indigo-500/25">
            <BarChart3 size={28} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white">AI Analytics</h1>
          <p className="text-slate-500 text-sm mt-1">Business Intelligence Platform</p>
        </div>

        {/* Demo accounts */}
        <div className="mb-6 bg-slate-800/50 border border-slate-700 rounded-xl p-4">
          <p className="text-xs text-slate-500 mb-3 uppercase tracking-widest">Quick Demo Login</p>
          <div className="flex gap-2">
            {DEMO_ACCOUNTS.map(acc => (
              <button
                key={acc.label}
                onClick={() => fillDemo(acc)}
                className="flex-1 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 hover:border-slate-600 transition-all text-xs font-medium"
              >
                <span className={acc.color}>{acc.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
          {error && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-sm text-red-400">
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs text-slate-400 mb-1.5 uppercase tracking-widest">Email</label>
            <input
              type="email" value={email} onChange={e => setEmail(e.target.value)} required
              className="w-full bg-slate-800 border border-slate-700 focus:border-indigo-500 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500/50 transition-all"
              placeholder="you@company.com"
            />
          </div>

          <div>
            <label className="block text-xs text-slate-400 mb-1.5 uppercase tracking-widest">Password</label>
            <div className="relative">
              <input
                type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} required
                className="w-full bg-slate-800 border border-slate-700 focus:border-indigo-500 rounded-xl px-4 py-2.5 pr-10 text-sm text-white placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500/50 transition-all"
                placeholder="••••••••"
              />
              <button type="button" onClick={() => setShowPw(!showPw)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300">
                {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>

          <button
            type="submit" disabled={loading}
            className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-xl text-sm font-semibold text-white transition-all shadow-lg hover:shadow-indigo-500/25 flex items-center justify-center gap-2"
          >
            {loading && <Loader2 size={15} className="animate-spin" />}
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        {/* Role legend */}
        <div className="mt-4 grid grid-cols-3 gap-2">
          {[
            { role: 'Admin', perms: 'All access + manage users', color: 'border-red-500/20 bg-red-500/5' },
            { role: 'Manager', perms: 'Query + upload + schedule', color: 'border-amber-500/20 bg-amber-500/5' },
            { role: 'Analyst', perms: 'Query + view reports', color: 'border-emerald-500/20 bg-emerald-500/5' },
          ].map(r => (
            <div key={r.role} className={`border rounded-lg p-2 ${r.color}`}>
              <p className="text-xs font-semibold text-white">{r.role}</p>
              <p className="text-[10px] text-slate-500 mt-0.5">{r.perms}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
