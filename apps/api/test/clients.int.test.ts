import { gstinCheckChar } from '@worko/domain';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, bootApp, PW, type Session } from './helpers.js';

let t: Awaited<ReturnType<typeof bootApp>>;
beforeAll(async () => { t = await bootApp(); }, 60_000);
afterAll(() => t?.close());

let seq = 1000;
/** Valid PAN + GSTIN pair (checksum computed). */
function ids(kind = 'C') {
  const n = String(seq++).padStart(4, '0');
  const pan = `AAB${kind}X${n}Z`;
  const base = `27${pan}1Z`;
  return { pan, gstin: base + gstinCheckChar(base) };
}
const H = (s: Session) => bearer(s.accessToken);
const pull = async (s: Session, since = 0) => (await t.http().get(`/v1/sync/pull?since=${since}&limit=1000`).set(H(s)).expect(200)).body;
const stepUp = (s: Session) => t.http().post('/v1/auth/step-up').set(H(s)).send({ password: PW }).expect(200);
async function client(s: Session, extra: Record<string, unknown> = {}) {
  const { pan, gstin } = ids();
  const r = await t.http().post('/v1/clients').set(H(s)).send({ name: `Client ${pan}`, entityType: 'PRIVATE_COMPANY', registrations: [{ kind: 'GSTIN', number: gstin }], ...extra }).expect(201);
  return { id: r.body.id as string, pan, gstin };
}

