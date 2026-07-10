'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useRouter } from 'next/navigation';
import { Upload, FileText, Trash2, BookOpen, Loader2, ArrowLeft, AlertCircle, Download } from 'lucide-react';
import { listDocuments, uploadDocument, deleteDocument, getDocumentDownloadUrl, Document } from '@/lib/api';

const DOC_TYPES = ['annual_report', 'sop', 'product_docs', 'meeting_notes', 'financial', 'general'];

export default function DocumentsPage() {
  const { user, token } = useAuth();
  const router = useRouter();
  const [docs, setDocs] = useState<Document[]>([]);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [docType, setDocType] = useState('general');
  const [dragOver, setDragOver] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!token) { router.push('/login'); return; }
    load();
  }, [token]);

  async function load() {
    setLoading(true);
    const data = await listDocuments(token!);
    setDocs(data);
    setLoading(false);
  }

  async function handleUpload(file: File) {
    if (!token) return;
    setUploading(true); setError('');
    try {
      await uploadDocument(file, docType, token);
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Remove this document from the knowledge base?')) return;
    await deleteDocument(id, token!);
    setDocs(d => d.filter(doc => doc.id !== id));
  }

  async function handleDownload(doc: Document) {
    if (!token || !doc.hasOriginalFile) return;
    setDownloadingId(doc.id);
    setError('');
    try {
      const { downloadUrl, filename } = await getDocumentDownloadUrl(doc.id, token);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = filename;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Download failed');
    } finally {
      setDownloadingId(null);
    }
  }

  const canUpload = user?.permissions?.canUploadDocs;

  return (
    <div className="min-h-screen bg-surface-950 p-6">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <button onClick={() => router.push('/')} className="text-slate-500 hover:text-white transition-colors">
            <ArrowLeft size={18} />
          </button>
          <div>
            <h1 className="text-xl font-bold text-white flex items-center gap-2">
              <BookOpen size={20} className="text-cyan-400" /> Document Knowledge Base
            </h1>
            <p className="text-sm text-slate-500 mt-0.5">Upload docs to combine with database queries</p>
          </div>
        </div>

        {/* Upload zone */}
        {canUpload ? (
          <div
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if(f) handleUpload(f); }}
            onClick={() => fileRef.current?.click()}
            className={`border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-all mb-6 ${
              dragOver ? 'border-indigo-500 bg-indigo-500/10' : 'border-slate-700 hover:border-slate-600 bg-slate-900/50'
            }`}
          >
            <input ref={fileRef} type="file" accept=".pdf,.txt,.md" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if(f) handleUpload(f); }} />
            {uploading ? (
              <div className="flex flex-col items-center gap-2">
                <Loader2 size={32} className="text-indigo-400 animate-spin" />
                <p className="text-sm text-slate-400">Processing document…</p>
              </div>
            ) : (
              <>
                <Upload size={32} className="mx-auto mb-3 text-slate-500" />
                <p className="text-white font-medium">Drop a file here or click to upload</p>
                <p className="text-sm text-slate-500 mt-1">PDF, TXT, MD — up to 20MB</p>
                <div className="mt-4 flex items-center justify-center gap-3">
                  <select value={docType} onChange={e => setDocType(e.target.value)}
                    onClick={e => e.stopPropagation()}
                    className="bg-slate-800 border border-slate-700 text-sm text-slate-300 rounded-lg px-3 py-1.5 focus:outline-none">
                    {DOC_TYPES.map(t => <option key={t} value={t}>{t.replace('_',' ')}</option>)}
                  </select>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2 bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3 mb-6 text-sm text-amber-400">
            <AlertCircle size={15} /> Your role ({user?.role}) cannot upload documents.
          </div>
        )}

        {error && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 text-sm text-red-400 mb-4">{error}</div>
        )}

        {/* Document list */}
        <div className="space-y-2">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-slate-400 uppercase tracking-widest">
              {docs.length} Document{docs.length !== 1 ? 's' : ''} Indexed
            </h2>
          </div>
          {loading ? (
            <div className="text-center py-8 text-slate-600"><Loader2 size={20} className="mx-auto animate-spin" /></div>
          ) : docs.length === 0 ? (
            <div className="text-center py-12 text-slate-600">
              <BookOpen size={36} className="mx-auto mb-3 opacity-30" />
              <p>No documents yet. Upload one to enable RAG queries.</p>
            </div>
          ) : docs.map(doc => (
            <div key={doc.id} className="flex items-start gap-3 bg-slate-900 border border-slate-800 rounded-xl p-4 hover:border-slate-700 transition-colors">
              <FileText size={20} className="text-cyan-400 flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-white truncate">{doc.filename}</p>
                <div className="flex items-center gap-3 mt-1 text-xs text-slate-500">
                  <span className="bg-slate-800 px-2 py-0.5 rounded-full border border-slate-700">{doc.docType}</span>
                  <span>{doc.chunkCount} chunks</span>
                  <span>{(doc.characterCount / 1000).toFixed(0)}K chars</span>
                  <span>{new Date(doc.uploadedAt).toLocaleDateString()}</span>
                </div>
                <p className="text-xs text-slate-600 mt-1.5 truncate">{doc.preview}</p>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                {doc.hasOriginalFile ? (
                  <button
                    onClick={() => handleDownload(doc)}
                    disabled={downloadingId === doc.id}
                    title="Download original file"
                    className="text-slate-600 hover:text-cyan-400 transition-colors disabled:opacity-50 p-1"
                  >
                    {downloadingId === doc.id ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
                  </button>
                ) : (
                  <span title="Original not stored" className="text-slate-700 p-1 cursor-not-allowed">
                    <Download size={15} />
                  </span>
                )}
                {canUpload && (
                  <button onClick={() => handleDelete(doc.id)}
                    className="text-slate-600 hover:text-red-400 transition-colors p-1">
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
