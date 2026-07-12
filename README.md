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

---

## 🐳 Docker deployment

Images are built on every push to `main` and published to [GitHub Container Registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry) (GHCR).

| Image | GHCR path |
|---|---|
| Backend | `ghcr.io/<owner>/<repo>/backend:latest` |
| Frontend | `ghcr.io/<owner>/<repo>/frontend:latest` |

Replace `<owner>/<repo>` with your GitHub repository (e.g. `ghcr.io/myorg/ai/backend:latest`).

### Pull and run

**Do not bake secrets into images.** Pass configuration at runtime with environment variables or a secrets manager. Never `COPY .env` into a Dockerfile or commit `.env` to git.

```bash
# Log in to GHCR (use a PAT with read:packages if the repo is private)
echo "$GITHUB_TOKEN" | docker login ghcr.io -u USERNAME --password-stdin

docker pull ghcr.io/<owner>/<repo>/backend:latest
docker pull ghcr.io/<owner>/<repo>/frontend:latest

# Backend — mount env file or pass -e flags (example uses env file on the host only)
docker run -d --name ai-backend -p 3001:3001 \
  --env-file backend/.env \
  ghcr.io/<owner>/<repo>/backend:latest

# Frontend — NEXT_PUBLIC_API_URL is baked in at image build time (see build-arg below)
docker run -d --name ai-frontend -p 3000:3000 \
  ghcr.io/<owner>/<repo>/frontend:latest
```

When both containers share a Docker network, point the frontend rewrite target at the backend service name, e.g. `NEXT_PUBLIC_API_URL=http://ai-backend:3001` (set as a **build-arg** when building the frontend image).

### Required runtime environment (backend)

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default `3001`) |
| `FRONTEND_URL` | CORS origin for the UI (e.g. `https://analytics.example.com`) |
| `GEMINI_API_KEY` | AI provider key (or `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` per `AI_PROVIDER`) |
| `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | PostgreSQL (required for RAG + analytics) |
| `JWT_SECRET` | Auth signing secret (use a strong value in production) |
| `S3_*`, `AWS_*` | Optional document storage (see [Document storage](#-document-storage-s3)) |
| `SMTP_*` | Optional scheduled email reports |

See `backend/.env.example` for the full list. Copy it to `backend/.env` locally only — **never commit `.env`**.

### Frontend build-time variable

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_API_URL` | Backend URL used by Next.js `/api` rewrites (default `http://localhost:3001`) |

In GitHub Actions, set repository variable `NEXT_PUBLIC_API_URL` to your production API URL before builds, or rely on the workflow default for local/dev images.

### Build locally

```bash
docker build -t ai-analytics-backend ./backend
docker build --build-arg NEXT_PUBLIC_API_URL=http://localhost:3001 -t ai-analytics-frontend ./frontend
```

### CI workflow

`.github/workflows/docker-publish.yml` builds and pushes both images to GHCR using `GITHUB_TOKEN`. No registry secrets are required for public packages on the same repo. For private repos, grant `packages: write` (already in the workflow) and use `read:packages` when pulling.

### Migrations

Run database migrations before or after starting the backend container:

```bash
docker run --rm --env-file backend/.env \
  --entrypoint node \
  ghcr.io/<owner>/<repo>/backend:latest \
  scripts/migrate.js
```
