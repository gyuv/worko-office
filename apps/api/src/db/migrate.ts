import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const DIR = fileURLToPath(new URL('../../db/', import.meta.url));

/** Applies db/*.sql in order, once each, inside a transaction per file. Runs as the schema owner. */
export async function migrate(url: string, log: (s: string) => void = () => {}): Promise<string[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    await c.query('SELECT pg_advisory_lock(7310)');
    const done = new Set((await c.query<{ name: string }>('SELECT name FROM schema_migration')).rows.map((r) => r.name));
    const applied: string[] = [];
    for (const f of readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      await c.query('BEGIN');
      try {
        await c.query(readFileSync(DIR + f, 'utf8'));
        await c.query('INSERT INTO schema_migration(name) VALUES ($1)', [f]);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
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
