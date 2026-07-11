import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { authenticate, requirePermission } from '../middleware/auth.js';
import {
  ingestDocument, listDocuments, deleteDocument, getDocumentStats, getDocumentForDownload,
} from '../services/ragService.js';
import * as s3Service from '../services/s3Service.js';

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
    const allowedMimes = [
      'application/pdf',
      'text/plain',
      'text/markdown',
      'application/octet-stream',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ];
    const allowedExts = ['.pdf', '.txt', '.md', '.doc', '.docx', '.xls', '.xlsx'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedMimes.includes(file.mimetype) || allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, TXT, MD, Word (.doc/.docx), and Excel (.xls/.xlsx) files are allowed'));
    }
  },
});

// POST /api/docs/upload
router.post('/upload', authenticate, requirePermission('canUploadDocs'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const docId = uuidv4();
  let s3Key = null;
  let s3Bucket = null;
  let s3Uploaded = false;

  try {
    if (s3Service.isEnabled()) {
      s3Service.assertConfigured();
      s3Key = s3Service.buildObjectKey(docId, req.file.originalname);
      const uploaded = await s3Service.uploadFile({
        bufferOrPath: req.file.path,
        key: s3Key,
        contentType: req.file.mimetype,
      });
      s3Bucket = uploaded.bucket;
      s3Uploaded = true;
    }

    const doc = await ingestDocument({
      id: docId,
      filePath: req.file.path,
      filename: req.file.originalname,
      mimetype: req.file.mimetype,
      uploadedBy: req.user.id,
      docType: req.body.docType || 'general',
      s3Bucket,
      s3Key,
      fileSizeBytes: req.file.size,
    });

    fs.unlink(req.file.path, () => {});

    res.status(201).json({ document: doc });
  } catch (err) {
    if (s3Uploaded && s3Key) {
      try {
        await s3Service.deleteFile(s3Key, s3Bucket || undefined);
      } catch (rollbackErr) {
        console.error('S3 rollback failed after ingest error:', rollbackErr.message);
      }
    }
    fs.unlink(req.file.path, () => {});

    const message = err.message?.includes('S3 is enabled')
      ? err.message
      : `Ingestion failed: ${err.message}`;
    res.status(500).json({ error: message });
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

// GET /api/docs/:id/download
router.get('/:id/download', authenticate, async (req, res) => {
  try {
    const doc = await getDocumentForDownload(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (!doc.s3Key) {
      return res.status(404).json({ error: 'Original file not available' });
    }

    const { downloadUrl, expiresIn } = await s3Service.getPresignedDownloadUrl(
      doc.s3Key,
      doc.filename,
      300,
      doc.s3Bucket || undefined
    );

    res.json({ downloadUrl, filename: doc.filename, expiresIn });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate download URL: ' + err.message });
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
