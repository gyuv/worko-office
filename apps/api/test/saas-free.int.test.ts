import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbService } from '../src/db/db.service.js';
import { SaasService } from '../src/platform/saas.service.js';
import { bootApp } from './helpers.js';

let t: Awaited<ReturnType<typeof bootApp>>;
beforeAll(async () => { process.env.SAAS_FREE_FOREVER = '1'; t = await bootApp(); });
afterAll(async () => { delete process.env.SAAS_FREE_FOREVER; await t?.close(); });

describe('SAAS_FREE_FOREVER', () => {
  it('new firms are on unlimited Enterprise with no end date, and the daily lifecycle never bills or suspends', async () => {
    const s = await t.signup('freeco');
    const row = async () => (await t.app.get(DbService).systemTx((tx) => tx.query(`SELECT plan, sub_status, period_end FROM tenant WHERE id = $1`, [s.tenantId]))).rows[0];
    expect(await row()).toMatchObject({ plan: 'enterprise', sub_status: 'active', period_end: null });
    await t.app.get(DbService).systemTx((tx) => tx.query(`UPDATE tenant SET sub_status = 'past_due', past_due_since = '2026-01-01' WHERE id = $1`, [s.tenantId]));
    const r = await t.app.get(SaasService).runDaily(s.tenantId, '2030-01-01');
    expect(r).toMatchObject({ status: 'active', invoiceId: null });
    expect(await row()).toMatchObject({ plan: 'enterprise', sub_status: 'active', period_end: null });
    const inv = await t.app.get(DbService).systemTx((tx) => tx.query(`SELECT count(*)::int AS n FROM saas_invoice WHERE tenant_id = $1`, [s.tenantId]));
    expect(inv.rows[0].n).toBe(0);
  });
});
