import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

import analyticsRouter from './routes/analytics.js';
import authRouter from './routes/auth.js';
import docsRouter from './routes/docs.js';
import reportsRouter from './routes/reports.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Security
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));

// Rate limiting per-route
const queryLimiter = rateLimit({ windowMs: 60_000, max: 30, message: { error: 'Too many requests.' } });
const authLimiter  = rateLimit({ windowMs: 60_000, max: 10, message: { error: 'Too many auth attempts.' } });

// Body parsing
app.use(express.json({ limit: '2mb' }));

// Ensure uploads dir
const uploadsDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Routes
app.use('/api/auth',    authLimiter, authRouter);
app.use('/api',         queryLimiter, analyticsRouter);
app.use('/api/docs',    docsRouter);
app.use('/api/reports', reportsRouter);

// 404
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`\n🚀 AI Analytics v2 running on http://localhost:${PORT}`);
  console.log(`📊 Health:  GET /api/health`);
  console.log(`🔐 Auth:    POST /api/auth/login`);
  console.log(`🤖 Query:   POST /api/agent/query\n`);
});

export default app;
