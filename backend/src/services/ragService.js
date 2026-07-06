/**
 * RAG (Retrieval-Augmented Generation) Document Service — v2
 *
 * Real vector pipeline:
 *   1. Extract text from uploaded file (PDF/TXT/MD)
 *   2. Chunk into overlapping segments
 *   3. Embed each chunk with Gemini (gemini-embedding-001, 1536 dims)
 *   4. Store chunk text + vector in PostgreSQL (pgvector column)
 *   5. At query time: embed the question, run a cosine-similarity
 *      nearest-neighbor search directly in Postgres, return top-K chunks
 *
 * Requires migrations/001_rag_vector_setup.sql to have been run first.
 */

import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { getPostgresPool } from '../config/database.js';
import { embedText, embedBatch, toVectorLiteral } from '../config/ai.js';

// ── Text extraction ──────────────────────────────────────────────────────────

export async function extractText(filePath, mimetype) {
  if (mimetype === 'application/pdf') {
    const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');
    const buf = fs.readFileSync(filePath);
    const data = await pdfParse(buf);
    return data.text;
  }
  if (mimetype === 'text/plain' || filePath.endsWith('.txt') || filePath.endsWith('.md')) {
    return fs.readFileSync(filePath, 'utf-8');
  }
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return ''; }
}

// ── Chunking ─────────────────────────────────────────────────────────────────
// 800 words per chunk with 150-word overlap so context isn't lost at chunk
// boundaries. Gemini's embedding model handles up to ~2K tokens comfortably
// at this size.

function chunkText(text, chunkSize = 400, overlap = 75) {
  const words = text.split(/\s+/).filter(Boolean);
  const result = [];
  let i = 0;
  while (i < words.length) {
    const chunk = words.slice(i, i + chunkSize).join(' ');
    if (chunk.trim()) result.push(chunk);
    i += chunkSize - overlap;
  }
  return result;
}

// ── Ingestion: file → text → chunks → embeddings → Postgres ─────────────────

export async function ingestDocument({ filePath, filename, mimetype, uploadedBy, docType = 'general' }) {
  const pool = getPostgresPool();
  const text = await extractText(filePath, mimetype);
  if (!text?.trim()) throw new Error('Could not extract text from document');

  const textChunks = chunkText(text);
  if (!textChunks.length) throw new Error('Document produced no usable text chunks');

  console.log(`📄 Embedding "${filename}" → ${textChunks.length} chunks via gemini-embedding-001…`);

  // Embed all chunks in batch (task type = RETRIEVAL_DOCUMENT, since these
  // are the documents being indexed, not the query searching them)
  const vectors = await embedBatch(textChunks, 'RETRIEVAL_DOCUMENT');

  if (vectors.length !== textChunks.length) {
    throw new Error(`Embedding count mismatch: ${vectors.length} vectors for ${textChunks.length} chunks`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const docId = uuidv4();
    await client.query(
      `INSERT INTO rag_documents (id, filename, mimetype, doc_type, uploaded_by, character_count, chunk_count, preview)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [docId, filename, mimetype, docType, uploadedBy || null, text.length, textChunks.length, text.slice(0, 300)]
    );

    for (let i = 0; i < textChunks.length; i++) {
      await client.query(
        `INSERT INTO rag_chunks (id, doc_id, chunk_index, text, embedding)
         VALUES ($1, $2, $3, $4, $5)`,
        [uuidv4(), docId, i, textChunks[i], toVectorLiteral(vectors[i])]
      );
    }

    await client.query('COMMIT');

    console.log(`✅ Stored ${textChunks.length} embedded chunks for "${filename}"`);

    return {
      id: docId,
      filename,
      mimetype,
      docType,
      uploadedBy,
      uploadedAt: new Date().toISOString(),
      chunkCount: textChunks.length,
      characterCount: text.length,
      preview: text.slice(0, 300),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Retrieval: embed the query, run pgvector cosine search ──────────────────

export async function retrieveRelevantChunks(query, topK = 5) {
  let queryVector;
  try {
    queryVector = await embedText(query, 'RETRIEVAL_QUERY');
  } catch (err) {
    console.error('Query embedding failed:', err.message);
    return [];
  }

  const pool = getPostgresPool();
  const literal = toVectorLiteral(queryVector);

  // <=> is the cosine-distance operator added by pgvector.
  // Lower distance = more similar. We convert to a similarity score
  // (1 - distance) so callers get an intuitive 0..1 relevance value.
  const sql = `
    SELECT
      c.id,
      c.doc_id,
      c.text,
      c.chunk_index,
      d.filename AS doc_name,
      d.doc_type,
      1 - (c.embedding <=> $1::vector) AS similarity
    FROM rag_chunks c
    JOIN rag_documents d ON d.id = c.doc_id
    ORDER BY c.embedding <=> $1::vector
    LIMIT $2;
  `;

  const result = await pool.query(sql, [literal, topK]);

  return result.rows.map(r => ({
    id: r.id,
    docId: r.doc_id,
    docName: r.doc_name,
    docType: r.doc_type,
    text: r.text,
    chunkIndex: r.chunk_index,
    similarity: parseFloat(r.similarity),
  }));
}

// ── Document management ───────────────────────────────────────────────────────

export async function listDocuments() {
  const pool = getPostgresPool();
  const result = await pool.query(
    `SELECT id, filename, mimetype, doc_type AS "docType", uploaded_by AS "uploadedBy",
            character_count AS "characterCount", chunk_count AS "chunkCount",
            preview, uploaded_at AS "uploadedAt"
     FROM rag_documents ORDER BY uploaded_at DESC`
  );
  return result.rows;
}

export async function deleteDocument(docId) {
  const pool = getPostgresPool();
  const client = await pool.connect();
  try {
    const existing = await client.query('SELECT id FROM rag_documents WHERE id = $1', [docId]);
    if (!existing.rows.length) return { existed: false, chunksRemoved: 0 };

    const countRes = await client.query('SELECT COUNT(*) FROM rag_chunks WHERE doc_id = $1', [docId]);
    const chunksRemoved = parseInt(countRes.rows[0].count);

    // ON DELETE CASCADE handles rag_chunks automatically
    await client.query('DELETE FROM rag_documents WHERE id = $1', [docId]);

    return { existed: true, chunksRemoved };
  } finally {
    client.release();
  }
}

export async function getDocumentStats() {
  const pool = getPostgresPool();
  const docCount = await pool.query('SELECT COUNT(*) FROM rag_documents');
  const chunkCount = await pool.query('SELECT COUNT(*) FROM rag_chunks');
  const types = await pool.query('SELECT DISTINCT doc_type FROM rag_documents');

  return {
    documentCount: parseInt(docCount.rows[0].count),
    chunkCount: parseInt(chunkCount.rows[0].count),
    docTypes: types.rows.map(r => r.doc_type),
  };
}
