import { resolveSecretValue } from './secrets.js';

function env(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  // Trim — ECS console pastes / Secrets Manager values often include trailing newlines
  return String(raw).trim();
}

/**
 * Resolve DB password from env (Secrets Manager JSON-safe).
 */
export function resolveDbPassword(raw) {
  return resolveSecretValue(raw, ['password', 'DB_PASSWORD', 'db_password', 'Password']);
}

function shouldUseSsl(host) {
  if (env('DB_SSL') === 'false') return false;
  if (env('DB_SSL') === 'true') return true;
  return /supabase\.co|pooler\.supabase\.com|rds\.amazonaws\.com/i.test(host || '');
}

function withOptionalSsl(config, host) {
  if (!shouldUseSsl(host)) return config;
  return { ...config, ssl: { rejectUnauthorized: false } };
}

function getSupabaseProjectRef(host, user) {
  const fromHost = host.match(/^db\.([a-z0-9]+)\.supabase\.co$/i)?.[1];
  if (fromHost) return fromHost;
  if (env('SUPABASE_PROJECT_REF')) return env('SUPABASE_PROJECT_REF');
  const fromUser = user?.match(/^postgres\.([a-z0-9]+)$/i)?.[1];
  if (fromUser) return fromUser;
  return null;
}

function poolerUser(user, projectRef) {
  if (user?.includes('.')) return user;
  if (projectRef) return `postgres.${projectRef}`;
  return user;
}

/**
 * PostgreSQL connection config.
 * Supabase direct hosts (db.<ref>.supabase.co) are IPv6-only; Node on many
 * Windows networks cannot resolve or reach them. Use the Supavisor pooler
 * (IPv4) from Dashboard → Project Settings → Database → Connection string → Session.
 */
export function getPgPoolConfig() {
  const host = env('DB_HOST', 'localhost');
  const port = parseInt(env('DB_PORT', '5432'), 10);
  const database = env('DB_NAME');
  const user = env('DB_USER');
  const password = resolveDbPassword(process.env.DB_PASSWORD);
  const poolerHost = env('DB_POOLER_HOST');
  const projectRef = getSupabaseProjectRef(host, user);

  // Prefer pooler whenever DB_POOLER_HOST is set (ECS / IPv4 networks)
  if (poolerHost) {
    return withOptionalSsl({
      host: poolerHost,
      port: parseInt(env('DB_POOLER_PORT', env('DB_PORT', '5432')), 10),
      database,
      user: poolerUser(user, projectRef),
      password,
      max: 20,
    }, poolerHost);
  }

  const supabaseDirect = host.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
  if (supabaseDirect) {
    console.warn(`
⚠️  DB_HOST is a Supabase direct connection (IPv6-only).
    If you see "getaddrinfo ENOTFOUND", switch to the Session pooler in Supabase Dashboard:
      DB_POOLER_HOST=aws-0-<region>.pooler.supabase.com
      DB_USER=postgres.<project-ref>
    Or set DB_HOST to the pooler hostname directly.
`);
  }

  return withOptionalSsl({ host, port, database, user, password, max: 20 }, host);
}