describe('clients', () => {
  it('creates with GSTIN (PAN derived), rejects duplicate GSTIN, searches, returns a 360 view', async () => {
    const p = await t.signup('cl1');
    const { gstin, pan } = ids();
    const lookup = await t.http().get(`/v1/lookup/gstin/${gstin}`).set(H(p)).expect(200);
    expect(lookup.body).toMatchObject({ stateCode: '27', state: 'Maharashtra', entityType: 'PRIVATE_COMPANY', source: 'mock' });
    await t.http().get(`/v1/lookup/gstin/27AABCX0000Z1ZZ`).set(H(p)).expect(400);
    const r = await t.http().post('/v1/clients').set(H(p)).send({
      name: 'Shree Ganesh Traders Pvt Ltd', entityType: 'PRIVATE_COMPANY', registrations: [{ kind: 'GSTIN', number: gstin, isPrimary: true }],
      contacts: [{ name: 'Ramesh', phone: '+919811000001', isPrimary: true }], aadhaar: '1234 5678 9012',
    }).expect(201);
    await t.http().post('/v1/clients').set(H(p)).send({ name: 'Dup', entityType: 'PRIVATE_COMPANY', registrations: [{ kind: 'GSTIN', number: gstin }] }).expect(409);
    await t.http().post('/v1/clients').set(H(p)).send({ name: 'Bad', entityType: 'PRIVATE_COMPANY', registrations: [{ kind: 'GSTIN', number: gstin.slice(0, 14) + 'Q' }] }).expect(400);
    const byGst = (await t.http().get(`/v1/clients?q=${gstin}`).set(H(p)).expect(200)).body;
    expect(byGst.items.map((c: { id: string }) => c.id)).toEqual([r.body.id]);
    expect((await t.http().get(`/v1/clients?q=ganesh`).set(H(p))).body.total).toBe(1);
    const c = (await t.http().get(`/v1/clients/${r.body.id}`).set(H(p)).expect(200)).body;
    expect(c).toMatchObject({ pan, aadhaarLast4: '9012', registrations: [{ kind: 'GSTIN', number: gstin, stateCode: '27' }], contacts: [{ name: 'Ramesh' }], can: { edit: true, reveal: true } });
    expect(c.aadhaar_enc).toBeUndefined();
    const raw = await t.sql<{ aadhaar_enc: Buffer }>('SELECT aadhaar_enc FROM client WHERE id = $1', [r.body.id]);
    expect(raw[0]!.aadhaar_enc.toString('latin1')).not.toContain('123456789012');
  });

  it('PII reveal needs step-up and is audited', async () => {
    const p = await t.signup('cl2');
    const { id } = await client(p, { aadhaar: '111122223333', bankAccounts: [{ bank: 'HDFC', accountNo: '50100012345678', ifsc: 'HDFC0001234' }] });
    const denied = await t.http().post(`/v1/clients/${id}/reveal`).set(H(p)).send({ field: 'aadhaar' }).expect(403);
    expect(denied.body.code).toBe('STEP_UP_REQUIRED');
    await t.http().post('/v1/auth/step-up').set(H(p)).send({ password: 'wrong' }).expect(401);
    await stepUp(p);
    expect((await t.http().post(`/v1/clients/${id}/reveal`).set(H(p)).send({ field: 'aadhaar' }).expect(200)).body.value).toBe('111122223333');
    expect((await t.http().post(`/v1/clients/${id}/reveal`).set(H(p)).send({ field: 'bankAccounts' }).expect(200)).body.value[0].accountNo).toBe('50100012345678');
    expect((await t.http().get(`/v1/clients/${id}`).set(H(p))).body.bankAccounts).toEqual([{ bank: 'HDFC', ifsc: 'HDFC0001234', last4: '5678', holder: null }]);
    const audit = (await t.http().get('/v1/audit?entity=client').set(H(p))).body;
    expect(audit.filter((e: { action: string }) => e.action === 'client.pii_revealed')).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toContain('111122223333');
  });

  it('visibility: articles see only their clients; sensitive clients only named users; invisible = 404', async () => {
    const p = await t.signup('cl3');
    const art = await t.addUser(p, 'cl3', 'Arti', 'article');
    const mine = await client(p, { staffIds: [art.userId] });
    const other = await client(p);
    const secret = await client(p, { sensitive: true });
    expect((await t.http().get('/v1/clients').set(H(art))).body.items.map((c: { id: string }) => c.id)).toEqual([mine.id]);
    await t.http().get(`/v1/clients/${other.id}`).set(H(art)).expect(404);
    await t.http().patch(`/v1/clients/${mine.id}`).set(H(art)).send({ notes: 'x' }).expect(403); // article: view only
    // Partner created the sensitive client so is on its allow-list; a second partner is not.
    const p2 = await t.addUser(p, 'cl3', 'Pooja', 'partner');
    await t.http().get(`/v1/clients/${secret.id}`).set(H(p)).expect(200);
    await t.http().get(`/v1/clients/${secret.id}`).set(H(p2)).expect(404);
    const dup = (await t.http().post('/v1/clients/duplicates').set(H(art)).send({ pan: other.pan }).expect(200)).body;
    expect(dup).toEqual({ matches: [], hidden: 1 }); // never names a client the user can't see
  });

  it('narrowing access revokes only on the devices that had it; widening re-ships children', async () => {
    const p = await t.signup('cl4');
    const art = await t.addUser(p, 'cl4', 'Ajit', 'article');
    const bystander = await t.addUser(p, 'cl4', 'Bina', 'article');
    const c = await client(p, { staffIds: [art.userId], contacts: [{ name: 'Kiran' }] });
    const first = await pull(art);
    expect(first.changes.filter((x: { table: string }) => x.table === 'client').map((x: { id: string }) => x.id)).toEqual([c.id]);
    expect(first.changes.some((x: { table: string }) => x.table === 'contact')).toBe(true);
    const bySince = (await pull(bystander)).cursor;
    await t.http().put(`/v1/clients/${c.id}/access`).set(H(p)).send({ staffIds: [] }).expect(204);
    const after = await pull(art, first.cursor);
    const gone = after.changes.filter((x: { deleted: boolean }) => x.deleted).map((x: { table: string }) => x.table).sort();
    expect(gone).toEqual(['client', 'client_registration', 'contact']);
    expect((await pull(bystander, bySince)).changes).toEqual([]); // never learns the client existed
    await t.http().put(`/v1/clients/${c.id}/access`).set(H(p)).send({ staffIds: [art.userId] }).expect(204);
    const back = await pull(art, after.cursor);
    expect(back.changes.filter((x: { deleted: boolean }) => !x.deleted).map((x: { table: string }) => x.table).sort()).toEqual(['client', 'client_registration', 'contact']);
  });

  it('role change changes the scope key (devices re-pull from zero)', async () => {
    const p = await t.signup('cl5');
    const u = await t.addUser(p, 'cl5', 'Sunil', 'article');
    const k1 = (await pull(u)).scopeKey;
    await t.http().patch(`/v1/users/${u.userId}`).set(H(p)).send({ roleKeys: ['senior'] }).expect(204);
    expect((await pull(u)).scopeKey).not.toBe(k1);
  });

  it('device sync: field-validated client edits, child inserts need edit rights, inward numbering', async () => {
    const p = await t.signup('cl6');
    const art = await t.addUser(p, 'cl6', 'Anu', 'article');
    const c = await client(p, { staffIds: [art.userId] });
    const push = (s: Session, mutations: unknown[]) => t.http().post('/v1/sync/push').set(H(s)).send({ mutations }).expect(200).then((r) => r.body.results);
    const v = (await pull(p)).changes.find((x: { id: string }) => x.id === c.id).version;
    const res = await push(p, [
      { key: `k-${randomUUID()}`, table: 'client', id: c.id, baseVersion: v, patch: { pan: 'NOTAPAN' } },
      { key: `k-${randomUUID()}`, table: 'client', id: c.id, baseVersion: v, patch: { sensitive: true } },
      { key: `k-${randomUUID()}`, table: 'client', id: c.id, baseVersion: v, patch: { notes: 'Met MD' } },
    ]);
    expect(res.map((r: { status: string; reason?: string }) => r.reason ?? r.status)).toEqual(['invalid:pan', 'field_not_writable:sensitive', 'applied']);
    const contactRes = await push(art, [{ key: `k-${randomUUID()}`, table: 'contact', id: randomUUID(), baseVersion: 0, patch: { client_id: c.id, name: 'X', is_primary: false } }]);
    expect(contactRes[0].reason).toBe('not_found');
    const today = new Date().toISOString().slice(0, 10);
    const inw = await push(art, [
      { key: `k-${randomUUID()}`, table: 'inward_entry', id: randomUUID(), baseVersion: 0, patch: { client_id: c.id, received_on: today, mode: 'physical', description: 'Bank statements', items: [], returnable: false } },
      { key: `k-${randomUUID()}`, table: 'inward_entry', id: randomUUID(), baseVersion: 0, patch: { client_id: c.id, received_on: today, mode: 'courier', description: 'Form 16', items: [], returnable: true, number: 'HACK/1' } },
    ]);
    expect(inw[0].status).toBe('applied');
    expect(inw[1].reason).toBe('field_not_writable:number');
    const numbers = (await pull(art)).changes.filter((x: { table: string }) => x.table === 'inward_entry').map((x: { fields: { number: string } }) => x.fields.number);
    expect(numbers[0]).toMatch(/^IN\/\d{4}-\d{2}\/0001$/);
  });

  it('field hiding strips columns from REST and sync', async () => {
    const p = await t.signup('cl7');
    await t.sql(`INSERT INTO role (id, tenant_id, key, name, grants, hidden_fields) SELECT gen_random_uuid(), tenant_id, 'junior', 'Junior', grants, '{client.bank_accounts_masked,client.aadhaar}' FROM role WHERE key = 'partner' AND tenant_id = $1`, [p.tenantId]);
    const j = await t.addUser(p, 'cl7', 'Jai', 'junior');
    const { id } = await client(p, { aadhaar: '999988887777', bankAccounts: [{ bank: 'SBI', accountNo: '1234567890', ifsc: 'SBIN0000001' }] });
    const c = (await t.http().get(`/v1/clients/${id}`).set(H(j)).expect(200)).body;
    expect(c.bankAccountsMasked).toBeUndefined(); expect(c.aadhaarLast4).toBeUndefined();
    const row = (await pull(j)).changes.find((x: { id: string }) => x.id === id);
    expect(row.fields.bank_accounts_masked).toBeUndefined();
    expect(row.fields.name).toBeTruthy();
  });

  it('merge moves children and tombstones the source', async () => {
    const p = await t.signup('cl8');
    const a = await client(p, { contacts: [{ name: 'From A' }] });
    const b = await client(p);
    await t.http().post(`/v1/clients/${a.id}/merge`).set(H(p)).send({ intoId: b.id }).expect(204);
    await t.http().get(`/v1/clients/${a.id}`).set(H(p)).expect(404);
    const merged = (await t.http().get(`/v1/clients/${b.id}`).set(H(p))).body;
    expect(merged.contacts.map((c: { name: string }) => c.name)).toEqual(['From A']);
    expect(merged.registrations.map((r: { number: string }) => r.number).sort()).toEqual([a.gstin, b.gstin].sort());
  });
});

