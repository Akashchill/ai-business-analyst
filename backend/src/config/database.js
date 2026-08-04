/**
 * Multi-Database Adapter
 * Supports PostgreSQL and MySQL with a unified interface.
 */
import pg from 'pg';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { getPgPoolConfig } from './pgConnect.js';
dotenv.config();

class PostgresAdapter {
  constructor(config) {
    this.pool = new pg.Pool(config);
    this.type = 'postgresql';
  }
  async query(sql, params = []) {
    const client = await this.pool.connect();
    try {
      const start = Date.now();
      const result = await client.query(sql, params);
      return { rows: result.rows, rowCount: result.rowCount, fields: result.fields?.map(f => ({ name: f.name })), duration: Date.now() - start };
    } finally { client.release(); }
  }
  async getSchema() {
    const result = await this.query(`
      SELECT t.table_name, c.column_name, c.data_type, c.is_nullable,
        CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_primary_key,
        CASE WHEN fk.column_name IS NOT NULL THEN true ELSE false END as is_foreign_key,
        fk.foreign_table_name, fk.foreign_column_name
      FROM information_schema.tables t
      JOIN information_schema.columns c ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      LEFT JOIN (
        SELECT ku.table_name, ku.column_name FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage ku ON tc.constraint_name = ku.constraint_name AND tc.table_schema = ku.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
      ) pk ON t.table_name = pk.table_name AND c.column_name = pk.column_name
      LEFT JOIN (
        SELECT kcu.table_name, kcu.column_name, ccu.table_name AS foreign_table_name, ccu.column_name AS foreign_column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
      ) fk ON t.table_name = fk.table_name AND c.column_name = fk.column_name
      WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      ORDER BY t.table_name, c.ordinal_position`);
    return buildSchema(result.rows);
  }
  async testConnection() {
    try {
      await this.query('SELECT 1');
      return true;
    } catch (err) {
      console.error('PostgreSQL connection failed:', err.message);
      return false;
    }
  }
}

class MySQLAdapter {
  constructor(config) { this.config = config; this.type = 'mysql'; this._pool = null; }
  get pool() { if (!this._pool) this._pool = mysql.createPool(this.config); return this._pool; }
  async query(sql, params = []) {
    const start = Date.now();
    const [rows, fields] = await this.pool.execute(sql, params);
    return { rows: Array.isArray(rows) ? rows : [], rowCount: Array.isArray(rows) ? rows.length : 0, fields: fields?.map(f => ({ name: f.name })) || [], duration: Date.now() - start };
  }
  async getSchema() {
    const result = await this.query(`
      SELECT c.TABLE_NAME as table_name, c.COLUMN_NAME as column_name, c.DATA_TYPE as data_type, c.IS_NULLABLE as is_nullable,
        IF(k.CONSTRAINT_NAME = 'PRIMARY', true, false) as is_primary_key, false as is_foreign_key, NULL as foreign_table_name, NULL as foreign_column_name
      FROM information_schema.COLUMNS c
      LEFT JOIN information_schema.KEY_COLUMN_USAGE k ON c.TABLE_NAME = k.TABLE_NAME AND c.COLUMN_NAME = k.COLUMN_NAME AND c.TABLE_SCHEMA = k.TABLE_SCHEMA AND k.CONSTRAINT_NAME = 'PRIMARY'
      WHERE c.TABLE_SCHEMA = DATABASE() ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`);
    return buildSchema(result.rows);
  }
  async testConnection() { try { await this.query('SELECT 1'); return true; } catch { return false; } }
}

function buildSchema(rows) {
  const schema = {};
  for (const row of rows) {
    if (!schema[row.table_name]) schema[row.table_name] = { columns: [] };
    schema[row.table_name].columns.push({
      name: row.column_name, type: row.data_type,
      nullable: row.is_nullable === 'YES' || row.is_nullable === true,
      isPrimaryKey: !!row.is_primary_key, isForeignKey: !!row.is_foreign_key,
      foreignTable: row.foreign_table_name || null, foreignColumn: row.foreign_column_name || null,
    });
  }
  return schema;
}

const adapters = new Map();
function initAdapters() {
  if (process.env.DB_NAME) {
    adapters.set('postgresql', new PostgresAdapter(getPgPoolConfig()));
  }
  if (process.env.MYSQL_NAME) {
    adapters.set('mysql', new MySQLAdapter({
      host: process.env.MYSQL_HOST || 'localhost', port: parseInt(process.env.MYSQL_PORT || '3306'),
      database: process.env.MYSQL_NAME, user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, waitForConnections: true, connectionLimit: 10,
    }));
  }
}
initAdapters();

/** Safe startup log — no secrets. Helps debug ECS env configuration. */
export function logDatabaseStatus() {
  if (!process.env.DB_NAME) {
    console.warn('⚠️  PostgreSQL not configured: DB_NAME env var is missing.');
    console.warn('   ECS: add DB_HOST, DB_POOLER_HOST, DB_NAME, DB_USER, DB_PASSWORD to the task definition.');
    return;
  }
  const cfg = getPgPoolConfig();
  console.log(`🗄️  PostgreSQL: ${cfg.host}:${cfg.port}/${cfg.database} user=${cfg.user} ssl=${cfg.ssl ? 'on' : 'off'}`);
}

export function isPostgresConfigured() {
  return adapters.has('postgresql');
}

export function getAdapter(dbType = 'postgresql') {
  const adapter = adapters.get(dbType);
  if (!adapter) throw new Error(`Database adapter "${dbType}" not configured`);
  return adapter;
}
export function listAdapters() { return [...adapters.keys()]; }
export async function getHealthAll() {
  const results = {};
  for (const [name, adapter] of adapters) results[name] = await adapter.testConnection();
  return results;
}
export async function executeQuery(sql, params, dbType) { return getAdapter(dbType).query(sql, params); }
export async function getDatabaseSchema(dbType) { return getAdapter(dbType).getSchema(); }
export async function testConnection(dbType = 'postgresql') {
  try {
    if (!adapters.has(dbType)) {
      console.error(`DB connection test failed: "${dbType}" adapter not configured (check DB_NAME env var).`);
      return false;
    }
    return await getAdapter(dbType).testConnection();
  } catch (err) {
    console.error('DB connection test failed:', err.message);
    return false;
  }
}

/**
 * Raw PostgreSQL pool, for features that are Postgres-specific
 * (pgvector similarity search). RAG storage always lives in
 * PostgreSQL regardless of which dbType the user is querying for
 * their business data — vector search needs the `vector` extension
 * which MySQL doesn't have an equivalent for.
 */
export function getPostgresPool() {
  const adapter = adapters.get('postgresql');
  if (!adapter) {
    throw new Error('PostgreSQL is not configured. RAG document storage requires DB_HOST/DB_NAME/DB_USER/DB_PASSWORD to be set, even if your primary analytics DB is MySQL.');
  }
  return adapter.pool;
}
