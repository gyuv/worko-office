import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from './pg.js';

const DIR = fileURLToPath(new URL('../../db/', import.meta.url));

/**
 * Applies db/*.sql in order, once each, inside a transaction per file. Runs as the schema owner.
 * Concurrency: a TRANSACTION-scoped advisory lock per file (released at COMMIT/ROLLBACK), then a re-check inside it.
 * A session-scoped lock leaks through transaction-pooling proxies (Neon "-pooler", PgBouncer): the server connection
 * keeps the lock after the client leaves, and every later migrate waits forever. Key 7311 also avoids any such leaked 7310.
 */
export async function migrate(url: string, log: (s: string) => void = () => {}): Promise<string[]> {
  const c = new Client({ connectionString: url, connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 30_000) });
  await c.connect();
  try {
    await c.query('CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    const done = new Set((await c.query<{ name: string }>('SELECT name FROM schema_migration')).rows.map((r) => r.name));
    log(`migrations: ${done.size} applied, ${files.filter((f) => !done.has(f)).length} pending`);
    const applied: string[] = [];
    for (const f of files) {
      if (done.has(f)) continue;
      await c.query('BEGIN');
      try {
        await c.query("SET LOCAL lock_timeout = '120s'");
        await c.query('SELECT pg_advisory_xact_lock(7311)');
        // Another migrator may have applied it while we waited for the lock.
        if ((await c.query('SELECT 1 FROM schema_migration WHERE name = $1', [f])).rowCount) { await c.query('COMMIT'); continue; }
        await c.query(readFileSync(DIR + f, 'utf8'));
        await c.query('INSERT INTO schema_migration(name) VALUES ($1)', [f]);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
      }
      applied.push(f);
      log(`applied ${f}`);
    }
    return applied;
  } finally {
    await c.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  migrate(url, console.log).catch((e) => { console.error(e); process.exit(1); });
}