describe('vault & extension', () => {
  it('stores encrypted, lists hints, reveals with step-up only, autofills only on the official host', async () => {
    const p = await t.signup('vt1');
    const mgr = await t.addUser(p, 'vt1', 'Mohan', 'manager');
    const c = await client(p);
    const { body: { id } } = await t.http().post(`/v1/clients/${c.id}/secrets`).set(H(p))
      .send({ portal: 'GST', label: 'GST login', username: 'shreeganesh27', password: 'S3cret!pass' }).expect(201);
    const list = (await t.http().get(`/v1/vault/secrets?clientId=${c.id}`).set(H(p)).expect(200)).body;
    expect(list[0]).toMatchObject({ portal: 'GST', usernameHint: 'sh••••••27' });
    expect(JSON.stringify(list)).not.toContain('S3cret');
    const raw = await t.sql<{ secret_enc: Buffer }>('SELECT secret_enc FROM vault_secret WHERE id = $1', [id]);
    expect(raw[0]!.secret_enc.toString('latin1')).not.toContain('S3cret');
    await t.http().get('/v1/vault/secrets').set(H(mgr)).expect(403); // managers have no vault grant
    expect((await t.http().post(`/v1/vault/secrets/${id}/reveal`).set(H(p)).send({ purpose: 'view' }).expect(403)).body.code).toBe('STEP_UP_REQUIRED');
    await stepUp(p);
    expect((await t.http().post(`/v1/vault/secrets/${id}/reveal`).set(H(p)).send({ purpose: 'view' }).expect(200)).body).toMatchObject({ username: 'shreeganesh27', password: 'S3cret!pass' });
    await t.http().post(`/v1/vault/secrets/${id}/reveal`).set(H(p)).send({ purpose: 'autofill', pageUrl: 'https://services.gst.gov.in.evil.example/login' }).expect(400);
    await t.http().post(`/v1/vault/secrets/${id}/reveal`).set(H(p)).send({ purpose: 'autofill', pageUrl: 'https://services.gst.gov.in/services/login' }).expect(200);
    const audit = (await t.http().get('/v1/audit?entity=vault_secret').set(H(p))).body;
    expect(audit.filter((e: { action: string }) => e.action === 'vault.revealed')).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toContain('S3cret');
  });

  it('extension pairs with a one-time code and can only do vault autofill', async () => {
    const p = await t.signup('vt2');
    const c = await client(p);
    const { body: { id } } = await t.http().post(`/v1/clients/${c.id}/secrets`).set(H(p)).send({ portal: 'INCOME_TAX', label: 'IT', username: c.pan, password: 'itpass' }).expect(201);
    const { body: { code } } = await t.http().post('/v1/vault/extension/pair-code').set(H(p)).expect(201);
    await t.http().post('/v1/auth/extension/pair').send({ firm: 'vt2', code: '0000-0000' }).expect(401);
    const ext = (await t.http().post('/v1/auth/extension/pair').send({ firm: 'vt2', code }).expect(200)).body;
    await t.http().post('/v1/auth/extension/pair').send({ firm: 'vt2', code }).expect(401); // single use
    await t.http().get('/v1/clients').set(H(ext)).expect(403);
    await t.http().get('/v1/audit').set(H(ext)).expect(403);
    expect((await t.http().get('/v1/vault/secrets?portal=INCOME_TAX').set(H(ext)).expect(200)).body).toHaveLength(1);
    await t.http().post('/v1/auth/step-up').set(H(ext)).send({ password: PW }).expect(200);
    await t.http().post(`/v1/vault/secrets/${id}/reveal`).set(H(ext)).send({ purpose: 'view' }).expect(400);
    expect((await t.http().post(`/v1/vault/secrets/${id}/reveal`).set(H(ext)).send({ purpose: 'autofill', pageUrl: 'https://eportal.incometax.gov.in/iec/foservices/#/login' }).expect(200)).body.password).toBe('itpass');
    expect((await t.http().get('/v1/auth/sessions').set(H(p))).body.some((s: { platform: string }) => s.platform === 'extension')).toBe(true);
  });
});

