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
import { prewarmSuggestionCache } from './services/aiService.js';
import { logDatabaseStatus } from './config/database.js';
import { connectRedis } from './config/redis.js';

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

const server = app.listen(PORT, async () => {
  console.log(`\n🚀 AI Analytics v2 running on http://localhost:${PORT}`);
  console.log(`📊 Health:  GET /api/health`);
  console.log(`🔐 Auth:    POST /api/auth/login`);
  console.log(`🤖 Query:   POST /api/agent/query`);
  console.log(`🧠 Model:   ${process.env.AI_PROVIDER || 'google'} / ${process.env.AI_MODEL || 'gemini-2.5-flash'}\n`);
  await logDatabaseStatus();
  await connectRedis();
  // Non-blocking: warm AI suggestions cache after startup
  setTimeout(() => prewarmSuggestionCache(), 2000);
});

// SSE agent streams can run longer than Node's default 5-minute request timeout.
server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;

export default app;
