import { gstinCheckChar } from '@worko/domain';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BillingAutoService } from '../src/billing/auto.service.js';
import { CollectionsService } from '../src/billing/collections.service.js';
import { JobQueueService } from '../src/jobs/job-queue.service.js';
import { Clock } from '../src/common/clock.js';
import { assertPaymentConfig, type MockPaymentProvider, PAYMENT_PROVIDERS } from '../src/billing/providers.js';
import { CLIENT_MESSENGER, type MockMessenger } from '../src/billing/providers.js';
import { bearer, bootApp, type Session } from './helpers.js';

let t: Awaited<ReturnType<typeof bootApp>>;
beforeAll(async () => { t = await bootApp(); t.app.get(Clock).set(new Date('2027-06-30T12:00:00+05:30')); }, 60_000);
afterAll(() => t?.close());

const H = (s: Session) => bearer(s.accessToken);
let seq = 5000;
function gstin(state: string) {
  const pan = `AAB${'CFP'[seq % 3]}X${String(seq++).padStart(4, '0')}Z`;
  const base = `${state}${pan}1Z`;
  return base + gstinCheckChar(base);
}
async function client(s: Session, name: string, extra: Record<string, unknown> = {}, state: string | null = '27') {
  const regs = state ? { registrations: [{ kind: 'GSTIN', number: gstin(state), isPrimary: true }] } : {};
  const r = await t.http().post('/v1/clients').set(H(s)).send({ name, entityType: 'PRIVATE_COMPANY', email: `${name.split(' ')[0]!.toLowerCase().replace(/[^a-z]/g, '') || 'x'}@client.in`, phone: '+919812345678', ...regs, ...extra }).expect(201);
  return r.body.id as string;
}
const doneTask = async (s: Session, clientId: string, stId: string, title: string) =>
  (await t.http().post('/v1/tasks').set(H(s)).send({ client_id: clientId, service_type_id: stId, title, status: 'done', checks: [] }).expect(201)).body.id as string;
const draft = async (s: Session, clientId: string, lines: unknown[], extra: Record<string, unknown> = {}) =>
  (await t.http().post('/v1/billing/invoices').set(H(s)).send({ clientId, lines, ...extra }).expect(201)).body.id as string;
const get = async (s: Session, id: string) => (await t.http().get(`/v1/billing/invoices/${id}`).set(H(s)).expect(200)).body;
const issue = (s: Session, id: string, issueDate = '2026-09-30', dueDate?: string) => t.http().post(`/v1/billing/invoices/${id}/issue`).set(H(s)).send({ issueDate, ...(dueDate ? { dueDate } : {}) });
const line = (ratePaise: number, extra: Record<string, unknown> = {}) => ({ description: 'Professional fees', ratePaise, ...extra });

/** A firm with a GST-registered entity in Maharashtra (SMA), an unregistered second entity (SMB), the catalogue and GSTR-3B rates. */
async function firm(slug: string) {
  const p = await t.signup(slug);
  const [e1] = (await t.http().get('/v1/billing/entities').set(H(p)).expect(200)).body;
  await t.http().patch(`/v1/billing/entities/${e1.id}`).set(H(p)).send({ gstin: gstin('27'), invoicePrefix: 'SMA', address: 'FC Road, Pune', bank: { name: 'HDFC Bank', accountNo: '50100012345678', ifsc: 'HDFC0000123' } }).expect(204);
  const e2 = (await t.http().post('/v1/billing/entities').set(H(p)).send({ name: `${slug} Advisory`, stateCode: '27', invoicePrefix: 'SMB' }).expect(201)).body.id as string;
  await t.http().put('/v1/billing/settings').set(H(p)).send({ defaultEntityId: e1.id }).expect(204);
  await t.http().post('/v1/service-types/install-defaults').set(H(p)).expect(200);
  const st = (await t.http().get('/v1/service-types').set(H(p)).expect(200)).body as Array<{ id: string; key: string }>;
  const g3b = st.find((s) => s.key === 'GSTR3B')!; const g1 = st.find((s) => s.key === 'GSTR1')!;
  await t.http().post('/v1/billing/rates').set(H(p)).send({ serviceTypeId: g3b.id, amountPaise: 150_000, effectiveFrom: '2026-04-01' }).expect(201);
  await t.http().post('/v1/billing/rates').set(H(p)).send({ serviceTypeId: g1.id, amountPaise: 100_000, effectiveFrom: '2026-04-01' }).expect(201);
  return { p, e1: e1.id as string, e2, g3b: g3b.id, g1: g1.id };
}

describe('tax computation', () => {
  it('intra → CGST+SGST, inter → IGST, unregistered entity → no tax; place of supply from GSTIN or address', async () => {
    const f = await firm('bl1');
    const intra = await client(f.p, 'Intra Pvt Ltd');
    const inter = await client(f.p, 'Inter Pvt Ltd', {}, '29');
    const noGst = await client(f.p, 'Plain Traders', { addresses: [{ kind: 'registered', line1: '1 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001' }] }, null);
    const a = await get(f.p, await draft(f.p, intra, [line(100_000)]));
    expect(a).toMatchObject({ supplyType: 'intra', placeOfSupply: '27', taxablePaise: 100_000, cgstPaise: 9_000, sgstPaise: 9_000, igstPaise: 0, totalPaise: 118_000, status: 'draft', number: null });
    expect(a.lines[0]).toMatchObject({ sac: '998231', gstRate: 18 });
    const b = await get(f.p, await draft(f.p, inter, [line(100_000)]));
    expect(b).toMatchObject({ supplyType: 'inter', placeOfSupply: '29', cgstPaise: 0, igstPaise: 18_000, totalPaise: 118_000 });
    const c = await get(f.p, await draft(f.p, noGst, [line(100_000)]));
    expect(c).toMatchObject({ supplyType: 'inter', placeOfSupply: '29', clientGstin: null, igstPaise: 18_000 });
    const u = await get(f.p, await draft(f.p, intra, [line(100_000)], { entityId: f.e2 }));
    expect(u).toMatchObject({ supplyType: 'unregistered', cgstPaise: 0, sgstPaise: 0, igstPaise: 0, totalPaise: 100_000 });
    // Rounding: per line to paise, total to the rupee with a round-off; reimbursements outside GST.
    const r = await get(f.p, await draft(f.p, intra, [line(33_333, { qty: 3, discountPaise: 99 }), { description: 'ROC filing fee paid on behalf', ratePaise: 60_000, reimbursement: true }]));
    expect(r).toMatchObject({ taxablePaise: 99_900, cgstPaise: 8_991, sgstPaise: 8_991, reimbursementPaise: 60_000, roundOffPaise: 18, totalPaise: 177_900 });
    expect(r.lines[1]).toMatchObject({ reimbursement: true, gstRate: 0, sac: null, cgstPaise: 0 });
  });
});

