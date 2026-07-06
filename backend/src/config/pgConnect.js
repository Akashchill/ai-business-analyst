/**
 * PostgreSQL connection config.
 * Supabase direct hosts (db.<ref>.supabase.co) are IPv6-only; Node on many
 * Windows networks cannot resolve or reach them. Use the Supavisor pooler
 * (IPv4) from Dashboard → Project Settings → Database → Connection string → Session.
 */
export function getPgPoolConfig() {
  const host = process.env.DB_HOST || 'localhost';
  const port = parseInt(process.env.DB_PORT || '5432', 10);
  const database = process.env.DB_NAME;
  let user = process.env.DB_USER;
  const password = process.env.DB_PASSWORD;

  const supabaseDirect = host.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
  if (supabaseDirect) {
    const projectRef = supabaseDirect[1];
    const poolerHost = process.env.DB_POOLER_HOST;

    if (poolerHost) {
      return {
        host: poolerHost,
        port: parseInt(process.env.DB_POOLER_PORT || process.env.DB_PORT || '5432', 10),
        database,
        user: user?.includes('.') ? user : `postgres.${projectRef}`,
        password,
        max: 20,
      };
    }

    console.warn(`
⚠️  DB_HOST is a Supabase direct connection (IPv6-only).
    If you see "getaddrinfo ENOTFOUND", switch to the Session pooler in Supabase Dashboard:
      DB_POOLER_HOST=aws-0-<region>.pooler.supabase.com
      DB_USER=postgres.<project-ref>
    Or set DB_HOST to the pooler hostname directly.
`);
  }

  return { host, port, database, user, password, max: 20 };
}
