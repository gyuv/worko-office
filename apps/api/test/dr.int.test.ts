import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, bootApp } from './helpers.js';

/**
 * DR scripts end to end (scripts/dr): backup → restore drill into a scratch database → row counts, audit chains and
 * sample decryptions verified. Skips (with the reason) when the pg client tools are missing or older than the server.
 */
const run = promisify(execFile);
const DR = resolve(import.meta.dirname, '../../../scripts/dr');

async function toolsUsable(): Promise<string | null> {
  try {
    const v = (await run('pg_dump', ['--version'])).stdout.match(/(\d+)\./)?.[1];
    const pg = await import('pg');
    const c = new pg.default.Client({ connectionString: process.env.TEST_DATABASE_URL }); await c.connect();
    const server = (await c.query('SHOW server_version_num')).rows[0].server_version_num as string; await c.end();
    if (Number(v) < Math.floor(Number(server) / 10000)) return `pg_dump ${v} is older than the server`;
    await run('openssl', ['version']);
    return null;
  } catch (e) { return `tools unavailable: ${(e as Error).message}`; }
}

let t: Awaited<ReturnType<typeof bootApp>>;
let skip: string | null = null;
let dir: string; let env: NodeJS.ProcessEnv;
beforeAll(async () => {
  skip = await toolsUsable();
  if (skip) return;
  t = await bootApp();
  const p = await t.signup('drfirm');
  for (let i = 0; i < 3; i++) {
    await t.http().post('/v1/clients').set(bearer(p.accessToken)).send({ name: `DR Client ${i}`, entityType: 'INDIVIDUAL', aadhaar: `2345 6789 012${i}`,
      bankAccounts: [{ bank: 'HDFC Bank', accountNo: `5010001234567${i}`, ifsc: 'HDFC0000123' }] }).expect(201);
  }
  dir = mkdtempSync(join(tmpdir(), 'worko-dr-'));
  writeFileSync(join(dir, 'pass'), 'drill-test-passphrase\n', { mode: 0o600 });
  const admin = new URL(process.env.TEST_DATABASE_URL!);
  env = { ...process.env, BACKUP_PASSPHRASE_FILE: join(dir, 'pass'), BACKUP_DIR: join(dir, 'out'), BACKUP_DATABASE_URLS: t.db.url, DATABASE_URL: t.db.url,
    DRILL_ADMIN_URL: admin.toString(), DRILL_STRICT: '1', STORAGE: 'local', STORAGE_DIR: join(dir, 'storage-none'), BACKUP_GLOBALS: '0' };
}, 90_000);
afterAll(async () => { await t?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

describe('DR: backup and restore drill', () => {
  let backup: string;
  it('backup writes only encrypted artifacts + checksums; the drill restores and verifies counts, audit chain and decryption', async (ctx) => {
    if (skip) { console.warn(`DR test skipped: ${skip}`); return ctx.skip(); }
    backup = (await run(join(DR, 'backup.sh'), [], { env })).stdout.trim();
    const files = readdirSync(backup).sort();
    expect(files).toEqual(expect.arrayContaining(['SHA256SUMS', 'SHA256SUMS.enc', `db-${new URL(t.db.url).pathname.slice(1)}.dump.enc`, 'manifest.json']));
    // No plaintext dump: the encrypted file starts with openssl's salt header and holds no client names.
    const enc = readFileSync(join(backup, files.find((f) => f.endsWith('.dump.enc'))!));
    expect(enc.subarray(0, 8).toString()).toBe('Salted__');
    expect(enc.includes(Buffer.from('DR Client'))).toBe(false);
    const drill = await run(join(DR, 'drill.sh'), [backup], { env, timeout: 120_000 });
    expect(drill.stdout).toContain('DRILL PASSED');
    expect(drill.stdout).toMatch(/audit: 1 tenants, \d+ entries ok/);
    expect(drill.stdout).toContain('6 sample fields decrypted');
    expect(drill.stdout).not.toContain('2345'); // never prints decrypted values
  }, 180_000);

  it('a wrong passphrase or a tampered artifact refuses to restore', async (ctx) => {
    if (skip || !backup) return ctx.skip();
    writeFileSync(join(dir, 'wrong'), 'not-the-passphrase\n', { mode: 0o600 });
    await expect(run(join(DR, 'drill.sh'), [backup], { env: { ...env, BACKUP_PASSPHRASE_FILE: join(dir, 'wrong') } })).rejects.toThrow(/cannot decrypt|bad decrypt/);
    const f = join(backup, readdirSync(backup).find((x) => x.endsWith('.dump.enc'))!);
    const b = readFileSync(f); b[b.length - 5] ^= 0xff; writeFileSync(f, b);
    await expect(run(join(DR, 'drill.sh'), [backup], { env })).rejects.toThrow(/checksum mismatch/);
  }, 120_000);
});
