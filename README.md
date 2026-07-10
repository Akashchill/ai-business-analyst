# 🤖 AI Business Analytics Assistant v2

Full-stack AI analytics platform with **5-agent pipeline**, RAG, role-based auth, saved reports, and scheduled emails.

---

## ✨ Feature Set

| Feature | Details |
|---|---|
| **5-Agent Pipeline** | Planner → SQL → RAG → Visualization → Insight |
| **RAG Document Search** | Upload PDFs/docs, combine with DB queries |
| **Structured AI Insights** | Summary, key findings, recommendations |
| **Dashboard Generation** | Auto chart selection per query type |
| **Saved Reports** | Bookmark any result, revisit anytime |
| **Scheduled Email Reports** | Cron-based, HTML + CSV attachments |
| **Role-Based Auth** | Admin / Manager / Analyst with JWT |
| **Multi-DB Support** | PostgreSQL + MySQL abstraction |
| **Query History** | Per-user, with status + row count |
| **Schema Browser** | Live introspection, FK/PK highlighted |
| **SQL Inspector** | View generated SQL per response |
| **CSV Export** | One-click download |

---

## 🗂 Project Structure

```
ai-analytics/
├── backend/
│   └── src/
│       ├── agents/
│       │   └── orchestrator.js      # 5-agent pipeline
│       ├── config/
│       │   └── database.js          # PostgreSQL + MySQL pool
│       ├── middleware/
│       │   └── auth.js              # JWT + role guards
│       ├── routes/
│       │   ├── analytics.js         # /api/agent/query, /schema, /history
│       │   ├── auth.js              # /api/auth/login, /me, /register
│       │   ├── docs.js              # /api/docs (RAG upload)
│       │   └── reports.js           # /api/reports + scheduling
│       └── services/
│           ├── aiService.js         # Question suggestions
│           ├── authService.js       # JWT + bcrypt + user store
│           ├── historyService.js    # Query history
│           ├── ragService.js        # PDF ingestion, BM25 + Claude re-ranking
│           ├── reportService.js     # Save/list/update reports
│           └── schedulerService.js  # node-cron + nodemailer
│
└── frontend/
    └── src/
        ├── app/
        │   ├── page.tsx             # Main chat interface
        │   ├── login/page.tsx       # Login with demo buttons
        │   ├── documents/page.tsx   # Upload + manage RAG docs
        │   └── reports/page.tsx     # Saved reports + scheduling UI
        ├── components/
        │   ├── chat/
        │   │   ├── MessageBubble.tsx    # Message + chart + SQL + insight
        │   │   └── SuggestionChips.tsx
        │   ├── charts/
        │   │   └── ChartRenderer.tsx   # Bar/line/pie/table/number
        │   ├── insights/
        │   │   └── InsightCard.tsx     # Structured insight display
        │   └── layout/
        │       └── Sidebar.tsx         # History + schema + nav
        ├── hooks/
        │   └── useAuth.tsx             # Auth context + localStorage
        └── lib/
            └── api.ts                  # Full typed API client
```

---

## 🚀 Quick Start

### 1. Install & configure

```bash
cd backend
cp .env.example .env
# Fill in ANTHROPIC_API_KEY + DB credentials
npm install
npm run dev       # Starts on :3001
```

```bash
cd frontend
npm install
npm run dev       # Starts on :3000
```

### 2. Default login accounts

| Email | Password | Role |
|---|---|---|
| admin@company.com | admin123 | Admin (all access) |
| manager@company.com | manager123 | Manager (query + upload + schedule) |
| analyst@company.com | analyst123 | Analyst (query + view reports) |

---

## 🔌 API Reference

### Agent Query
```
POST /api/agent/query
Body: { question, history?, dbType? }
Response: { sql, rows, chartType, insight: { summary, keyFindings, recommendations }, ragAnswer, steps }
```

### Auth
```
POST /api/auth/login          { email, password }
GET  /api/auth/me             (Bearer token)
POST /api/auth/register       (admin only)
```

### Documents (RAG)
```
POST   /api/docs/upload       multipart/form-data (file, docType)
GET    /api/docs              list all documents
GET    /api/docs/:id/download presigned URL for original file (5 min expiry)
DELETE /api/docs/:id          remove document
```

### Reports
```
POST   /api/reports           save a report
GET    /api/reports           list accessible reports
DELETE /api/reports/:id       delete
POST   /api/reports/:id/schedule  { cron, emails, format }
```

---

## 🤖 Agent Pipeline

```
User Question
     ↓
┌─────────────────────────────────────────────────────┐
│  🧠 Planner Agent                                    │
│  → needsSQL? needsDocuments? questionType?           │
└──────────────────┬──────────────────────────────────┘
                   ↓ (parallel)
        ┌──────────┴──────────┐
   🗄️ SQL Agent          📚 RAG Agent
   → generates SQL        → BM25 + Claude re-rank
   → executes query        → synthesizes doc answer
        └──────────┬──────────┘
                   ↓
        📊 Visualization Agent
        → selects chart type + config
                   ↓
        💡 Insight Agent
        → summary + key findings + recommendations
```

---

## 📧 Email Scheduling

Configure SMTP in .env, then schedule any saved report:

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASS=your-app-password   # Gmail App Password, not login password
```

Cron examples: `0 9 * * 1` = every Monday 9am, `0 9 * * *` = every day 9am

---

## 📦 Document storage (S3)

Original uploaded files (PDF, TXT, MD) can be stored in a **private AWS S3 bucket** while text chunks and embeddings remain in PostgreSQL (pgvector).

### Required env vars

```env
S3_ENABLED=true
AWS_REGION=ap-south-1
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
S3_BUCKET_NAME=your-bucket-name
S3_PREFIX=documents/
```

Set `S3_ENABLED=false` to disable S3 — RAG ingestion still works, but originals cannot be downloaded.

### Bucket & IAM

- The bucket must be **private** (no public ACL or bucket policy allowing anonymous reads).
- Access is only via short-lived presigned URLs from `GET /api/docs/:id/download`.
- IAM policy for the app user needs at minimum:
  - `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` on `arn:aws:s3:::your-bucket-name/documents/*`

### Migration

Run `npm run db:migrate` in `backend/` to apply `003_rag_documents_s3.sql` (adds `s3_bucket`, `s3_key`, `file_size_bytes` to `rag_documents`).

### Legacy documents

Documents uploaded before S3 was enabled have no `s3_key` and return **404 — Original file not available** on download. RAG search over their chunks is unaffected.

---

## 🛡 Security

- JWT authentication, 7-day expiry
- Role + permission guards on query and schema routes (`canQuery`; set `ALLOW_ANONYMOUS_QUERY=true` to opt out)
- **SQL guard** (`utils/sqlGuard.js`): code-level validation before execution — SELECT-only, keyword blocklist, single-statement check, LIMIT cap (auto-appended up to 500 rows), optional table allowlist; up to 2 LLM retries on validation/DB errors
- **RAG grounding**: answers must cite uploaded document filenames; low-similarity chunks rejected
- **Insight guardrails**: prompts forbid inventing metrics; `outputGuard.js` trims/sanitizes LLM output
- Input limits: question 2000 chars, history 20 messages
- Use a **read-only DB user** for analytics queries in production (see `.env.example`); RAG/pgvector storage may need separate write grants
- Rate limiting: 30 queries/min (query), 10/min (auth)
- File size limit: 20MB per document upload
