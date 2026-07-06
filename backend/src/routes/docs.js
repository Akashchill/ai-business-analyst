import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { ingestDocument, listDocuments, deleteDocument, getDocumentStats } from '../services/ragService.js';

const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(process.cwd(), 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'text/plain', 'text/markdown', 'application/octet-stream'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(file.mimetype) || ['.pdf', '.txt', '.md'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, TXT, and MD files are allowed'));
    }
  },
});

// POST /api/docs/upload
router.post('/upload', authenticate, requirePermission('canUploadDocs'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  try {
    const doc = await ingestDocument({
      filePath: req.file.path,
      filename: req.file.originalname,
      mimetype: req.file.mimetype,
      uploadedBy: req.user.id,
      docType: req.body.docType || 'general',
    });

    // Clean up temp file after ingestion
    fs.unlink(req.file.path, () => {});

    res.status(201).json({ document: doc });
  } catch (err) {
    fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: 'Ingestion failed: ' + err.message });
  }
});

// GET /api/docs
router.get('/', authenticate, async (req, res) => {
  try {
    const [documents, stats] = await Promise.all([listDocuments(), getDocumentStats()]);
    res.json({ documents, stats });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list documents: ' + err.message });
  }
});

// DELETE /api/docs/:id
router.delete('/:id', authenticate, requirePermission('canUploadDocs'), async (req, res) => {
  try {
    const result = await deleteDocument(req.params.id);
    if (!result.existed) return res.status(404).json({ error: 'Document not found' }); 
    res.json({ success: true, chunksRemoved: result.chunksRemoved });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete document: ' + err.message });
  }
});

// GET /api/docs/stats
router.get('/stats', authenticate, async (req, res) => {
  try {
    res.json(await getDocumentStats());
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats: ' + err.message });
  }
});

export default router;
