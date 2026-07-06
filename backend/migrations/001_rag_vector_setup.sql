-- ============================================================
-- RAG Vector Storage Migration
-- Run this once against your PostgreSQL database before using
-- the document ingestion feature.
--
-- Requires PostgreSQL 13+ with the pgvector extension available.
-- On most managed providers (Supabase, Neon, RDS 15+, Aiven) this
-- extension is pre-installed and just needs to be enabled below.
-- ============================================================

-- 1. Enable the pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Documents table — one row per uploaded file
CREATE TABLE IF NOT EXISTS rag_documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename        TEXT NOT NULL,
  mimetype        TEXT,
  doc_type        TEXT DEFAULT 'general',
  uploaded_by     UUID,
  character_count INTEGER DEFAULT 0,
  chunk_count     INTEGER DEFAULT 0,
  preview         TEXT,
  uploaded_at     TIMESTAMPTZ DEFAULT now()
);

-- 3. Chunks table — one row per text chunk, with its embedding vector
--    gemini-embedding-001 at 1536 dims (pgvector HNSW index max is 2000).
CREATE TABLE IF NOT EXISTS rag_chunks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id          UUID NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
  chunk_index     INTEGER NOT NULL,
  text            TEXT NOT NULL,
  embedding       vector(1536) NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- Upgrade column if a previous run created vector(3072) before the index step failed.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'rag_chunks' AND column_name = 'embedding'
      AND udt_name = 'vector'
  ) THEN
    ALTER TABLE rag_chunks ALTER COLUMN embedding TYPE vector(1536);
  END IF;
EXCEPTION
  WHEN OTHERS THEN NULL;
END $$;

-- 4. Vector similarity index (HNSW) — max 2000 dimensions in pgvector
CREATE INDEX IF NOT EXISTS rag_chunks_embedding_idx
  ON rag_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- 5. Helpful secondary indexes
CREATE INDEX IF NOT EXISTS rag_chunks_doc_id_idx ON rag_chunks(doc_id);
CREATE INDEX IF NOT EXISTS rag_documents_doc_type_idx ON rag_documents(doc_type);

-- ============================================================
-- Notes:
-- - HNSW index build can take a while on large existing tables;
--   for a fresh install (table starts empty) it's instant.
-- - If your Postgres provider doesn't support HNSW yet, swap to:
--     USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
--   IVFFlat needs ANALYZE after bulk inserts: ANALYZE rag_chunks;
-- ============================================================
