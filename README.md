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
S3_BUCKET_NAME=your-bucket-name
S3_PREFIX=documents/
```

On **ECS**, do **not** set `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`. The AWS SDK uses the **task IAM role** (short-lived credentials).

For **local/dev** only, you may optionally set:

```env
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
```

Set `S3_ENABLED=false` to disable S3 — RAG ingestion still works, but originals cannot be downloaded.

### Bucket & IAM

- The bucket must be **private** (no public ACL or bucket policy allowing anonymous reads).
- Access is only via short-lived presigned URLs from `GET /api/docs/:id/download`.
- Attach an IAM policy to the **ECS task role** (or local IAM user) with at minimum:
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

Images are built on every push to `main` and published to [Amazon ECR](https://aws.amazon.com/ecr/).

| Image | ECR path |
|---|---|
| Backend | `121973526737.dkr.ecr.ap-south-1.amazonaws.com/business-analyst-backend:latest` |
| Frontend | `121973526737.dkr.ecr.ap-south-1.amazonaws.com/business-analyst-frontend:latest` |

Repository prefix defaults to `business-analyst` (override with GitHub variable `ECR_REPOSITORY_PREFIX`).

### GitHub Actions → ECR (OIDC)

No long-lived AWS access keys. GitHub Actions assumes an IAM role via [OIDC](https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services).

#### 1. Create GitHub OIDC provider in AWS (once per account)

IAM → **Identity providers** → **Add provider**

| Field | Value |
|---|---|
| Provider type | OpenID Connect |
| Provider URL | `https://token.actions.githubusercontent.com` |
| Audience | `sts.amazonaws.com` |

#### 2. Create IAM role for GitHub Actions

IAM → **Roles** → **Create role** → **Web identity** → select the GitHub OIDC provider.

**Trust policy** (replace `ACCOUNT_ID`, `OWNER`, `REPO`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:OWNER/REPO:ref:refs/heads/main"
        }
      }
    }
  ]
}
```

To allow all branches: use `"repo:OWNER/REPO:*"` instead of the `ref:refs/heads/main` subject.

**Permissions policy** (attach to the role — ECR push + ECS redeploy):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:PutImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:DescribeRepositories",
        "ecr:CreateRepository"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ecs:UpdateService"
      ],
      "Resource": [
        "arn:aws:ecs:ap-south-1:121973526737:service/business-analyst/business-analyst-backend-service",
        "arn:aws:ecs:ap-south-1:121973526737:service/business-analyst/business-analyst-frontend-service"
      ]
    }
  ]
}
```

#### 3. GitHub repo configuration

The workflow assumes this IAM role via OIDC:

```
arn:aws:iam::121973526737:role/GitHubActionsECSDeployRole
```

Ensure the role **trust policy** allows this repository (see step 2) and that the role has the **ECR permissions** from step 2. The role name suggests ECS deploy — add ECR push permissions if they are not already attached.

**Settings → Secrets and variables → Actions** (optional overrides):

| Name | Type | Purpose |
|---|---|---|
| `AWS_REGION` | Variable | e.g. `ap-south-1` (default in workflow) |
| `ECR_REPOSITORY_PREFIX` | Variable | Optional; default `business-analyst` |
| `NEXT_PUBLIC_API_URL` | Variable | Optional; frontend build-time API URL |

No `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` secrets are required.

The workflow pushes to your existing ECR repos `business-analyst-backend` and `business-analyst-frontend` (creates them if missing).

### Pull and run

**Do not bake secrets into images.** Pass configuration at runtime with environment variables or a secrets manager. Never `COPY .env` into a Dockerfile or commit `.env` to git.

```bash
AWS_REGION=ap-south-1
AWS_ACCOUNT_ID=123456789012
ECR_REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$ECR_REGISTRY"

docker pull "${ECR_REGISTRY}/business-analyst-backend:latest"
docker pull "${ECR_REGISTRY}/business-analyst-frontend:latest"

# Backend — mount env file or pass -e flags (example uses env file on the host only)
docker run -d --name ai-backend -p 3001:3001 \
  --env-file backend/.env \
  "${ECR_REGISTRY}/business-analyst-backend:latest"

# Frontend — NEXT_PUBLIC_API_URL is baked in at image build time (see build-arg below)
docker run -d --name ai-frontend -p 3000:3000 \
  "${ECR_REGISTRY}/business-analyst-frontend:latest"
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
| `S3_ENABLED`, `S3_BUCKET_NAME`, `S3_PREFIX`, `AWS_REGION` | Optional S3 document storage (task role on ECS; no access keys needed) |
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

Tag and push to ECR manually:

```bash
aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin 123456789012.dkr.ecr.ap-south-1.amazonaws.com
docker tag ai-analytics-backend:latest 121973526737.dkr.ecr.ap-south-1.amazonaws.com/business-analyst-backend:latest
docker push 121973526737.dkr.ecr.ap-south-1.amazonaws.com/business-analyst-backend:latest
```

### CI workflows

Two separate GitHub Actions workflows deploy independently:

| Workflow | Triggers on | ECS service |
|----------|-------------|-------------|
| `docker-publish-backend.yml` | Changes in `backend/**` | `business-analyst-backend-service` |
| `docker-publish-frontend.yml` | Changes in `frontend/**` | `business-analyst-frontend-service` |

Each workflow builds and pushes its image to ECR, then runs `aws ecs update-service --force-new-deployment` for that service only. You can also trigger either workflow manually from the Actions tab (`workflow_dispatch`).

If both `backend/` and `frontend/` change in one commit, **both** workflows run.

### Migrations

Run database migrations before or after starting the backend container:

```bash
docker run --rm --env-file backend/.env \
  --entrypoint node \
  "${ECR_REGISTRY}/business-analyst-backend:latest" \
  scripts/migrate.js
```
