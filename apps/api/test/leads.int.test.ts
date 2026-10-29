import { gstinCheckChar } from '@worko/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockChannelHub } from '../src/comm/channels.js';
import { Clock } from '../src/common/clock.js';
import { bearer, bootApp, type Session } from './helpers.js';

let t: Awaited<ReturnType<typeof bootApp>>;
let P: Session; let M: Session; let Art: Session; let hub: MockChannelHub;
let g3b: string; let roc: string; let existing: string;
const NOW = new Date('2026-10-29T10:00:00+05:30');
const H = (s: Session) => bearer(s.accessToken);
const FIRM = 'leadsco';
function gstin(state: string, pan: string) { const base = `${state}${pan}1Z`; return base + gstinCheckChar(base); }
const tokenOf = (link: string) => link.split('/proposals/public/')[1]!;
const lead = async (s: Session, b: Record<string, unknown>) => (await t.http().post('/v1/leads').set(H(s)).send({ source: 'referral', ...b }).expect(201)).body;

beforeAll(async () => {
  t = await bootApp();
  t.app.get(Clock).set(NOW);
  hub = t.app.get(MockChannelHub);
  P = await t.signup(FIRM);
  M = await t.addUser(P, FIRM, 'Mona', 'manager');
  Art = await t.addUser(P, FIRM, 'Arjun', 'article');
  const [e1] = (await t.http().get('/v1/billing/entities').set(H(P)).expect(200)).body;
  await t.http().patch(`/v1/billing/entities/${e1.id}`).set(H(P)).send({ gstin: gstin('27', 'AABCL0001Z'), invoicePrefix: 'LC' }).expect(204);
  await t.http().put('/v1/billing/settings').set(H(P)).send({ defaultEntityId: e1.id }).expect(204);
  await t.http().post('/v1/service-types/install-defaults').set(H(P)).expect(200);
  const st = (await t.http().get('/v1/service-types').set(H(P)).expect(200)).body as Array<{ id: string; key: string }>;
  g3b = st.find((s) => s.key === 'GSTR3B')!.id; roc = st.find((s) => s.key !== 'GSTR3B')!.id;
  await t.http().post('/v1/billing/rates').set(H(P)).send({ serviceTypeId: g3b, amountPaise: 250_000, effectiveFrom: '2026-04-01' }).expect(201);
  existing = (await t.http().post('/v1/clients').set(H(P)).send({ name: 'Existing Steels Pvt Ltd', entityType: 'PRIVATE_COMPANY', pan: 'AABCE1234F', phone: '+919811100000',
    contacts: [{ name: 'Old Owner', email: 'owner@steels.example', isPrimary: true }] }).expect(201)).body.id;
}, 90_000);
afterAll(() => t?.close());