describe('numbering and immutability', () => {
  it('gap-free per entity × FY under concurrent issue; failed issue consumes nothing; issued is immutable', async () => {
    const f = await firm('bl2');
    const c = await client(f.p, 'Numbers Ltd');
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(await draft(f.p, c, [line(10_000 * (i + 1))]));
    await issue(f.p, ids[0]!, '2026-09-30', '2026-09-01').expect(400); // due before issue → rolled back, number not consumed
    const res = await Promise.all(ids.map((id) => issue(f.p, id)));
    expect(res.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(res.map((r) => r.body.number).sort()).toEqual(['SMA/2627/0001', 'SMA/2627/0002', 'SMA/2627/0003', 'SMA/2627/0004', 'SMA/2627/0005', 'SMA/2627/0006']);
    await issue(f.p, ids[0]!).expect(409);
    // Separate series per entity and per FY.
    expect((await issue(f.p, await draft(f.p, c, [line(5_000)], { entityId: f.e2 })).expect(200)).body.number).toBe('SMB/2627/0001');
    expect((await issue(f.p, await draft(f.p, c, [line(5_000)]), '2027-04-01').expect(200)).body.number).toBe('SMA/2728/0001');
    const inv = await get(f.p, ids[0]!);
    expect(inv).toMatchObject({ status: 'issued', issueDate: '2026-09-30', dueDate: '2026-10-15' }); // default 15 days
    // Immutable: REST refuses, and the database refuses even a direct write.
    expect((await t.http().patch(`/v1/billing/invoices/${ids[0]}`).set(H(f.p)).send({ notes: 'changed' }).expect(409)).body.code).toBe('invoice_immutable');
    await t.http().delete(`/v1/billing/invoices/${ids[0]}`).set(H(f.p)).expect(409);
    await expect(t.sql('UPDATE invoice SET total_paise = 1 WHERE id = $1', [ids[0]])).rejects.toThrow(/immutable/);
    await expect(t.sql('UPDATE invoice_line SET rate_paise = 1 WHERE invoice_id = $1', [ids[0]])).rejects.toThrow(/immutable/);
    await expect(t.sql('DELETE FROM invoice_line WHERE invoice_id = $1', [ids[0]])).rejects.toThrow(/immutable/);
    // Prefix is locked once the entity has issued.
    expect((await t.http().patch(`/v1/billing/entities/${f.e1}`).set(H(f.p)).send({ invoicePrefix: 'NEW' }).expect(409)).body.code).toBe('entity_locked');
    const pdf = await t.http().get(`/v1/billing/invoices/${ids[0]}/pdf`).set(H(f.p)).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    const audit = await t.sql<{ action: string }>(`SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY seq`, [ids[0]]);
    expect(audit.map((x) => x.action)).toEqual(expect.arrayContaining(['invoice.drafted', 'invoice.issued']));
  });
});

describe('credit/debit notes and cancellation', () => {
  it('credit note reduces the balance; cannot exceed it; cancel only when nothing is settled', async () => {
    const f = await firm('bl3');
    const c = await client(f.p, 'Notes Ltd');
    const id = await draft(f.p, c, [line(100_000)]);
    await issue(f.p, id).expect(200);
    const cn = (await t.http().post(`/v1/billing/invoices/${id}/notes`).set(H(f.p)).send({ kind: 'credit_note', date: '2026-10-05', reason: 'Fee revised', lines: [{ description: 'Discount', taxablePaise: 10_000 }] }).expect(201)).body;
    expect(cn).toMatchObject({ number: 'SMACN/2627/0001', totalPaise: 11_800 });
    expect(await get(f.p, id)).toMatchObject({ creditedPaise: 11_800, balancePaise: 106_200, status: 'partially_paid' });
    expect(await get(f.p, cn.id)).toMatchObject({ kind: 'credit_note', againstInvoiceId: id, cgstPaise: 900, sgstPaise: 900, balancePaise: 0 });
    expect((await t.http().post(`/v1/billing/invoices/${id}/notes`).set(H(f.p)).send({ kind: 'credit_note', date: '2026-10-05', reason: 'Too much', lines: [{ description: 'x', taxablePaise: 100_000 }] }).expect(409)).body.code).toBe('credit_exceeds_invoice');
    expect((await t.http().post(`/v1/billing/invoices/${id}/cancel`).set(H(f.p)).send({ reason: 'Wrong client' }).expect(409)).body.code).toBe('invoice_settled');
    const dn = (await t.http().post(`/v1/billing/invoices/${id}/notes`).set(H(f.p)).send({ kind: 'debit_note', date: '2026-10-06', reason: 'Additional work', lines: [{ description: 'Extra', taxablePaise: 5_000 }] }).expect(201)).body;
    expect(await get(f.p, dn.id)).toMatchObject({ number: 'SMADN/2627/0001', balancePaise: 5_900, status: 'issued', dueDate: '2026-10-21' });
    // Cancel an untouched invoice: number stays used, balance 0.
    const id2 = await draft(f.p, c, [line(50_000)]);
    await issue(f.p, id2).expect(200);
    await t.http().post(`/v1/billing/invoices/${id2}/cancel`).set(H(f.p)).send({ reason: 'Raised in error' }).expect(204);
    expect(await get(f.p, id2)).toMatchObject({ status: 'cancelled', balancePaise: 0, number: 'SMA/2627/0002' });
    expect((await issue(f.p, await draft(f.p, c, [line(50_000)])).expect(200)).body.number).toBe('SMA/2627/0003');
  });
});

describe('receipts, ageing and reconciliation', () => {
  it('FIFO with TDS, advances applied later, balances = total − allocations − TDS − credits, ageing reconciles', async () => {
    const f = await firm('bl4');
    const c = await client(f.p, 'Payer Ltd');
    const c2 = await client(f.p, 'Other Ltd');
    const i1 = await draft(f.p, c, [line(100_000)]); await issue(f.p, i1, '2026-06-30', '2026-07-15').expect(200); // 118000, oldest
    const i2 = await draft(f.p, c, [line(50_000)]); await issue(f.p, i2, '2026-08-31', '2026-09-15').expect(200);  // 59000
    const i3 = await draft(f.p, c2, [line(200_000)]); await issue(f.p, i3, '2026-09-30', '2026-10-15').expect(200); // 236000
    // 1,30,000 cash + 10,000 TDS (194J) → i1 fully (TDS first), 22,000 to i2.
    const r1 = (await t.http().post('/v1/billing/receipts').set(H(f.p)).send({ clientId: c, receivedOn: '2026-10-01', amountPaise: 130_000, tdsPaise: 10_000, tdsSection: '194J', mode: 'bank', reference: 'UTR123' }).expect(201)).body;
    expect(r1.number).toBe('SMAR/2627/0001');
    expect(r1.allocations).toEqual([{ invoiceId: i1, amountPaise: 108_000, tdsPaise: 10_000 }, { invoiceId: i2, amountPaise: 22_000, tdsPaise: 0 }]);
    expect(await get(f.p, i1)).toMatchObject({ status: 'paid', balancePaise: 0, allocatedPaise: 108_000, tdsPaise: 10_000 });
    expect(await get(f.p, i2)).toMatchObject({ status: 'partially_paid', balancePaise: 37_000 });
    await t.http().post('/v1/billing/receipts').set(H(f.p)).send({ clientId: c, receivedOn: '2026-10-01', amountPaise: 1_000, tdsPaise: 500, mode: 'cash' }).expect(400); // TDS needs a section
    // Overpayment → advance; manual over-allocation refused.
    const r2 = (await t.http().post('/v1/billing/receipts').set(H(f.p)).send({ clientId: c, receivedOn: '2026-10-02', amountPaise: 50_000, mode: 'upi' }).expect(201)).body;
    expect(r2.allocations).toEqual([{ invoiceId: i2, amountPaise: 37_000, tdsPaise: 0 }]);
    expect((await t.http().get(`/v1/billing/receipts/${r2.id}`).set(H(f.p)).expect(200)).body).toMatchObject({ allocatedPaise: 37_000, unallocatedPaise: 13_000 });
    const i4 = await draft(f.p, c, [line(20_000)]); await issue(f.p, i4, '2026-10-10', '2026-10-25').expect(200); // 23600
    expect((await t.http().post(`/v1/billing/receipts/${r2.id}/apply`).set(H(f.p)).send({ allocations: [{ invoiceId: i4, amountPaise: 20_000 }] }).expect(400)).body.code).toBe('over_allocated');
    expect((await t.http().post(`/v1/billing/receipts/${r2.id}/apply`).set(H(f.p)).send({}).expect(200)).body.allocations).toEqual([{ invoiceId: i4, amountPaise: 13_000, tdsPaise: 0 }]);
    expect(await get(f.p, i4)).toMatchObject({ balancePaise: 10_600, status: 'partially_paid' });
    // Credit note on c2's invoice, then ageing as of 2026-11-20.
    await t.http().post(`/v1/billing/invoices/${i3}/notes`).set(H(f.p)).send({ kind: 'credit_note', date: '2026-10-20', reason: 'Goodwill', lines: [{ description: 'Disc', taxablePaise: 20_000 }] }).expect(201);
    const ag = (await t.http().get('/v1/billing/ageing?asOf=2026-11-20').set(H(f.p)).expect(200)).body;
    const byC = Object.fromEntries(ag.clients.map((x: { clientId: string }) => [x.clientId, x]));
    expect(byC[c].buckets).toMatchObject({ d0_30: 10_600, d31_60: 0 }); // i4 due 10-25 → 26 days
    expect(byC[c2].buckets).toMatchObject({ d31_60: 236_000 - 23_600 }); // i3 due 10-15 → 36 days
    const out1 = (await t.http().get(`/v1/billing/clients/${c}/outstanding`).set(H(f.p)).expect(200)).body;
    const out2 = (await t.http().get(`/v1/billing/clients/${c2}/outstanding`).set(H(f.p)).expect(200)).body;
    expect(out1).toMatchObject({ outstandingPaise: 10_600, advancePaise: 0 });
    expect(ag.totals.totalPaise).toBe(out1.outstandingPaise + out2.outstandingPaise);
    expect(Object.values(ag.totals).slice(0, 5).reduce((s: number, x) => s + (x as number), 0)).toBe(ag.totals.totalPaise);
    const listed = (await t.http().get('/v1/billing/invoices?status=issued,partially_paid').set(H(f.p)).expect(200)).body.items;
    expect(listed.reduce((s: number, x: { balancePaise: number }) => s + x.balancePaise, 0)).toBe(ag.totals.totalPaise);
    // Every invoice satisfies balance = total − allocations − TDS − credits (DB check).
    const bad = await t.sql(`SELECT id FROM invoice i WHERE kind <> 'credit_note' AND status NOT IN ('draft','cancelled') AND balance_paise <> total_paise
      - (SELECT COALESCE(sum(amount_paise + tds_paise),0) FROM receipt_allocation a WHERE a.invoice_id = i.id)
      - credited_paise OR credited_paise + (SELECT COALESCE(sum(balance_paise),0) FROM invoice n WHERE n.against_invoice_id = i.id AND n.kind = 'credit_note')
        <> (SELECT COALESCE(sum(total_paise),0) FROM invoice n WHERE n.against_invoice_id = i.id AND n.kind = 'credit_note')`);
    expect(bad).toEqual([]);
    expect((await t.http().get(`/v1/billing/receipts/${r1.id}/pdf`).set(H(f.p)).expect(200)).headers['content-type']).toBe('application/pdf');
  });
});

describe('auto-billing and retainers', () => {
  it('drafts per client from done-unbilled tasks with rate tables; idempotent; tasks billed; delete/cancel un-bills', async () => {
    const f = await firm('bl5');
    const a = await client(f.p, 'Auto A Ltd');
    const b = await client(f.p, 'Auto B Ltd');
    await t.http().post('/v1/billing/rates').set(H(f.p)).send({ serviceTypeId: f.g3b, clientId: b, amountPaise: 250_000, effectiveFrom: '2026-04-01' }).expect(201); // client override
    const ta1 = await doneTask(f.p, a, f.g3b, 'GSTR-3B Aug');
    const ta2 = await doneTask(f.p, a, f.g1, 'GSTR-1 Aug');
    const tb = await doneTask(f.p, b, f.g3b, 'GSTR-3B Aug');
    const unb = (await t.http().get('/v1/billing/unbilled').set(H(f.p)).expect(200)).body;
    expect(unb).toMatchObject({ count: 3, suggestedTotalPaise: 150_000 + 100_000 + 250_000 });
    const prev = (await t.http().post('/v1/billing/auto/preview').set(H(f.p)).send({ to: '2099-12-31' }).expect(200)).body;
    expect(prev).toMatchObject({ invoices: 2, tasks: 3, unpriced: [] });
    const com = (await t.http().post('/v1/billing/auto/commit').set(H(f.p)).send({ to: '2099-12-31' }).expect(200)).body;
    expect(com).toMatchObject({ created: 2, skipped: 0 });
    expect((await t.http().post('/v1/billing/auto/commit').set(H(f.p)).send({ to: '2099-12-31' }).expect(200)).body.created).toBe(0);
    for (const id of [ta1, ta2, tb]) expect((await t.http().get(`/v1/tasks/${id}`).set(H(f.p)).expect(200)).body.outcome).toBe('billed');
    expect((await t.http().get('/v1/billing/unbilled').set(H(f.p)).expect(200)).body.count).toBe(0);
    const invB = (await t.http().get(`/v1/billing/invoices?clientId=${b}`).set(H(f.p)).expect(200)).body.items[0];
    expect(invB).toMatchObject({ source: 'auto', taxablePaise: 250_000 });
    // A task can sit on only one live invoice: REST and the unique index both refuse.
    expect((await t.http().post('/v1/billing/invoices').set(H(f.p)).send({ clientId: b, lines: [line(1_000, { taskIds: [tb] })] }).expect(409)).body.code).toBe('task_not_billable');
    const [link] = await t.sql<{ invoice_id: string; line_id: string; tenant_id: string }>('SELECT * FROM invoice_task WHERE task_id = $1', [tb]);
    await expect(t.sql('INSERT INTO invoice_task (tenant_id, invoice_id, line_id, task_id) VALUES ($1,$2,$3,$4)', [link!.tenant_id, link!.invoice_id, (await get(f.p, com.ids[0])).lines[0].id, tb])).rejects.toThrow(/invoice_task_once|duplicate/);
    // Deleting the draft un-bills its tasks; cancelling an issued invoice too.
    await t.http().delete(`/v1/billing/invoices/${invB.id}`).set(H(f.p)).expect(204);
    expect((await t.http().get(`/v1/tasks/${tb}`).set(H(f.p)).expect(200)).body.outcome).toBeNull();
    const invA = (await t.http().get(`/v1/billing/invoices?clientId=${a}`).set(H(f.p)).expect(200)).body.items[0];
    await issue(f.p, invA.id).expect(200);
    await t.http().post(`/v1/billing/invoices/${invA.id}/cancel`).set(H(f.p)).send({ reason: 'Re-bill together' }).expect(204);
    expect((await t.http().get('/v1/billing/unbilled').set(H(f.p)).expect(200)).body.count).toBe(3);
    expect((await t.http().post('/v1/billing/auto/commit').set(H(f.p)).send({ to: '2099-12-31' }).expect(200)).body.created).toBe(2);
  });

  it('retainer drafts once per subscription × period and link the period\'s done tasks', async () => {
    const f = await firm('bl6');
    const c = await client(f.p, 'Retainer Ltd');
    await t.http().put(`/v1/clients/${c}/services/${f.g3b}`).set(H(f.p)).send({ billingFrequency: 'monthly' }).expect(200);
    const task = (await t.http().post('/v1/tasks').set(H(f.p)).send({ client_id: c, service_type_id: f.g3b, period_key: '2026-09', title: 'GSTR-3B Sep', status: 'done', checks: [] }).expect(201)).body.id;
    expect((await t.http().post('/v1/billing/auto/preview').set(H(f.p)).send({ to: '2099-12-31' }).expect(200)).body.tasks).toBe(0); // covered by the retainer
    expect((await t.http().post('/v1/billing/retainers/preview').set(H(f.p)).send({ month: '2026-09' }).expect(200)).body.toCreate).toBe(1);
    const r = (await t.http().post('/v1/billing/retainers/commit').set(H(f.p)).send({ month: '2026-09' }).expect(200)).body;
    expect(r.created).toBe(1);
    expect((await t.http().post('/v1/billing/retainers/commit').set(H(f.p)).send({ month: '2026-09' }).expect(200)).body).toMatchObject({ created: 0, skipped: 1 });
    const inv = await get(f.p, r.ids[0]);
    expect(inv).toMatchObject({ source: 'retainer', periodKey: '2026-09', taxablePaise: 150_000 });
    expect(inv.lines[0].taskIds).toEqual([task]);
    expect((await t.http().get(`/v1/tasks/${task}`).set(H(f.p)).expect(200)).body.outcome).toBe('billed');
  });
});

describe('follow-ups', () => {
  it('ladder steps once per invoice × step × channel, link only, stops on promise-to-pay and payment, escalates', async () => {
    const f = await firm('bl7');
    const outbox = t.app.get<MockMessenger>(CLIENT_MESSENGER).outbox;
    const col = t.app.get(CollectionsService);
    const c = await client(f.p, 'Slow Payer Ltd');
    const id = await draft(f.p, c, [line(100_000)]); await issue(f.p, id, '2026-09-30', '2026-10-15').expect(200);
    const run = (asOf: string) => col.runFollowups(f.p.tenantId, asOf);
    expect(await run('2026-10-14')).toMatchObject({ sent: 0 });
    expect(await run('2026-10-15')).toMatchObject({ sent: 1 });
    expect(await run('2026-10-15')).toMatchObject({ sent: 0 }); // idempotent
    const msg = outbox.filter((m) => m.invoiceId === id);
    expect(msg).toHaveLength(1);
    expect(msg[0]).toMatchObject({ channel: 'email', to: 'slow@client.in' });
    expect(msg[0]!.text).toContain('SMA/2627/0001');
    expect(msg[0]!.text).not.toMatch(/GSTIN|PAN|password/i);
    const link = /https?:\/\/\S+\/billing\/public\/(\S+)$/.exec(msg[0]!.text)![1]!;
    expect((await t.http().get(`/v1/billing/public/${link}`).expect(200)).headers['content-type']).toBe('application/pdf');
    await t.http().get(`/v1/billing/public/${link.slice(0, -2)}xx`).expect(404);
    expect(await run('2026-10-22')).toMatchObject({ sent: 2 }); // step 1: email + WhatsApp
    await t.http().post(`/v1/billing/invoices/${id}/follow-up`).set(H(f.p)).send({ promiseToPay: '2026-11-05' }).expect(204);
    expect(await run('2026-11-01')).toMatchObject({ sent: 0, escalated: 0 }); // promise pending
    await t.http().post('/v1/billing/receipts').set(H(f.p)).send({ clientId: c, receivedOn: '2026-11-06', amountPaise: 118_000, mode: 'bank' }).expect(201);
    expect(await run('2026-11-10')).toMatchObject({ sent: 0, escalated: 0 }); // paid → stops
    // Escalation (+15 days) notifies the client's partner in-app.
    const c2 = await client(f.p, 'Escalate Ltd', { partnerId: f.p.userId });
    const id2 = await draft(f.p, c2, [line(10_000)]); await issue(f.p, id2, '2026-09-30', '2026-10-01').expect(200);
    expect(await run('2026-10-20')).toMatchObject({ sent: 2, escalated: 1 });
    expect(await run('2026-10-21')).toMatchObject({ sent: 0, escalated: 0 });
    const notes = (await t.http().get('/v1/notifications').set(H(f.p)).expect(200)).body;
    expect(JSON.stringify(notes)).toContain('Overdue: SMA/2627/0002');
    const log = (await get(f.p, id2)).messages;
    expect(log.map((m: { kind: string; channel: string }) => `${m.kind}:${m.channel}`).sort()).toEqual(['escalation:in_app', 'followup:email', 'followup:whatsapp']);
    expect(log.find((m: { channel: string }) => m.channel === 'email').recipient).toBeUndefined(); // masked recipient not exposed in API
  });
});

describe('payment links and webhook', () => {
  it('signed webhook records a receipt once; bad signature and replays do nothing', async () => {
    const f = await firm('bl8');
    const c = await client(f.p, 'Online Payer Ltd');
    const id = await draft(f.p, c, [line(100_000)]); await issue(f.p, id).expect(200);
    const pl = (await t.http().post(`/v1/billing/invoices/${id}/payment-link`).set(H(f.p)).send({ amountPaise: 1 }).expect(201)).body;
    expect(pl).toMatchObject({ provider: 'mock', amountPaise: 118_000 }); // server-computed balance, client input ignored
    const linkId = pl.url.split('/').pop();
    const body = JSON.stringify({ id: 'evt_1', type: 'payment.captured', linkId, paymentId: 'pay_1', amountPaise: 118_000 });
    const sig = createHmac('sha256', 'worko-dev-webhook-secret').update(body).digest('hex');
    const url = `/v1/billing/webhooks/mock/${f.p.tenantId}`;
    await t.http().post(url).set('Content-Type', 'application/json').set('x-worko-signature', 'deadbeef').send(body).expect(401);
    await t.http().post(url).set('Content-Type', 'application/json').set('x-worko-signature', sig).send(body.replace('118000', '1')).expect(401); // tampered
    const ok = (await t.http().post(url).set('Content-Type', 'application/json').set('x-worko-signature', sig).send(body).expect(200)).body;
    expect(ok).toMatchObject({ status: 'receipt_recorded' });
    expect((await t.http().post(url).set('Content-Type', 'application/json').set('x-worko-signature', sig).send(body).expect(200)).body).toEqual({ status: 'duplicate' });
    expect(await get(f.p, id)).toMatchObject({ status: 'paid', balancePaise: 0 });
    const recs = (await t.http().get(`/v1/billing/receipts?clientId=${c}`).set(H(f.p)).expect(200)).body;
    expect(recs.total).toBe(1);
    expect(recs.items[0]).toMatchObject({ source: 'gateway', mode: 'online', amountPaise: 118_000 });
    expect((await t.sql(`SELECT action FROM audit_log WHERE action IN ('payment.webhook','receipt.created') AND tenant_id = $1`, [f.p.tenantId])).length).toBe(2);
  });
});

describe('Tally export', () => {
  it('dry-run reports unmapped ledgers; export is idempotent unless forced', async () => {
    const f = await firm('bl9');
    const c = await client(f.p, 'Tally & Sons');
    const id = await draft(f.p, c, [line(100_000)]); await issue(f.p, id, '2026-09-30').expect(200);
    await t.http().post('/v1/billing/receipts').set(H(f.p)).send({ clientId: c, receivedOn: '2026-10-01', amountPaise: 118_000, mode: 'bank' }).expect(201);
    const q = { entityId: f.e1, from: '2026-04-01', to: '2027-03-31' };
    const dry = (await t.http().post('/v1/billing/tally/dry-run').set(H(f.p)).send(q).expect(200)).body;
    expect(dry.count).toBe(0);
    expect(dry.errors.map((e: { account: string }) => e.account)).toEqual(expect.arrayContaining(['sales', 'output_cgst', 'output_sgst', 'bank']));
    expect((await t.http().post('/v1/billing/tally/export').set(H(f.p)).send(q).expect(400)).body.code).toBe('tally_validation');
    await t.http().put('/v1/billing/tally/ledgers').set(H(f.p)).send([
      { accountKey: 'sales', ledgerName: 'Professional Fees' }, { accountKey: 'output_cgst', ledgerName: 'Output CGST 9%' }, { accountKey: 'output_sgst', ledgerName: 'Output SGST 9%' },
      { accountKey: 'bank', ledgerName: 'HDFC Bank' }, { accountKey: `party:${c}`, ledgerName: 'Tally & Sons (Debtor)' }]).expect(204);
    const ok = (await t.http().post('/v1/billing/tally/dry-run').set(H(f.p)).send(q).expect(200)).body;
    expect(ok).toMatchObject({ errors: [], count: 2, invoices: 1, receipts: 1 });
    expect(ok.xml).toContain('<VOUCHERNUMBER>SMA/2627/0001</VOUCHERNUMBER>');
    expect(ok.xml).toContain('<PARTYLEDGERNAME>Tally &amp; Sons (Debtor)</PARTYLEDGERNAME>');
    expect((await t.http().post('/v1/billing/tally/export').set(H(f.p)).send(q).expect(200)).body.count).toBe(2);
    expect((await t.http().post('/v1/billing/tally/export').set(H(f.p)).send(q).expect(200)).body.count).toBe(0);
    expect((await t.http().post('/v1/billing/tally/export').set(H(f.p)).send({ ...q, force: true }).expect(200)).body.count).toBe(2);
    expect((await t.sql<{ times: number }>('SELECT times FROM tally_export_log WHERE source_id = $1', [id]))[0]!.times).toBe(2);
    const acc = await t.addUser(f.p, 'bl9', 'Meena', 'accountant');
    await t.http().post('/v1/billing/tally/dry-run').set(H(acc)).send(q).expect(200); // accountant: firm-wide billing:export
    const mgr = await t.addUser(f.p, 'bl9', 'Mohan', 'manager');
    await t.http().post('/v1/billing/tally/dry-run').set(H(mgr)).send(q).expect(403); // team scope only
  });
});

describe('permissions, visibility, exports, sync', () => {
  it('client-scoped: invisible invoices are 404; roles gate actions; exports are audited and injection-safe', async () => {
    const f = await firm('bl10');
    const mgr = await t.addUser(f.p, 'bl10', 'Mohan', 'manager');
    const art = await t.addUser(f.p, 'bl10', 'Arti', 'article');
    const acc = await t.addUser(f.p, 'bl10', 'Meena', 'accountant');
    const mine = await client(f.p, 'Managed Ltd', { managerId: mgr.userId, staffIds: [art.userId] });
    const other = await client(f.p, '=HYPERLINK("http://x") Ltd');
    const i1 = await draft(f.p, mine, [line(10_000)]); await issue(f.p, i1).expect(200);
    const i2 = await draft(f.p, other, [line(20_000)]); await issue(f.p, i2).expect(200);
    // Manager (team scope via ownership) sees only their client's invoice; the other is 404 (not 403).
    expect((await t.http().get('/v1/billing/invoices').set(H(mgr)).expect(200)).body.items.map((x: { id: string }) => x.id)).toEqual([i1]);
    await t.http().get(`/v1/billing/invoices/${i2}`).set(H(mgr)).expect(404);
    await t.http().get(`/v1/billing/invoices/${i2}/pdf`).set(H(mgr)).expect(404);
    await t.http().post('/v1/billing/receipts').set(H(mgr)).send({ clientId: other, receivedOn: '2026-10-01', amountPaise: 100, mode: 'cash' }).expect(404);
    const ag = (await t.http().get('/v1/billing/ageing?asOf=2026-10-01').set(H(mgr)).expect(200)).body;
    expect(ag.clients.map((x: { clientId: string }) => x.clientId)).toEqual([mine]);
    // Article: no billing permission at all.
    await t.http().get('/v1/billing/invoices').set(H(art)).expect(403);
    await t.http().get(`/v1/billing/invoices/${i1}`).set(H(art)).expect(403);
    // Accountant creates/issues but cannot cancel or note (billing:approve), nor change firm config.
    const i3 = await draft(acc, mine, [line(5_000)]);
    await issue(acc, i3).expect(200);
    await t.http().post(`/v1/billing/invoices/${i3}/cancel`).set(H(acc)).send({ reason: 'nope' }).expect(403);
    await t.http().post('/v1/billing/rates').set(H(acc)).send({ serviceTypeId: f.g3b, amountPaise: 1, effectiveFrom: '2026-04-01' }).expect(403);
    await t.http().post(`/v1/billing/invoices/${i3}/cancel`).set(H(mgr)).send({ reason: 'Manager cancels' }).expect(204);
    // Exports: audited, formula-safe, scoped.
    const csv = (await t.http().get('/v1/billing/invoices/export?format=csv').set(H(f.p)).expect(200)).text;
    expect(csv).toContain(`"'=HYPERLINK(""http://x"") Ltd"`);
    const mcsv = (await t.http().get('/v1/billing/invoices/export?format=csv').set(H(mgr)).expect(200)).text;
    expect(mcsv).not.toContain('HYPERLINK');
    await t.http().get('/v1/billing/receipts/export?format=xlsx').set(H(f.p)).expect(200);
    const audit = await t.sql<{ action: string; diff: { rows: number } }>(`SELECT action, diff FROM audit_log WHERE tenant_id = $1 AND action IN ('invoice.exported','receipt.exported') ORDER BY seq`, [f.p.tenantId]);
    expect(audit.map((x) => x.action)).toEqual(['invoice.exported', 'invoice.exported', 'receipt.exported']);
    // Sync: headers reach devices read-only, client-scoped; the article never receives billing rows.
    const pull = async (s: Session) => (await t.http().get('/v1/sync/pull?since=0&limit=1000').set(H(s)).expect(200)).body.changes as Array<{ table: string; id: string; fields: Record<string, unknown> }>;
    const mp = (await pull(mgr)).filter((x) => x.table === 'invoice');
    expect(mp.map((x) => x.id).sort()).toEqual([i1, i3].sort());
    expect(mp.find((x) => x.id === i1)!.fields).toMatchObject({ number: 'SMA/2627/0001', total_paise: '11800' }); // bigint paise ship as decimal strings
    expect((await pull(art)).some((x) => x.table === 'invoice' || x.table === 'receipt')).toBe(false);
    const res = (await t.http().post('/v1/sync/push').set(H(f.p)).send({ mutations: [{ key: 'device-key-0001', table: 'invoice', id: i1, baseVersion: 1, patch: { notes: 'x' } }] }).expect(200)).body.results;
    expect(res[0].status).toBe('rejected');
  });
});

describe('billing jobs', () => {
  it('daily follow-up and monthly retainer jobs run on the queue clock and reschedule themselves', async () => {
    const f = await firm('bl11');
    const c = await client(f.p, 'Job Ltd');
    await t.http().put(`/v1/clients/${c}/services/${f.g3b}`).set(H(f.p)).send({ billingFrequency: 'monthly' }).expect(200);
    const id = await draft(f.p, c, [line(10_000)]); await issue(f.p, id, '2026-09-01', '2026-09-16').expect(200);
    const jobs = t.app.get(JobQueueService);
    const at = new Date('2026-10-01T10:00:00+05:30');
    await t.app.get(CollectionsService).scheduleDaily(at);
    await t.app.get(BillingAutoService).scheduleMonthly(at);
    await t.app.get(BillingAutoService).scheduleMonthly(at); // one live job per tenant × kind
    await jobs.runOnce(500, at);
    const q = await t.sql<{ kind: string; run_at: Date }>(`SELECT kind, run_at FROM job_queue WHERE tenant_id = $1 AND kind LIKE 'billing.%' ORDER BY kind`, [f.p.tenantId]);
    expect(q.map((x) => [x.kind, x.run_at.toISOString()])).toEqual([['billing.followups', '2026-10-02T04:30:00.000Z'], ['billing.retainers', '2026-10-31T21:30:00.000Z']]);
    expect((await get(f.p, id)).messages.map((m: { step: number }) => m.step)).toEqual([2, 2]); // 15 days past due → latest step only
    const ret = (await t.http().get(`/v1/billing/invoices?clientId=${c}&kind=invoice`).set(H(f.p)).expect(200)).body.items.filter((x: { source: string }) => x.source === 'retainer');
    expect(ret).toHaveLength(1);
    expect(ret[0].periodKey).toBe('2026-09');
  });
});

describe('phase 5 review fixes', () => {
  const sign = (body: string, secret = 'worko-dev-webhook-secret') => createHmac('sha256', secret).update(body).digest('hex');
  const hook = (tenantId: string, body: string, sig: string, provider = 'mock') =>
    t.http().post(`/v1/billing/webhooks/${provider}/${tenantId}`).set('Content-Type', 'application/json').set('x-worko-signature', sig).send(body);

  it('webhook: bad signature or unknown tenant writes nothing; mock route off unless PAYMENT_PROVIDER=mock outside production; prod refuses weak config', async () => {
    const f = await firm('rv1');
    const body = JSON.stringify({ id: 'evt_x', type: 'payment.captured', linkId: 'plink_nope', paymentId: 'pay_x', amountPaise: 100 });
    await hook(f.p.tenantId, body, 'bad').expect(401);
    await hook('00000000-0000-0000-0000-000000000000', body, sign(body)).expect(404);
    await hook('not-a-uuid', body, sign(body)).expect(404);
    expect(await t.sql('SELECT 1 FROM payment_event WHERE tenant_id = $1', [f.p.tenantId])).toEqual([]);
    const env = { ...process.env };
    try {
      process.env.PAYMENT_PROVIDER = 'razorpay';
      await hook(f.p.tenantId, body, sign(body)).expect(404);
      process.env.PAYMENT_PROVIDER = 'mock'; process.env.PAYMENT_WEBHOOK_SECRET = ''; // empty ⇒ dev default, never an empty key
      await hook(f.p.tenantId, body, sign(body, '')).expect(401);
      process.env.NODE_ENV = 'production';
      await hook(f.p.tenantId, body, sign(body)).expect(404);
      expect(() => assertPaymentConfig()).toThrow(/mock/);
      process.env.PAYMENT_PROVIDER = 'razorpay'; process.env.RAZORPAY_WEBHOOK_SECRET = '';
      expect(() => assertPaymentConfig()).toThrow(/RAZORPAY_WEBHOOK_SECRET/);
      process.env.RAZORPAY_WEBHOOK_SECRET = 'a-real-secret';
      expect(() => assertPaymentConfig()).not.toThrow();
    } finally { for (const k of ['PAYMENT_PROVIDER', 'PAYMENT_WEBHOOK_SECRET', 'NODE_ENV', 'RAZORPAY_WEBHOOK_SECRET']) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; } }
  });

  it('follow-ups: a failed send is retried (bounded) without re-sending the ones that went out', async () => {
    const f = await firm('rv2');
    const m = t.app.get<MockMessenger>(CLIENT_MESSENGER);
    const col = t.app.get(CollectionsService);
    const ids = [];
    for (const n of ['Alpha', 'Bravo', 'Charlie']) {
      const c = await client(f.p, `${n} Ltd`);
      const id = await draft(f.p, c, [line(10_000)]); await issue(f.p, id, '2026-09-30', '2026-10-15').expect(200); ids.push(id);
    }
    m.failTo.add('bravo@client.in');
    expect(await col.runFollowups(f.p.tenantId, '2026-10-15')).toMatchObject({ sent: 2, failed: 1 });
    expect(await col.runFollowups(f.p.tenantId, '2026-10-15')).toMatchObject({ sent: 0, failed: 1 }); // retry #2, others untouched
    m.failTo.delete('bravo@client.in');
    expect(await col.runFollowups(f.p.tenantId, '2026-10-15')).toMatchObject({ sent: 1, failed: 0 });
    expect(await col.runFollowups(f.p.tenantId, '2026-10-15')).toMatchObject({ sent: 0, failed: 0 });
    for (const id of ids) expect(m.outbox.filter((x) => x.invoiceId === id)).toHaveLength(1);
    const [row] = await t.sql<{ attempts: number; status: string }>('SELECT attempts, status FROM billing_message WHERE invoice_id = $1', [ids[1]]);
    expect(row).toMatchObject({ attempts: 3, status: 'sent' });
    // Bounded: after 3 failed attempts the slot is not claimed again.
    m.failTo.add('alpha@client.in');
    expect(await col.runFollowups(f.p.tenantId, '2026-10-22')).toMatchObject({ failed: 1 });
    await col.runFollowups(f.p.tenantId, '2026-10-22'); await col.runFollowups(f.p.tenantId, '2026-10-22');
    expect(await col.runFollowups(f.p.tenantId, '2026-10-22')).toMatchObject({ failed: 0 });
    m.failTo.delete('alpha@client.in');
    await t.http().post('/v1/billing/follow-ups/run').set(H(f.p)).send({ asOf: '2027-07-01' }).expect(400); // after "today" (pinned 2027-06-30)
  });

  it('notes: GST rate must be on the invoice, caps per tax head, reimbursements untaxed, credit on a paid invoice becomes client credit', async () => {
    const f = await firm('rv3');
    const c = await client(f.p, 'Paid Ltd');
    const id = await draft(f.p, c, [line(100_000), { description: 'Stamp paper', ratePaise: 5_000, reimbursement: true }]);
    await issue(f.p, id).expect(200); // 118000 + 5000 = 123000
    const note = (lines: unknown[], kind = 'credit_note') => t.http().post(`/v1/billing/invoices/${id}/notes`).set(H(f.p)).send({ kind, date: '2026-10-05', reason: 'Correction', lines });
    expect((await note([{ description: 'x', taxablePaise: 1_000, gstRate: 12 }]).expect(400)).body.code).toBe('gst_rate_not_on_invoice');
    expect((await note([{ description: 'x', taxablePaise: 1_000, gstRate: 12 }], 'debit_note').expect(400)).body.code).toBe('gst_rate_not_on_invoice');
    expect((await note([{ description: 'r', taxablePaise: 6_000, reimbursement: true }]).expect(409)).body.code).toBe('credit_exceeds_invoice');
    await t.http().post('/v1/billing/receipts').set(H(f.p)).send({ clientId: c, receivedOn: '2026-10-01', amountPaise: 123_000, mode: 'bank' }).expect(201);
    expect(await get(f.p, id)).toMatchObject({ status: 'paid', balancePaise: 0 });
    const cn = (await note([{ description: 'Fee cut', taxablePaise: 10_000 }, { description: 'Stamp refund', taxablePaise: 5_000, reimbursement: true }]).expect(201)).body;
    expect(await get(f.p, cn.id)).toMatchObject({ totalPaise: 16_800, cgstPaise: 900, reimbursementPaise: 5_000, balancePaise: 16_800 });
    expect((await get(f.p, cn.id)).lines[1]).toMatchObject({ reimbursement: true, cgstPaise: 0, sac: null });
    expect(await get(f.p, id)).toMatchObject({ status: 'paid', creditedPaise: 0, balancePaise: 0 });
    expect((await t.http().get(`/v1/billing/clients/${c}/outstanding`).set(H(f.p)).expect(200)).body).toMatchObject({ outstandingPaise: 0, creditPaise: 16_800, netPaise: -16_800 });
    expect((await note([{ description: 'more', taxablePaise: 95_000 }]).expect(409)).body.code).toBe('credit_exceeds_invoice'); // taxable cap 100000
  });

  it('superseding a payment link cancels it at the provider; money on it is recorded for review', async () => {
    const f = await firm('rv4');
    const c = await client(f.p, 'Link Ltd', { partnerId: f.p.userId });
    const id = await draft(f.p, c, [line(100_000)]); await issue(f.p, id).expect(200);
    const l1 = (await t.http().post(`/v1/billing/invoices/${id}/payment-link`).set(H(f.p)).expect(201)).body;
    await t.http().post(`/v1/billing/invoices/${id}/payment-link`).set(H(f.p)).expect(201);
    const old = l1.url.split('/').pop();
    expect((t.app.get<Record<string, MockPaymentProvider>>(PAYMENT_PROVIDERS).mock).cancelled).toContain(old);
    const body = JSON.stringify({ id: 'evt_old', type: 'payment.captured', linkId: old, paymentId: 'pay_old', amountPaise: 118_000 });
    expect((await hook(f.p.tenantId, body, sign(body)).expect(200)).body.status).toBe('receipt_needs_review');
    const rec = (await t.http().get(`/v1/billing/receipts?clientId=${c}`).set(H(f.p)).expect(200)).body.items[0];
    expect(rec).toMatchObject({ needsReview: true, unallocatedPaise: 118_000 });
    expect(await get(f.p, id)).toMatchObject({ balancePaise: 118_000 });
    expect(JSON.stringify((await t.http().get('/v1/notifications').set(H(f.p)).expect(200)).body)).toContain(`Review payment ${rec.number}`);
  });

  it('scoped users: client rates, party ledgers and receipt data follow visibility', async () => {
    const f = await firm('rv5');
    const mgr = await t.addUser(f.p, 'rv5', 'Mohan', 'manager');
    const mine = await client(f.p, 'Mine Ltd', { managerId: mgr.userId });
    const other = await client(f.p, 'Hidden Ltd');
    for (const c of [mine, other]) await t.http().post('/v1/billing/rates').set(H(f.p)).send({ serviceTypeId: f.g3b, clientId: c, amountPaise: 999, effectiveFrom: '2026-04-01' }).expect(201);
    await t.http().put('/v1/billing/tally/ledgers').set(H(f.p)).send([{ accountKey: `party:${mine}`, ledgerName: 'Mine' }, { accountKey: `party:${other}`, ledgerName: 'Hidden' }, { accountKey: 'sales', ledgerName: 'Fees' }]).expect(204);
    const rates = (await t.http().get('/v1/billing/rates').set(H(mgr)).expect(200)).body;
    expect(rates.map((r: { clientId: string | null }) => r.clientId).filter(Boolean)).toEqual([mine]);
    expect(rates.some((r: { clientId: string | null }) => r.clientId === null)).toBe(true);
    expect((await t.http().get('/v1/billing/tally/ledgers').set(H(mgr)).expect(200)).body.map((x: { ledgerName: string }) => x.ledgerName).sort()).toEqual(['Fees', 'Mine']);
    const id = await draft(f.p, mine, [line(10_000)]); await issue(f.p, id).expect(200);
    await t.http().post('/v1/billing/receipts').set(H(f.p)).send({ clientId: mine, receivedOn: '2026-10-01', amountPaise: 20_000, mode: 'bank' }).expect(201);
    expect((await get(mgr, id)).allocations).toHaveLength(1);
    // Billing without receipts: no allocations, advance unknown, no advances in ageing.
    await t.sql(`UPDATE role SET grants = (SELECT jsonb_agg(g) FROM jsonb_array_elements(grants) g WHERE g->>'module' <> 'receipts') WHERE key = 'manager' AND tenant_id = $1`, [f.p.tenantId]);
    expect((await get(mgr, id)).allocations).toEqual([]);
    expect((await t.http().get(`/v1/billing/clients/${mine}/outstanding`).set(H(mgr)).expect(200)).body.advancePaise).toBeNull();
    expect((await t.http().get('/v1/billing/ageing?asOf=2026-10-01').set(H(mgr)).expect(200)).body.totals.advancePaise).toBe(0);
    expect((await t.http().get('/v1/billing/ageing?asOf=2026-10-01').set(H(f.p)).expect(200)).body.totals.advancePaise).toBe(8_200);
  });

  it('issue date: not in the future, not before the last in the series; entity active; receipt entity inferred or required; cancelled links 404', async () => {
    const f = await firm('rv6');
    const c = await client(f.p, 'Dates Ltd');
    const a = await draft(f.p, c, [line(10_000)]);
    expect((await issue(f.p, a, '2027-07-01').expect(400)).body.code).toBe('date_in_future');
    await issue(f.p, a, '2026-10-10').expect(200);
    const b = await draft(f.p, c, [line(10_000)]);
    expect((await issue(f.p, b, '2026-10-09').expect(400)).body.code).toBe('date_before_last_issued');
    expect((await issue(f.p, b, '2026-10-10').expect(200)).body.number).toBe('SMA/2627/0002'); // failed attempt left no gap
    const e2draft = await draft(f.p, c, [line(10_000)], { entityId: f.e2 });
    await issue(f.p, e2draft, '2026-10-01').expect(200); // other series: independent
    // Receipt entity: open items in two entities → must choose; then inferred when unambiguous.
    expect((await t.http().post('/v1/billing/receipts').set(H(f.p)).send({ clientId: c, receivedOn: '2026-10-11', amountPaise: 100, mode: 'cash' }).expect(400)).body.code).toBe('entity_required');
    await t.http().post('/v1/billing/receipts').set(H(f.p)).send({ clientId: c, entityId: f.e2, receivedOn: '2026-10-11', amountPaise: 11_800, mode: 'cash' }).expect(201);
    const r = (await t.http().post('/v1/billing/receipts').set(H(f.p)).send({ clientId: c, receivedOn: '2026-10-11', amountPaise: 100, mode: 'cash' }).expect(201)).body;
    expect(r.number).toMatch(/^SMAR\//);
    // Inactive entity can't issue.
    const d3 = await draft(f.p, c, [line(10_000)], { entityId: f.e2 });
    await t.http().patch(`/v1/billing/entities/${f.e2}`).set(H(f.p)).send({ active: false }).expect(204);
    expect((await issue(f.p, d3, '2026-10-12').expect(409)).body.code).toBe('entity_inactive');
    // Public link of a cancelled invoice is dead.
    const x = await draft(f.p, c, [line(10_000)]); await issue(f.p, x, '2026-10-12').expect(200);
    await t.http().post(`/v1/billing/invoices/${x}/send`).set(H(f.p)).send({ channel: 'email' }).expect(200);
    const out = t.app.get<MockMessenger>(CLIENT_MESSENGER).outbox.filter((m) => m.invoiceId === x);
    const token = /\/billing\/public\/(\S+)$/.exec(out[0]!.text)![1]!;
    await t.http().get(`/v1/billing/public/${token}`).expect(200);
    await t.http().post(`/v1/billing/invoices/${x}/cancel`).set(H(f.p)).send({ reason: 'Raised in error' }).expect(204);
    await t.http().get(`/v1/billing/public/${token}`).expect(404);
  });
});
