import pg from 'pg';
import { migrate } from '../src/db/migrate.js';

/**
 * Creates a throwaway database, migrates it and points DATABASE_URL at it.
 * Requires TEST_DATABASE_URL (an admin connection, e.g. postgres://postgres@localhost:5432/postgres).
 * CI provides one; integration tests fail rather than silently skip without it.
 */
export async function freshDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const admin = process.env.TEST_DATABASE_URL;
  if (!admin) throw new Error('TEST_DATABASE_URL is not set — start Postgres (docker compose up -d postgres) and export it');
  const name = `worko_test_${process.pid}_${Date.now()}`;
  const c = new pg.Client({ connectionString: admin });
  await c.connect();
  await c.query(`CREATE DATABASE ${name}`);
  await c.end();
  const u = new URL(admin);
  u.pathname = `/${name}`;
  await migrate(u.toString());
  process.env.DATABASE_URL = u.toString();
  return {
    url: u.toString(),
    drop: async () => {
      const d = new pg.Client({ connectionString: admin });
      await d.connect();
      await d.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await d.end();
    },
  };
}
