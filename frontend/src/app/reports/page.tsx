'use client';
import { useState, useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useRouter } from 'next/navigation';
import { BookmarkCheck, Trash2, Calendar, ArrowLeft, Clock, Rows3, BarChart3, Download, Loader2 } from 'lucide-react';
import { listReports, deleteReport, scheduleReport, exportToCSV, Report, severityBg, severityColor } from '@/lib/api';
import ChartRenderer from '@/components/charts/ChartRenderer';

const CRON_PRESETS = [
  { label: 'Daily 9am', cron: '0 9 * * *' },
  { label: 'Mon 8am', cron: '0 8 * * 1' },
  { label: 'Monthly 1st', cron: '0 9 1 * *' },
];

export default function ReportsPage() {
  const { user, token } = useAuth();
  const router = useRouter();
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [scheduleModal, setScheduleModal] = useState<Report | null>(null);
  const [scheduleForm, setScheduleForm] = useState({ cron: '0 9 * * 1', emails: '', format: 'csv' });
  const [scheduling, setScheduling] = useState(false);
  const [scheduleError, setScheduleError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (!token) { router.push('/login'); return; }
    load();
  }, [token]);

  async function load() {
    setLoading(true);
    const data = await listReports(token!);
    setReports(data);
    setLoading(false);
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this report?')) return;
    await deleteReport(id, token!);
    setReports(r => r.filter(rep => rep.id !== id));
  }

  async function handleSchedule() {
    if (!scheduleModal || !token) return;
    const emails = scheduleForm.emails.split(',').map(e => e.trim()).filter(Boolean);
    if (!emails.length) { setScheduleError('At least one email required'); return; }
    setScheduling(true); setScheduleError('');
    try {
      await scheduleReport(scheduleModal.id, { cron: scheduleForm.cron, emails, format: scheduleForm.format }, token);
      setScheduleModal(null);
      alert('Report scheduled! Emails will be sent automatically.');
    } catch (e: unknown) {
      setScheduleError(e instanceof Error ? e.message : 'Schedule failed');
    } finally {
      setScheduling(false);
    }
  }

  const canSchedule = user?.permissions?.canScheduleReports;

  return (
    <div className="min-h-screen bg-surface-950 p-6">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <button onClick={() => router.push('/')} className="text-slate-500 hover:text-white transition-colors">
            <ArrowLeft size={18} />
          </button>
          <div>
            <h1 className="text-xl font-bold text-white flex items-center gap-2">
              <BookmarkCheck size={20} className="text-indigo-400" /> Saved Reports
            </h1>
            <p className="text-sm text-slate-500 mt-0.5">Save, revisit, and schedule your analytics</p>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-16"><Loader2 size={24} className="animate-spin text-slate-600" /></div>
        ) : reports.length === 0 ? (
          <div className="text-center py-16 text-slate-600">
            <BookmarkCheck size={40} className="mx-auto mb-3 opacity-20" />
            <p>No saved reports yet.</p>
            <p className="text-sm mt-1">Save a query result from the chat to see it here.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {reports.map(report => (
              <div key={report.id} className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden hover:border-slate-700 transition-colors">
                <div className="p-4 flex items-start gap-3">
                  <BarChart3 size={18} className="text-indigo-400 flex-shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-white">{report.name}</p>
                    <p className="text-xs text-slate-500 mt-0.5 truncate">{report.question}</p>
                    <div className="flex items-center gap-3 mt-2 text-xs text-slate-600">
                      <span className="flex items-center gap-1"><Rows3 size={10} />{report.rowCount} rows</span>
                      <span className="flex items-center gap-1"><Clock size={10} />{new Date(report.createdAt).toLocaleDateString()}</span>
                      {report.isPublic && <span className="text-indigo-400 border border-indigo-500/30 px-1.5 py-0.5 rounded-full bg-indigo-500/10">Public</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button onClick={() => exportToCSV(report.rows, `${report.name}.csv`)}
                      className="p-1.5 text-slate-600 hover:text-slate-300 transition-colors" title="Export CSV">
                      <Download size={15} />
                    </button>
                    {canSchedule && (
                      <button onClick={() => setScheduleModal(report)}
                        className="p-1.5 text-slate-600 hover:text-indigo-400 transition-colors" title="Schedule email">
                        <Calendar size={15} />
                      </button>
                    )}
                    <button onClick={() => setExpanded(expanded === report.id ? null : report.id)}
                      className="px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition-colors">
                      {expanded === report.id ? 'Close' : 'View'}
                    </button>
                    <button onClick={() => handleDelete(report.id)}
                      className="p-1.5 text-slate-600 hover:text-red-400 transition-colors">
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>

                {expanded === report.id && (
                  <div className="border-t border-slate-800 p-4 space-y-4 animate-fade-in">
                    {report.rows.length > 0 && (
                      <ChartRenderer type={report.chartType as 'bar'|'line'|'pie'|'table'|'number'} rows={report.rows} config={report.chartConfig} />
                    )}
                    {report.insight?.summary && (
                      <div className={`border rounded-xl p-4 ${severityBg(report.insight.severity)}`}>
                        <p className={`text-sm ${severityColor(report.insight.severity)}`}>{report.insight.summary}</p>
                        {report.insight.keyFindings?.length > 0 && (
                          <ul className="mt-3 space-y-1">
                            {report.insight.keyFindings.map((f, i) => (
                              <li key={i} className="text-xs text-slate-400 flex gap-2"><span className="text-indigo-500">•</span>{f}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Schedule Modal */}
      {scheduleModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-md">
            <h3 className="font-semibold text-white mb-1">Schedule Email Report</h3>
            <p className="text-sm text-slate-500 mb-4">{scheduleModal.name}</p>

            <div className="space-y-4">
              <div>
                <label className="text-xs text-slate-400 mb-1.5 block uppercase tracking-widest">Frequency</label>
                <div className="flex gap-2 mb-2">
                  {CRON_PRESETS.map(p => (
                    <button key={p.cron} onClick={() => setScheduleForm(f => ({...f, cron: p.cron}))}
                      className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
                        scheduleForm.cron === p.cron ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-600'
                      }`}>{p.label}</button>
                  ))}
                </div>
                <input value={scheduleForm.cron} onChange={e => setScheduleForm(f=>({...f,cron:e.target.value}))}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-indigo-500" placeholder="cron expression" />
              </div>

              <div>
                <label className="text-xs text-slate-400 mb-1.5 block uppercase tracking-widest">Recipients (comma-separated)</label>
                <input value={scheduleForm.emails} onChange={e => setScheduleForm(f=>({...f,emails:e.target.value}))}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                  placeholder="alice@co.com, bob@co.com" />
              </div>

              <div>
                <label className="text-xs text-slate-400 mb-1.5 block uppercase tracking-widest">Format</label>
                <select value={scheduleForm.format} onChange={e => setScheduleForm(f=>({...f,format:e.target.value}))}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none">
                  <option value="csv">HTML + CSV Attachment</option>
                  <option value="html">HTML Only</option>
                </select>
              </div>

              {scheduleError && <p className="text-sm text-red-400">{scheduleError}</p>}
            </div>

            <div className="flex gap-2 mt-6">
              <button onClick={() => setScheduleModal(null)}
                className="flex-1 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-sm transition-colors">
                Cancel
              </button>
              <button onClick={handleSchedule} disabled={scheduling}
                className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-sm font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
                {scheduling && <Loader2 size={13} className="animate-spin" />}
                {scheduling ? 'Scheduling…' : 'Schedule Report'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
