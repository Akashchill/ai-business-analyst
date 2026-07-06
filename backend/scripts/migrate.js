/**
 * Run database migrations in order:
 *   npm run db:migrate
 */
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { getPgPoolConfig } from '../src/config/pgConnect.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '..', 'migrations');

async function run() {
  if (!process.env.DB_NAME) {
    console.error('❌ DB_NAME not set. Copy .env.example to .env and fill in your PostgreSQL credentials.');
    process.exit(1);
  }

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const pgConfig = getPgPoolConfig();
  const pool = new pg.Pool(pgConfig);

  console.log(`🔌 Connecting to ${pgConfig.database}@${pgConfig.host}…`);

  try {
    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      console.log(`📄 Applying ${file}…`);
      await pool.query(sql);
      console.log(`✅ ${file}`);
    }
    console.log('✅ All migrations applied.');
  } catch (err) {
    if (err.message.includes('extension "vector" is not available')) {
      console.error(`
❌ pgvector extension is not installed on this PostgreSQL server.

If you're self-hosting Postgres:
  sudo apt install postgresql-XX-pgvector   (Debian/Ubuntu)
  brew install pgvector                      (macOS, then re-link)

If you're on a managed provider, pgvector is usually pre-available:
  - Supabase: enabled by default
  - Neon: run "CREATE EXTENSION vector;" — supported on all plans
`);
    } else {
      console.error('❌ Migration failed:', err.message);
    }
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