describe('leads pipeline (M4)', () => {
  it('permissions: leads module gates every route', async () => {
    await t.http().get('/v1/leads').set(H(Art)).expect(403);
    await t.http().post('/v1/leads').set(H(Art)).send({ name: 'x' }).expect(403);
  });

  it('duplicate check by PAN/GSTIN/phone/email against clients and leads; invisible clients only counted', async () => {
    const l = await lead(P, { name: 'Steel Buyer', company: 'Existing Steels', pan: 'AABCE1234F', email: 'buyer@new.example' });
    expect(l.duplicates.clients).toEqual([expect.objectContaining({ id: existing, matchedOn: ['pan'] })]);
    expect((await t.http().get('/v1/leads/duplicates?phone=98111%2000000').set(H(P)).expect(200)).body.clients[0].id).toBe(existing);
    expect((await t.http().get(`/v1/leads/duplicates?gstin=${gstin('27', 'AABCE1234F')}`).set(H(P)).expect(200)).body.clients[0].id).toBe(existing);
    expect((await t.http().get('/v1/leads/duplicates?email=OWNER@steels.example').set(H(P)).expect(200)).body.clients).toHaveLength(1);
    expect((await t.http().get('/v1/leads/duplicates?email=buyer@new.example').set(H(P)).expect(200)).body.leads[0].id).toBe(l.id);
    // A manager who can't see the client learns only that a match exists.
    const asM = (await t.http().get('/v1/leads/duplicates?pan=AABCE1234F').set(H(M)).expect(200)).body;
    expect(asM).toMatchObject({ clients: [], hiddenClients: 1 });
  });

  it('kanban: moves validated (lost needs reason, won only via conversion, lost reopens), ordering by neighbours, activity log', async () => {
    const a = await lead(P, { name: 'A', company: 'Aco' }); const b = await lead(P, { name: 'B', company: 'Bco' }); const c = await lead(P, { name: 'C', company: 'Cco' });
    await t.http().post(`/v1/leads/${a.id}/move`).set(H(P)).send({ stage: 'qualified' }).expect(200);
    await t.http().post(`/v1/leads/${b.id}/move`).set(H(P)).send({ stage: 'qualified' }).expect(200);
    const pos = (await t.http().post(`/v1/leads/${c.id}/move`).set(H(P)).send({ stage: 'qualified', beforeId: a.id, afterId: b.id }).expect(200)).body.position;
    const col = (await t.http().get('/v1/leads/board').set(H(P)).expect(200)).body.find((x: { stage: string }) => x.stage === 'qualified');
    expect(col.items.map((x: { id: string }) => x.id)).toEqual([a.id, c.id, b.id]);
    expect(pos).toBeGreaterThan(col.items[0].position);
    expect((await t.http().post(`/v1/leads/${a.id}/move`).set(H(P)).send({ stage: 'lost' }).expect(400)).body.code).toBe('lost_reason_required');
    await t.http().post(`/v1/leads/${a.id}/move`).set(H(P)).send({ stage: 'lost', lostReason: 'Went with another firm' }).expect(200);
    expect((await t.http().post(`/v1/leads/${a.id}/move`).set(H(P)).send({ stage: 'proposal' }).expect(400)).body.code).toBe('invalid_transition');
    await t.http().post(`/v1/leads/${a.id}/move`).set(H(P)).send({ stage: 'contacted' }).expect(200);
    expect((await t.http().post(`/v1/leads/${b.id}/move`).set(H(P)).send({ stage: 'won' }).expect(400)).body.code).toBe('convert_to_win');
    await t.http().post(`/v1/leads/${b.id}/move`).set(H(P)).send({ stage: 'qualified', beforeId: c.id, afterId: a.id }).expect(400); // neighbour in another column
    const d = await lead(P, { name: 'D', company: 'Dco', nextFollowupOn: '2026-11-02' });
    await t.http().post(`/v1/leads/${d.id}/activities`).set(H(P)).send({ kind: 'call', body: 'Intro call' }).expect(201);
    const got = (await t.http().get(`/v1/leads/${d.id}`).set(H(P)).expect(200)).body;
    expect(got.stage).toBe('contacted'); // first contact moves "new" on
    expect(got.activities.map((x: { kind: string }) => x.kind)).toEqual(expect.arrayContaining(['call', 'stage', 'system']));
    expect((await t.sql(`SELECT fire_at FROM notification WHERE category = 'lead.followup' AND entity_id = $1`, [d.id]))[0]).toEqual({ fire_at: new Date('2026-11-02T04:00:00Z') });
  });

  it('visibility: a manager sees own leads only; others are 404', async () => {
    const mine = await lead(M, { name: 'Mona lead' });
    const theirs = await lead(P, { name: 'Partner lead' });
    const list = (await t.http().get('/v1/leads').set(H(M)).expect(200)).body.items.map((x: { id: string }) => x.id);
    expect(list).toEqual([mine.id]);
    await t.http().get(`/v1/leads/${theirs.id}`).set(H(M)).expect(404);
    await t.http().post('/v1/leads').set(H(M)).send({ name: 'x', ownerId: P.userId }).expect(201); // manager holds leads:assign
  });
});

