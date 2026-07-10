-- Add S3 metadata columns for original file storage
ALTER TABLE rag_documents
  ADD COLUMN IF NOT EXISTS s3_bucket TEXT,
  ADD COLUMN IF NOT EXISTS s3_key TEXT,
  ADD COLUMN IF NOT EXISTS file_size_bytes BIGINT;