describe('documents', () => {
  const pdf = Buffer.from('%PDF-1.4\n% Worko test file\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
  const upload = (s: Session, clientId: string, body = pdf, name = 'itr-v.pdf', mime = 'application/pdf', extra: Record<string, string> = {}) => {
    const r = t.http().post('/v1/documents').set(H(s)).field('clientId', clientId).field('category', 'ITR').field('fy', '2025-26');
    for (const [k, v] of Object.entries(extra)) r.field(k, v);
    return r.attach('file', body, { filename: name, contentType: mime });
  };
  it('uploads, versions, downloads through signed URLs with safe headers, blocks malware and HTML', async () => {
    const p = await t.signup('dc1');
    const c = await client(p);
    const { body: up } = await upload(p, c.id).expect(201);
    await upload(p, c.id, Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'), 'eicar.pdf').expect(422);
    await upload(p, c.id, Buffer.from('<script>alert(1)</script>'), 'x.html', 'text/html').expect(400);
    await upload(p, c.id, Buffer.from('%PDF-1.4 v2'), 'itr-v.pdf', 'application/pdf', { documentId: up.id }).expect(201);
    expect((await t.http().get(`/v1/documents/${up.id}/versions`).set(H(p))).body.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    const { body: { url } } = await t.http().post(`/v1/documents/${up.id}/download-url`).set(H(p)).send({ version: 1 }).expect(200);
    const dl = await t.http().get(url).buffer(true).parse((res, cb) => { const b: Buffer[] = []; res.on('data', (d: Buffer) => b.push(d)); res.on('end', () => cb(null, Buffer.concat(b))); }).expect(200);
    expect(Buffer.compare(dl.body, pdf)).toBe(0);
    expect(dl.headers['content-disposition']).toMatch(/^attachment/);
    expect(dl.headers['content-security-policy']).toContain('sandbox');
    await t.http().get(url.replace(/.$/, (ch: string) => (ch === 'A' ? 'B' : 'A'))).expect(404); // tampered signature
    const tree = (await t.http().get(`/v1/clients/${c.id}/document-tree`).set(H(p))).body;
    expect(tree).toEqual([{ fy: '2025-26', category: 'ITR', count: 1 }]);
    expect((await t.http().get('/v1/documents?q=itr').set(H(p))).body.total).toBe(1);
  });

  it('legal hold, trash/restore, share links with password and download limit, access log', async () => {
    const p = await t.signup('dc2');
    const c = await client(p);
    const { body: { id } } = await upload(p, c.id).expect(201);
    await t.http().patch(`/v1/documents/${id}`).set(H(p)).send({ legalHold: true }).expect(204);
    await t.http().delete(`/v1/documents/${id}`).set(H(p)).expect(403);
    await t.http().patch(`/v1/documents/${id}`).set(H(p)).send({ legalHold: false }).expect(204);
    await t.http().delete(`/v1/documents/${id}`).set(H(p)).expect(204);
    expect((await t.http().get('/v1/documents?trashed=true').set(H(p))).body.total).toBe(1);
    await t.http().post(`/v1/documents/${id}/restore`).set(H(p)).expect(204);
    const share = (await t.http().post(`/v1/documents/${id}/shares`).set(H(p)).send({ expiresInHours: 24, password: 'client123', maxDownloads: 1 }).expect(201)).body;
    expect((await t.http().get(share.url).expect(404)).body.code).toBe('PASSWORD_REQUIRED');
    await t.http().post(share.url).send({ password: 'nope' }).expect(404);
    await t.http().post(share.url).send({ password: 'client123' }).expect(200);
    await t.http().post(share.url).send({ password: 'client123' }).expect(404); // limit reached
    const log = (await t.http().get(`/v1/documents/${id}/access-log`).set(H(p))).body.map((l: { action: string }) => l.action);
    expect(log).toEqual(expect.arrayContaining(['upload', 'delete', 'restore', 'share', 'share_download']));
  });

  it('articles reach documents of their own clients only', async () => {
    const p = await t.signup('dc3');
    const art = await t.addUser(p, 'dc3', 'Amar', 'article');
    const mine = await client(p, { staffIds: [art.userId] });
    const other = await client(p);
    await upload(art, mine.id).expect(201);
    await upload(art, other.id).expect(404);
    const { body: { id } } = await upload(p, other.id).expect(201);
    await t.http().post(`/v1/documents/${id}/download-url`).set(H(art)).send({}).expect(404);
    expect((await t.http().get('/v1/documents').set(H(art))).body.total).toBe(1);
  });
});

describe('registers', () => {
  it('numbers entries per FY, searches, prints receipts, links signatures', async () => {
    const p = await t.signup('rg1');
    const c = await client(p);
    const mk = (body: Record<string, unknown>) => t.http().post('/v1/registers/inward').set(H(p)).send({ client_id: c.id, received_on: '2026-10-27', mode: 'physical', description: 'Docs', ...body });
    const a = (await mk({ from_name: 'Suresh', from_phone: '+919822000111', items: [{ description: 'Original sale deed', qty: 1, original: true }], returnable: true, due_back: '2026-11-15' }).expect(201)).body;
    const b = (await mk({}).expect(201)).body;
    expect([a.number, b.number]).toEqual(['IN/2026-27/0001', 'IN/2026-27/0002']);
    await mk({ number: 'X' }).expect(400);
    const out = (await t.http().post('/v1/registers/outward').set(H(p)).send({ client_id: c.id, sent_on: '2027-04-02', mode: 'courier', courier_name: 'DTDC', tracking_no: 'D123', description: 'Returned deed', original: true }).expect(201)).body;
    expect(out.number).toBe('OUT/2027-28/0001');
    expect((await t.http().get('/v1/registers/inward?q=9822000111').set(H(p))).body.items.map((x: { number: string }) => x.number)).toEqual(['IN/2026-27/0001']);
    expect((await t.http().get('/v1/registers/inward?pending=true').set(H(p))).body.total).toBe(1);
    await t.http().patch(`/v1/registers/inward/${a.id}`).set(H(p)).send({ returned_on: '2026-11-10' }).expect(204);
    expect((await t.http().get('/v1/registers/inward?pending=true').set(H(p))).body.total).toBe(0);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    await t.http().post(`/v1/registers/inward/${a.id}/signature`).set(H(p)).attach('file', png, { filename: 'sig.png', contentType: 'image/png' }).expect(201);
    const pdfRes = await t.http().get(`/v1/registers/inward/${a.id}/receipt.pdf`).set(H(p)).buffer(true).parse((res, cb) => { const x: Buffer[] = []; res.on('data', (d: Buffer) => x.push(d)); res.on('end', () => cb(null, Buffer.concat(x))); }).expect(200);
    expect(pdfRes.body.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('import / export', () => {
  it('previews a CSV with per-row errors and duplicates, commits the valid rows, exports safely', async () => {
    const p = await t.signup('im1');
    const existing = await client(p);
    const g1 = ids(); const g2 = ids('F');
    const csv = [
      'Party Name,GST No,Constitution,Mobile,City,Remarks',
      `Alpha Traders,${g1.gstin},Pvt Ltd,9876500001,Pune,Good client`,
      `Beta & Sons,${g2.gstin},,98765 00002,Pune,`,
      `Gamma,${existing.gstin},LLP,,,`,
      'Delta,27AAAAA0000A1Z0,Proprietor,,,',
      `"=HYPERLINK(""http://x"")",,Individual,,,`,
    ].join('\n');
    const prev = (await t.http().post('/v1/clients/import/preview').set(H(p)).attach('file', Buffer.from(csv), 'clients.csv').expect(200)).body;
    expect(prev.mapping).toMatchObject({ 'Party Name': 'name', 'GST No': 'gstin', Constitution: 'entityType', Mobile: 'phone', Remarks: 'notes' });
    expect(prev.rows.map((r: { data: unknown }) => !!r.data)).toEqual([true, true, false, false, true]);
    expect(prev.rows[1].data.entityType).toBe('PARTNERSHIP'); // inferred from the PAN in the GSTIN
    expect(prev.rows[2].errors.join()).toContain('already belongs');
    expect(prev.rows[3].errors.join()).toContain('Invalid GSTIN');
    const done = (await t.http().post('/v1/clients/import/commit').set(H(p)).send({ rows: prev.rows.filter((r: { data: unknown }) => r.data).map((r: { data: unknown }) => r.data) }).expect(200)).body;
    expect(done).toMatchObject({ created: 3, failed: [] });
    const exp = await t.http().get('/v1/clients/export?format=csv').set(H(p)).expect(200);
    expect(exp.text).toContain('Alpha Traders');
    expect(exp.text).toContain(`"'=HYPERLINK(""http://x"")"`); // formula neutralised
    const x = await t.http().get('/v1/clients/export?format=xlsx').set(H(p)).buffer(true).parse((res, cb) => { const b: Buffer[] = []; res.on('data', (d: Buffer) => b.push(d)); res.on('end', () => cb(null, Buffer.concat(b))); }).expect(200);
    expect(x.body.subarray(0, 2).toString()).toBe('PK');
  });
});

describe('users', () => {
  it('deactivation ends sessions and blocks login; nobody deactivates themselves', async () => {
    const p = await t.signup('us1');
    const u = await t.addUser(p, 'us1', 'Vinod', 'senior');
    await t.http().patch(`/v1/users/${p.userId}`).set(H(p)).send({ status: 'disabled' }).expect(400);
    await t.http().patch(`/v1/users/${u.userId}`).set(H(p)).send({ status: 'disabled' }).expect(204);
    await t.http().get('/v1/me').set(H(u)).expect(401);
    await t.http().post('/v1/auth/login').send({ firm: 'us1', email: 'vinod@us1.in', password: PW, device: { platform: 'web' } }).expect(401);
    await t.http().patch(`/v1/users/${u.userId}`).set(H(u)).send({ status: 'active' }).expect(401);
  });
});

describe('phase 3 review regressions', () => {
  const inward = (s: Session, clientId: string, on = '2026-05-10') =>
    t.http().post('/v1/registers/inward').set(H(s)).send({ client_id: clientId, received_on: on, mode: 'physical', description: 'Bank statements' });

  it('children sync only with clients:view too, and stop syncing when the client is deleted', async () => {
    const p = await t.signup('rv1');
    const desk = await t.addUser(p, 'rv1', 'Desk', 'article');
    // "Front desk": every register entry, but only own clients.
    await t.sql(`UPDATE role SET grants = grants || '[{"module":"registers","action":"view","scope":"all"},{"module":"documents","action":"view","scope":"all"}]'::jsonb
      WHERE key = 'article' AND tenant_id = $1`, [p.tenantId]);
    const other = await client(p);
    await inward(p, other.id).expect(201);
    const seen = (await pull(desk)).changes.map((x: { table: string }) => x.table);
    expect(seen).not.toContain('inward_entry');
    const before = await pull(p);
    expect(before.changes.some((x: { table: string }) => x.table === 'inward_entry')).toBe(true);
    await t.http().delete(`/v1/clients/${other.id}`).set(H(p)).expect(204);
    const after = await pull(p, before.cursor);
    expect(after.changes.filter((x: { deleted: boolean }) => x.deleted).map((x: { table: string }) => x.table)).toContain('inward_entry');
    expect((await t.http().get('/v1/registers/inward').set(H(p))).body.total).toBe(0);
  });

  it('only approvers change partner/manager/restricted access; sensitive keeps the previous partner', async () => {
    const p = await t.signup('rv2');
    const sen = await t.addUser(p, 'rv2', 'Sen', 'senior');
    const c = await client(p, { partnerId: p.userId, staffIds: [sen.userId] });
    await t.http().put(`/v1/clients/${c.id}/access`).set(H(sen)).send({ partnerId: sen.userId, managerId: null, sensitive: true }).expect(403);
    await t.http().put(`/v1/clients/${c.id}/access`).set(H(sen)).send({ groupIds: [] }).expect(204); // plain edit still fine
    const p2 = await t.addUser(p, 'rv2', 'Pia', 'partner');
    await t.http().put(`/v1/clients/${c.id}/access`).set(H(p2)).send({ partnerId: p2.userId, sensitive: true, allowedUserIds: [] }).expect(204);
    await t.http().get(`/v1/clients/${c.id}`).set(H(p)).expect(200); // previous partner kept
  });

  it('360 counts only for granted modules; export uses the export scope and is audited', async () => {
    const p = await t.signup('rv3');
    const art = await t.addUser(p, 'rv3', 'Art', 'article');
    const c = await client(p, { staffIds: [art.userId] });
    const v = (await t.http().get(`/v1/clients/${c.id}`).set(H(art)).expect(200)).body;
    expect(v.counts.secrets).toBeNull();
    expect(typeof v.counts.documents).toBe('number');
    await t.http().get('/v1/clients/export?format=csv').set(H(p)).expect(200);
    const audit = (await t.http().get('/v1/audit?entity=client').set(H(p))).body;
    expect(JSON.stringify(audit)).toContain('client.exported');
  });

  it('register date is immutable after insert (number and FY follow it)', async () => {
    const p = await t.signup('rv4');
    const c = await client(p);
    const { body: { id } } = await inward(p, c.id, '2026-03-31').expect(201);
    await t.http().patch(`/v1/registers/inward/${id}`).set(H(p)).send({ received_on: '2026-04-02' }).expect(400);
  });

  it('signed download URLs die with the session', async () => {
    const p = await t.signup('rv5');
    const c = await client(p);
    const { body: { id } } = await t.http().post('/v1/documents').set(H(p)).field('clientId', c.id).field('category', 'ITR').attach('file', Buffer.from('%PDF-1.4\n%%EOF\n'), { filename: 'a.pdf', contentType: 'application/pdf' }).expect(201);
    const { body: { url } } = await t.http().post(`/v1/documents/${id}/download-url`).set(H(p)).send({}).expect(200);
    await t.http().post('/v1/auth/logout').set(H(p)).expect(204);
    await t.http().get(url).expect(404);
  });

  it('share link locks after too many wrong passwords', async () => {
    const p = await t.signup('rv6');
    const c = await client(p);
    const { body: { id } } = await t.http().post('/v1/documents').set(H(p)).field('clientId', c.id).field('category', 'ITR').attach('file', Buffer.from('%PDF-1.4\n%%EOF\n'), { filename: 'a.pdf', contentType: 'application/pdf' }).expect(201);
    const share = (await t.http().post(`/v1/documents/${id}/shares`).set(H(p)).send({ expiresInHours: 24, password: 'client123' }).expect(201)).body;
    await t.sql('UPDATE share_link SET failed_attempts = 9');
    await t.http().post(share.url).send({ password: 'nope' }).expect(404);
    await t.http().post(share.url).send({ password: 'client123' }).expect(404);
  });
});