describe('proposals (versioned, e-accept, conversion)', () => {
  let leadId: string; let pid: string; let link1: string; let link2: string;

  it('lines from the catalogue + rate table (or overrides); GST via billing helpers by place of supply', async () => {
    leadId = (await lead(P, { name: 'Neha Shah', company: 'Navkar Foods LLP', email: 'neha@navkar.example', phone: '+919822233344', entityType: 'LLP', pan: 'AAFFN1234K' })).id;
    const r = (await t.http().post(`/v1/leads/${leadId}/proposals`).set(H(P)).send({ title: 'GST compliance', lines: [
      { serviceTypeId: g3b, frequency: 'monthly' }, { description: 'GST registration', frequency: 'one_time', feePaise: 500_000 }, { serviceTypeId: roc, frequency: 'annual', feePaise: 1_200_000, gstRate: 18 },
    ] }).expect(201)).body;
    pid = r.id;
    expect(r.number).toMatch(/^PR-\d{4}$/);
    expect(r.totals.supplyType).toBe('intra');
    expect(r.totals.byFrequency.monthly).toEqual({ taxablePaise: 250_000, taxPaise: 45_000, totalPaise: 295_000 });
    expect(r.totals.firstYear.taxablePaise).toBe(500_000 + 12 * 250_000 + 1_200_000);
    expect((await t.http().get(`/v1/leads/${leadId}`).set(H(P)).expect(200)).body.stage).toBe('proposal');
    expect((await t.http().patch(`/v1/proposals/${pid}`).set(H(P)).send({ placeOfSupply: '29' }).expect(200)).body).toMatchObject({ version: 1, newVersion: false, totals: { supplyType: 'inter' } });
    await t.http().patch(`/v1/proposals/${pid}`).set(H(P)).send({ placeOfSupply: '27' }).expect(200);
    const nr = await lead(P, { name: 'NoRate' });
    expect((await t.http().post(`/v1/leads/${nr.id}/proposals`).set(H(P)).send({ title: 'x', lines: [{ serviceTypeId: roc, frequency: 'annual' }] }).expect(400)).body.code).toBe('no_rate');
  });

  it('send → signed link by email; edit after send = new version (old link superseded); only the latest sent version can be accepted; replay-safe', async () => {
    const s1 = (await t.http().post(`/v1/proposals/${pid}/send`).set(H(P)).send({ channel: 'email' }).expect(200)).body;
    expect(s1).toMatchObject({ version: 1, status: 'sent' });
    expect(hub.outbox.find((m) => m.to === 'neha@navkar.example')!.text).toContain(s1.link);
    link1 = tokenOf(s1.link);
    expect((await t.http().get(`/v1/proposals/public/${link1}`).expect(200)).body).toMatchObject({ state: 'open', acceptable: true, version: 1, preparedFor: 'Navkar Foods LLP', validUntil: '2026-11-28' });
    const ed = (await t.http().patch(`/v1/proposals/${pid}`).set(H(P)).send({ lines: [{ serviceTypeId: g3b, frequency: 'monthly', feePaise: 220_000 }, { description: 'GST registration', frequency: 'one_time', feePaise: 500_000 }] }).expect(200)).body;
    expect(ed).toMatchObject({ version: 2, newVersion: true });
    const diff = (await t.http().get(`/v1/proposals/${pid}/diff?from=1&to=2`).set(H(P)).expect(200)).body;
    expect(diff.changed[0].fields).toEqual(['feePaise']);
    expect(diff.removed).toHaveLength(1);
    expect((await t.http().get(`/v1/proposals/public/${link1}`).expect(200)).body.state).toBe('superseded');
    expect((await t.http().post(`/v1/proposals/public/${link1}/accept`).send({ name: 'Neha Shah', agree: true }).expect(409)).body.code).toBe('superseded');
    // v1 stays immutable in the database
    await expect(t.sql(`UPDATE proposal_version SET lines = '[]' WHERE proposal_id = $1 AND version = 1`, [pid])).rejects.toThrow(/immutable/);
    link2 = tokenOf((await t.http().post(`/v1/proposals/${pid}/send`).set(H(P)).send({ channel: 'email' }).expect(200)).body.link);
    await t.http().post(`/v1/proposals/public/${link2}/accept`).send({ name: 'Neha Shah', agree: false }).expect(400);
    expect((await t.http().post(`/v1/proposals/public/${link2}/accept`).set('User-Agent', 'TestBrowser/1').send({ name: 'Neha Shah', agree: true }).expect(200)).body.status).toBe('accepted');
    expect((await t.http().post(`/v1/proposals/public/${link2}/accept`).send({ name: 'Neha Shah', agree: true }).expect(409)).body.code).toBe('already_decided');
    expect((await t.http().post(`/v1/proposals/public/${link2}/decline`).send({ reason: 'changed mind' }).expect(409)).body.code).toBe('already_decided');
    const p = (await t.http().get(`/v1/proposals/${pid}`).set(H(P)).expect(200)).body;
    expect(p).toMatchObject({ status: 'accepted', acceptedVersion: 2, acceptedName: 'Neha Shah' });
    expect((await t.sql<{ accepted_ua: string }>('SELECT accepted_ua FROM proposal WHERE id = $1', [pid]))[0]!.accepted_ua).toBe('TestBrowser/1');
    await t.http().patch(`/v1/proposals/${pid}`).set(H(P)).send({ title: 'x' }).expect(409);
    expect((await t.sql(`SELECT 1 FROM notification WHERE category = 'proposal.decided' AND entity_id = $1`, [pid])).length).toBe(1);
  });

  it('expiry and decline', async () => {
    const l = await lead(P, { name: 'Exp', email: 'exp@x.example' });
    const id = (await t.http().post(`/v1/leads/${l.id}/proposals`).set(H(P)).send({ title: 'Audit', validUntil: '2026-11-05', lines: [{ description: 'Tax audit', frequency: 'annual', feePaise: 3_000_000 }] }).expect(201)).body.id;
    const tok = tokenOf((await t.http().post(`/v1/proposals/${id}/send`).set(H(P)).send({ channel: 'email' }).expect(200)).body.link);
    t.app.get(Clock).set(new Date('2026-11-06T10:00:00+05:30'));
    try {
      expect((await t.http().get(`/v1/proposals/public/${tok}`).expect(200)).body.state).toBe('expired');
      expect((await t.http().post(`/v1/proposals/public/${tok}/accept`).send({ name: 'Exp', agree: true }).expect(409)).body.code).toBe('expired');
      expect((await t.http().get(`/v1/proposals/${id}`).set(H(P)).expect(200)).body.status).toBe('expired');
    } finally { t.app.get(Clock).set(NOW); }
    const l2 = await lead(P, { name: 'Dec', email: 'dec@x.example' });
    const id2 = (await t.http().post(`/v1/leads/${l2.id}/proposals`).set(H(P)).send({ title: 'Books', lines: [{ description: 'Bookkeeping', frequency: 'monthly', feePaise: 800_000 }] }).expect(201)).body.id;
    const tok2 = tokenOf((await t.http().post(`/v1/proposals/${id2}/send`).set(H(P)).send({ channel: 'email' }).expect(200)).body.link);
    expect((await t.http().post(`/v1/proposals/public/${tok2}/decline`).send({ reason: 'Too expensive' }).expect(200)).body.status).toBe('declined');
    await t.http().post(`/v1/proposals/${id2}/convert`).set(H(P)).send({}).expect(409);
    await t.http().get('/v1/proposals/public/garbage.token-value-xxxxxxxx').expect(404);
  });

  it('one-click conversion: client, contact, subscriptions, client rates, engagement letter (+ e-sign, portal invite); idempotent', async () => {
    await t.http().post(`/v1/proposals/${pid}/convert`).set(H(Art)).send({}).expect(403);
    const c = (await t.http().post(`/v1/proposals/${pid}/convert`).set(H(P)).send({ sendForEsign: true, inviteToPortal: true }).expect(200)).body;
    expect(c).toMatchObject({ alreadyConverted: false, createdClient: true });
    expect(c.clientServiceIds).toHaveLength(1); // the free one-time line has no service
    const client = (await t.http().get(`/v1/clients/${c.clientId}`).set(H(P)).expect(200)).body;
    expect(client).toMatchObject({ name: 'Navkar Foods LLP', entityType: 'LLP', pan: 'AAFFN1234K' });
    const svc = await t.sql<{ billing_frequency: string; service_type_id: string }>('SELECT billing_frequency, service_type_id FROM client_service WHERE client_id = $1', [c.clientId]);
    expect(svc).toEqual([{ billing_frequency: 'monthly', service_type_id: g3b }]);
    expect(await t.sql('SELECT amount_paise::int AS a, effective_from::text AS f FROM billing_rate WHERE client_id = $1', [c.clientId])).toEqual([{ a: 220_000, f: '2026-10-29' }]);
    const doc = (await t.sql<{ category: string; mime: string; client_visible: boolean; name: string }>('SELECT category, mime, client_visible, name FROM document WHERE id = $1', [c.letterDocumentId]))[0]!;
    expect(doc).toMatchObject({ category: 'Engagement letters', mime: 'application/pdf', client_visible: true });
    expect(c.esignRequestId).toBeTruthy();
    expect(hub.outbox.some((m) => m.to === 'neha@navkar.example' && m.text.includes('/esign/sign/'))).toBe(true);
    expect(c.portal).toMatchObject({ invite: { status: 'sent' } });
    expect((await t.http().get(`/v1/leads/${leadId}`).set(H(P)).expect(200)).body).toMatchObject({ stage: 'won', clientId: c.clientId });
    const again = (await t.http().post(`/v1/proposals/${pid}/convert`).set(H(P)).send({ sendForEsign: true, inviteToPortal: true }).expect(200)).body;
    expect(again).toMatchObject({ alreadyConverted: true, clientId: c.clientId, letterDocumentId: c.letterDocumentId, esignRequestId: c.esignRequestId });
    expect((await t.sql('SELECT 1 FROM client WHERE name = $1', ['Navkar Foods LLP'])).length).toBe(1);
    expect((await t.sql('SELECT 1 FROM esign_request')).length).toBe(1);
  });

  it('conversion refuses a likely duplicate client unless linked or overridden', async () => {
    const l = (await lead(P, { name: 'Old Owner', company: 'Existing Steels', pan: 'AABCE1234F', email: 'owner@steels.example', entityType: 'PRIVATE_COMPANY' })).id;
    const id = (await t.http().post(`/v1/leads/${l}/proposals`).set(H(P)).send({ title: 'ROC', lines: [{ serviceTypeId: g3b, frequency: 'quarterly', feePaise: 600_000 }] }).expect(201)).body.id;
    const tok = tokenOf((await t.http().post(`/v1/proposals/${id}/send`).set(H(P)).send({ channel: 'email' }).expect(200)).body.link);
    await t.http().post(`/v1/proposals/public/${tok}/accept`).send({ name: 'Old Owner', agree: true }).expect(200);
    const dup = (await t.http().post(`/v1/proposals/${id}/convert`).set(H(P)).send({}).expect(409)).body;
    expect(dup).toMatchObject({ code: 'duplicate_client', candidates: [{ id: existing }] });
    const c = (await t.http().post(`/v1/proposals/${id}/convert`).set(H(P)).send({ clientId: existing }).expect(200)).body;
    expect(c).toMatchObject({ clientId: existing, createdClient: false });
    expect((await t.sql<{ billing_frequency: string }>('SELECT billing_frequency FROM client_service WHERE client_id = $1', [existing]))[0]!.billing_frequency).toBe('quarterly');
    expect((await t.sql('SELECT 1 FROM contact WHERE client_id = $1', [existing])).length).toBe(1); // matched the existing contact by email
  });

  it('public page is rate-limited per IP', async () => {
    let limited = false;
    for (let i = 0; i < 25 && !limited; i++) limited = (await t.http().get(`/v1/proposals/public/${link2}`)).status === 429;
    expect(limited).toBe(true);
  });

  it('no contact PII in lead/proposal audit diffs', async () => {
    const all = JSON.stringify(await t.sql(`SELECT diff FROM audit_log WHERE action LIKE 'lead.%' OR action LIKE 'proposal.%' OR (action = 'client.created' AND diff->>'source' = 'proposal')`));
    for (const pii of ['neha@navkar.example', '9822233344', 'AAFFN1234K', 'Neha Shah', 'Too expensive']) expect(all).not.toContain(pii);
  });
});
