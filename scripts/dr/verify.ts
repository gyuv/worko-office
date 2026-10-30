/**
 * Restore-drill verification (run by drill.sh with apps/api's tsx). Connects to the restored scratch database as the
 * drill's admin role (superuser → RLS does not hide rows) and checks:
 *   1. row counts per table vs the backup manifest (rows-<db>.tsv);
 *   2. every tenant's audit hash chain, with the API's own AuditService.verify (no second implementation);
 *   3. every tenant's wrapped data key unwraps with the configured master key, and a sample of encrypted client
 *      fields decrypts (AAD `client:<id>:aadhaar|bank`) — proves the backup is usable with the keys we hold.
 * Prints values-free results only (never decrypted data). Exit 1 on any failure.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { AuditService } from '../../apps/api/src/audit/audit.service.js';
import { KeyService, LocalKms } from '../../apps/api/src/crypto/key.service.js';

const require = createRequire(fileURLToPath(new URL('../../apps/api/package.json', import.meta.url)));
const pg = require('pg') as typeof import('pg');

const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} is not set`); return v; };
const parse = (f: string) => new Map(readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { const [t, n] = l.split('\t'); return [t!, Number(n)] as const; }));

async function main() {
  const failures: string[] = [];
  const expected = parse(env('DRILL_ROWS_EXPECTED')); const actual = parse(env('DRILL_ROWS_ACTUAL'));
  const strict = process.env.DRILL_STRICT === '1';
  let tables = 0; let rows = 0;
  for (const [t, n] of expected) {
    const got = actual.get(t);
    if (got === undefined) { failures.push(`table missing: ${t}`); continue; }
    tables++; rows += got;
    if (strict ? got !== n : got < Math.floor(n * 0.99)) failures.push(`row count ${t}: manifest ${n}, restored ${got}`);
  }
  for (const t of actual.keys()) if (!expected.has(t)) failures.push(`unexpected table: ${t}`);
  console.log(`rows: ${tables} tables, ${rows} rows ${failures.length ? 'MISMATCH' : 'ok'}${strict ? ' (strict)' : ''}`);

  const c = new pg.Client({ connectionString: env('DRILL_DATABASE_URL') });
  await c.connect();
  try {
    const tx = { query: (q: string, p?: unknown[]) => c.query(q, p) } as never;
    const tenants = (await c.query<{ id: string }>('SELECT id FROM tenant ORDER BY id')).rows;
    const audit = new AuditService(); let entries = 0;
    for (const { id } of tenants) {
      const v = await audit.verify(tx, id);
      entries += v.checked;
      if (!v.ok) failures.push(`audit chain broken: tenant ${id} at seq ${v.brokenAt}`);
    }
    console.log(`audit: ${tenants.length} tenants, ${entries} entries ${failures.some((f) => f.startsWith('audit')) ? 'BROKEN' : 'ok'}`);

    const keys = new KeyService(new LocalKms()); let unwrapped = 0; let samples = 0;
    for (const { id } of tenants) {
      const hasKey = (await c.query('SELECT 1 FROM tenant_key WHERE tenant_id = $1', [id])).rowCount;
      if (!hasKey) continue;
      const sample = (await c.query<{ id: string; aadhaar_enc: Buffer | null; bank_accounts_enc: Buffer | null }>(
        'SELECT id, aadhaar_enc, bank_accounts_enc FROM client WHERE tenant_id = $1 AND (aadhaar_enc IS NOT NULL OR bank_accounts_enc IS NOT NULL) ORDER BY id LIMIT 3', [id])).rows;
      try {
        for (const r of sample) {
          if (r.aadhaar_enc) { await keys.decrypt(tx, id, r.aadhaar_enc, `client:${r.id}:aadhaar`); samples++; }
          if (r.bank_accounts_enc) { await keys.decrypt(tx, id, r.bank_accounts_enc, `client:${r.id}:bank`); samples++; }
        }
        if (!sample.length) { const k = (await c.query('SELECT kek_id, wrapped_dek FROM tenant_key WHERE tenant_id = $1', [id])).rows[0]; await new LocalKms().unwrap(k.wrapped_dek, k.kek_id); }
        unwrapped++;
      } catch { failures.push(`decryption failed for tenant ${id} (wrong master key, or corrupted ciphertext)`); }
    }
    console.log(`keys: ${unwrapped} tenant keys unwrapped, ${samples} sample fields decrypted`);
  } finally { await c.end(); }

  if (failures.length) { for (const f of failures) console.error(`FAIL ${f}`); process.exit(1); }
  console.log('DRILL PASSED');
}
main().catch((e) => { console.error(`FAIL ${(e as Error).message}`); process.exit(1); });
