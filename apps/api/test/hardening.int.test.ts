import { Test } from '@nestjs/testing';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { applyHttpHardening } from '../src/common/hardening.js';
import { RedactingLogger } from '../src/common/logger.js';
import { KeyService, LocalKms } from '../src/crypto/key.service.js';
import { DbService } from '../src/db/db.service.js';
import { rotateKek } from '../src/db/rotate-kek.js';
import { HealthController } from '../src/health/health.controller.js';
import { bearer, bootApp, PW } from './helpers.js';

let t: Awaited<ReturnType<typeof bootApp>>;
beforeAll(async () => { t = await bootApp(); }, 60_000);
afterAll(() => t?.close());

const PII = [/ABCPK\d{4}Q/, /98110\d{5}/, /ramesh@example\.com/i, /2345\s?6789\s?0123/];

describe('hardening', () => {
  it('sets security headers and request ids; caps body size', async () => {
    const r = await t.http().get('/v1/health').expect(200);
    expect(r.headers).toMatchObject({ 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
    expect(r.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.headers['x-request-id']).toMatch(/^[\w-]{8,}$/);
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect((await t.http().get('/v1/health').set('X-Request-Id', 'trace-abc-123')).headers['x-request-id']).toBe('trace-abc-123');
    const big = await t.http().post('/v1/auth/login').set('Content-Type', 'application/json').send(JSON.stringify({ pad: 'x'.repeat(1_100_000) })).expect(413);
    expect(big.body.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('liveness/readiness; DB statement timeout defaults', async () => {
    await t.http().get('/v1/health/live').expect(200, { status: 'ok' });
    await t.http().get('/v1/health/ready').expect(200, { status: 'ready' });
    const db = t.app.get(DbService);
    expect((await db.pool.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('1min');
    expect((await db.pool.query('SHOW idle_in_transaction_session_timeout')).rows[0].idle_in_transaction_session_timeout).toBe('2min');
  });

  it('password policy: local rules + breached-password (k-anonymity) check', async () => {
    const weak = await t.http().post('/v1/tenants/signup').send({ firmName: 'Weak & Co', slug: 'weak1', stateCode: '27', partner: { name: 'Partner', email: 'p@weak1.in', password: 'aaaaaaaaaaaa' } }).expect(400);
    expect(weak.body).toMatchObject({ code: 'WEAK_PASSWORD', issues: ['repeated'] });
    const breached = await t.http().post('/v1/tenants/signup').send({ firmName: 'Weak & Co', slug: 'weak2', stateCode: '27', partner: { name: 'Partner', email: 'p@weak2.in', password: 'Password@123' } }).expect(400);
    expect(breached.body.code).toBe('BREACHED_PASSWORD');
    const p = await t.signup('hp1');
    const u = await t.http().post('/v1/users').set(bearer(p.accessToken)).send({ name: 'Suresh', email: 'suresh@hp1.in', password: 'suresh-rocks-2026', roleKeys: ['article'] }).expect(400);
    expect(u.body).toMatchObject({ code: 'WEAK_PASSWORD', issues: ['contains_identity'] });
    await t.http().post('/v1/users').set(bearer(p.accessToken)).send({ name: 'Suresh', email: 'suresh@hp1.in', password: PW, roleKeys: ['article'] }).expect(201);
  });

  it('logs are structured JSON with PAN / phone / e-mail / Aadhaar redacted (app logger + access log)', async () => {
    const lines: string[] = [];
    const logger = new RedactingLogger((l) => lines.push(l), ['log', 'error', 'warn']);
    logger.error('Import failed for PAN ABCPK1234Q, phone +91 98110 00001, ramesh@example.com, Aadhaar 2345 6789 0123', 'stack at ABCPK1234Q', 'Import');
    logger.log({ note: 'client ramesh@example.com' }, 'Ctx');
    const app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication({ rawBody: true });
    app.setGlobalPrefix('v1');
    applyHttpHardening(app, { logger, accessLog: true });
    await app.init();
    try {
      await request(app.getHttpServer()).get('/v1/lookup/gstin/27ABCPK1234Q1Z5?email=ramesh@example.com').expect(401);
      await new Promise((r) => setTimeout(r, 20));
    } finally { await app.close(); }
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const l of lines) {
      const j = JSON.parse(l);
      expect(j).toHaveProperty('level');
      for (const re of PII) expect(l).not.toMatch(re);
    }
    expect(lines.some((l) => l.includes('/v1/lookup/gstin/') && l.includes(' 401 '))).toBe(true);
  });

  it('KEK rotation re-wraps data keys; old ciphertexts still decrypt; idempotent', async () => {
    const p = await t.signup('kr1');
    const c = (await t.http().post('/v1/clients').set(bearer(p.accessToken)).send({ name: 'Rotate Me', entityType: 'INDIVIDUAL', aadhaar: '234567890123' }).expect(201)).body;
    const db = t.app.get(DbService);
    const oldSecret = process.env.KMS_LOCAL_MASTER_KEY ?? process.env.FIELD_ENCRYPTION_KEY ?? 'worko-dev-only-master-key';
    const before = (await t.sql<{ kek_id: string; wrapped_dek: Buffer }>('SELECT kek_id, wrapped_dek FROM tenant_key WHERE tenant_id = $1', [p.tenantId]))[0]!;
    const next = new LocalKms('rotated-master-key-2026', [oldSecret]);
    const r = await rotateKek(db, next);
    expect(r.rewrapped).toBeGreaterThanOrEqual(1);
    const after = (await t.sql<{ kek_id: string; wrapped_dek: Buffer }>('SELECT kek_id, wrapped_dek FROM tenant_key WHERE tenant_id = $1', [p.tenantId]))[0]!;
    expect(after.kek_id).toBe(next.kekId);
    expect(after.kek_id).not.toBe(before.kek_id);
    expect(after.wrapped_dek.equals(before.wrapped_dek)).toBe(false);
    const blob = (await t.sql<{ aadhaar_enc: Buffer }>('SELECT aadhaar_enc FROM client WHERE id = $1', [c.id]))[0]!.aadhaar_enc;
    // Only the new KEK is needed now; the old one alone can no longer open the data key.
    const plain = await db.tenantTx(p.tenantId, (tx) => new KeyService(new LocalKms('rotated-master-key-2026', [])).decrypt(tx, p.tenantId, blob, `client:${c.id}:aadhaar`));
    expect(plain).toBe('234567890123');
    await expect(db.tenantTx(p.tenantId, (tx) => new KeyService(new LocalKms(oldSecret, [])).decrypt(tx, p.tenantId, blob, `client:${c.id}:aadhaar`))).rejects.toThrow(/KEK/);
    expect((await rotateKek(db, next)).rewrapped).toBe(0);
    expect((await t.sql(`SELECT 1 FROM audit_log WHERE action = 'crypto.kek_rotate' AND tenant_id = $1`, [p.tenantId])).length).toBe(1);
    // Restore so the rest of this app keeps working with its configured KMS.
    await rotateKek(db, new LocalKms(oldSecret, ['rotated-master-key-2026']));
  });

  it('secret scan flags credentials in files and passes clean ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scan-'));
    const script = new URL('../../../scripts/scan-secrets.mjs', import.meta.url).pathname;
    writeFileSync(join(dir, 'ok.ts'), 'export const x = 1;\n');
    expect(execFileSync('node', [script, dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).toBe('');
    writeFileSync(join(dir, 'leak.ts'), `const k = '${'AKIA'}${'ABCDEFGHIJKLMNOP'}';\n`);
    expect(() => execFileSync('node', [script, dir], { stdio: 'pipe' })).toThrow();
  });

  it('readiness reports draining during graceful shutdown (runs last)', async () => {
    t.app.get(HealthController).beforeApplicationShutdown();
    expect((await t.http().get('/v1/health/ready').expect(503)).body.code).toBe('DRAINING');
    await t.http().get('/v1/health/live').expect(200);
  });
});
