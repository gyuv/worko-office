import { describe, expect, it } from 'vitest';
import { normalizePhone, searchClients, toClientItems } from './clients';
import { isTablet } from './layout';
import { telLink, whatsappLink } from './links';
import { buildRegisterPatch, currentFy, searchEntries, todayIST, toEntryItems } from './registers';
import { hasInk, strokeToPath } from './signature';
import { enqueue, MAX_ATTEMPTS, parseQueue, processQueue, removeSig, type PendingSig } from './sigQueue';

const row = (id: string, fields: Record<string, unknown>, deleted = false) => ({ id, deleted, fields });
const clients = [
  row('c1', { name: 'Sharma Traders', pan: 'abcps1234k', phone: '+91 98450 12345', file_no: 'F-101', status: 'active' }),
  row('c2', { name: 'acme LLP', pan: 'AAAFA1111B', phone: '080-2222 3333', status: 'inactive' }),
  row('c3', { name: 'Zed Pvt Ltd', pan: 'AAACZ9999Z', status: 'prospect' }),
  row('c4', { name: 'Gone', pan: 'AAAAA0000A' }, true),
];
const regs = [row('r1', { client_id: 'c3', kind: 'GSTIN', number: '29aaacz9999z1z5' }), row('r2', { client_id: 'c3', kind: 'TAN', number: 'BLRZ12345A' })];

describe('client search', () => {
  const items = toClientItems(clients, regs);
  it('drops deleted rows and sorts case-insensitively by name', () => {
    expect(items.map((c) => c.id)).toEqual(['c2', 'c1', 'c3']);
    expect(items.find((c) => c.id === 'c3')!.gstins).toEqual(['29AAACZ9999Z1Z5']);
  });
  it('matches name, PAN (any case), GSTIN, file no and multiple terms', () => {
    expect(searchClients(items, 'sharma').map((c) => c.id)).toEqual(['c1']);
    expect(searchClients(items, 'ABCPS1234K').map((c) => c.id)).toEqual(['c1']);
    expect(searchClients(items, '29aaacz').map((c) => c.id)).toEqual(['c3']);
    expect(searchClients(items, 'f-101').map((c) => c.id)).toEqual(['c1']);
    expect(searchClients(items, 'sharma acme')).toEqual([]);
    expect(searchClients(items, 'BLRZ12345A')).toEqual([]); // TAN is not a GSTIN
  });
  it('matches phones regardless of +91/spaces/leading zero', () => {
    expect(searchClients(items, '9845012345').map((c) => c.id)).toEqual(['c1']);
    expect(searchClients(items, '+91 98450').map((c) => c.id)).toEqual(['c1']);
    expect(searchClients(items, '08022223333').map((c) => c.id)).toEqual(['c2']);
  });
  it('filters by status; empty query returns all', () => {
    expect(searchClients(items, '', 'inactive').map((c) => c.id)).toEqual(['c2']);
    expect(searchClients(items, '  ')).toHaveLength(3);
  });
  it('normalises Indian phone numbers', () => {
    expect(normalizePhone('+91-98450 12345')).toBe('9845012345');
    expect(normalizePhone('919845012345')).toBe('9845012345');
    expect(normalizePhone('09845012345')).toBe('9845012345');
    expect(normalizePhone('+1 415 555 0100')).toBe('14155550100');
  });
  it('handles thousands of rows quickly', () => {
    const many = Array.from({ length: 5000 }, (_, i) => row(`id${i}`, { name: `Client ${i}`, pan: `AAAPA${String(i).padStart(4, '0')}A` }));
    const it0 = toClientItems(many);
    expect(searchClients(it0, 'AAAPA4999A').map((c) => c.id)).toEqual(['id4999']);
  });
});

describe('contact links', () => {
  it('builds tel: and wa.me links with the India country code', () => {
    expect(telLink('98450 12345')).toBe('tel:+919845012345');
    expect(whatsappLink('+91 98450-12345')).toBe('https://wa.me/919845012345');
    expect(whatsappLink('9845012345', 'Hi there')).toBe('https://wa.me/919845012345?text=Hi%20there');
    expect(whatsappLink('12345')).toBeNull();
    expect(telLink('')).toBeNull();
  });
});

describe('register patches', () => {
  const now = new Date('2026-03-31T20:00:00Z'); // 01:30 IST on 1 Apr 2026
  it('defaults the date to today in IST and never sends number/fy', () => {
    expect(todayIST(now)).toBe('2026-04-01');
    expect(currentFy(now)).toBe('2026-27');
    const r = buildRegisterPatch('inward', { clientId: 'c1', mode: 'courier', description: ' ITR docs ', phone: '98450 12345', items: [{ description: 'PAN copy' }, { description: ' ' }] }, now);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.patch).toMatchObject({ client_id: 'c1', received_on: '2026-04-01', mode: 'courier', description: 'ITR docs', from_phone: '+919845012345', returnable: false, due_back: null });
    expect(r.patch.items).toEqual([{ description: 'PAN copy', qty: 1, original: false }]);
    for (const k of ['number', 'fy', 'received_by', 'sent_by']) expect(r.patch).not.toHaveProperty(k);
  });
  it('builds outward patches with outward columns only', () => {
    const r = buildRegisterPatch('outward', { clientId: 'c1', mode: 'hand', description: 'Returned originals', date: '2026-05-02', returnable: true, original: true }, now);
    expect(r.ok && r.patch).toMatchObject({ sent_on: '2026-05-02', to_be_received_back: true, original: true, to_phone: null });
    expect(r.ok && r.patch).not.toHaveProperty('received_on');
    expect(r.ok && r.patch).not.toHaveProperty('number');
  });
  it('validates required fields and mode per register', () => {
    const r = buildRegisterPatch('outward', { clientId: '', mode: 'portal', description: ' ', date: '01/04/2026', phone: '123' }, now);
    expect(r.ok ? [] : r.errors).toEqual(['client', 'mode', 'description', 'date', 'phone']);
  });
  it('lists entries newest first, unnumbered (unsynced) first on the same day, searchable', () => {
    const items = toEntryItems('inward', [
      row('e1', { number: 'IN/2026-27/0001', received_on: '2026-04-01', client_id: 'c1', description: 'a' }),
      row('e2', { received_on: '2026-04-01', client_id: 'c1', description: 'b', from_name: 'Ravi' }),
      row('e3', { number: 'IN/2025-26/0100', received_on: '2026-03-30', client_id: 'c2', description: 'c', signature_doc_id: 'd' }),
    ], (id) => (id === 'c2' ? 'Acme' : 'Sharma'));
    expect(items.map((e) => e.id)).toEqual(['e2', 'e1', 'e3']);
    expect(items[0]!.number).toBeNull();
    expect(items[2]!.signed).toBe(true);
    expect(searchEntries(items, 'acme').map((e) => e.id)).toEqual(['e3']);
    expect(searchEntries(items, 'ravi').map((e) => e.id)).toEqual(['e2']);
    expect(searchEntries(items, '', 'c1')).toHaveLength(2);
  });
});

describe('signature paths', () => {
  it('builds smoothed SVG path data; a tap is a dot', () => {
    expect(strokeToPath([])).toBe('');
    expect(strokeToPath([{ x: 1, y: 2 }])).toBe('M1,2 L1.1,2.1');
    expect(strokeToPath([{ x: 0, y: 0 }, { x: 10, y: 10 }])).toBe('M0,0 L10,10');
    expect(strokeToPath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }])).toBe('M0,0 Q10,0 10,5 L10,10');
    expect(hasInk([[{ x: 0, y: 0 }]])).toBe(false);
    expect(hasInk([Array.from({ length: 6 }, (_, i) => ({ x: i, y: i }))])).toBe(true);
  });
});

describe('pending signature queue', () => {
  const now = new Date('2026-04-01T00:00:00Z');
  it('parses defensively and de-duplicates per entry', () => {
    expect(parseQueue('garbage')).toEqual([]);
    expect(parseQueue('[{"x":1}]')).toEqual([]);
    let q = enqueue([], { kind: 'inward', entryId: 'e1', uri: 'file:///a.png' }, now);
    q = enqueue(q, { kind: 'inward', entryId: 'e1', uri: 'file:///b.png' }, now);
    q = enqueue(q, { kind: 'outward', entryId: 'e1', uri: 'file:///c.png' }, now);
    expect(q.map((x) => x.uri)).toEqual(['file:///b.png', 'file:///c.png']);
    expect(parseQueue(JSON.stringify(q))).toEqual(q);
    expect(removeSig(q, 'inward', 'e1').map((x) => x.kind)).toEqual(['outward']);
  });
  it('removes uploaded, keeps not-yet-synced/offline, counts failures and gives up', async () => {
    const mk = (entryId: string, attempts = 0): PendingSig => ({ kind: 'inward', entryId, uri: 'u', attempts, addedAt: '' });
    const outcome = { a: 'ok', b: 'not_synced', c: 'offline', d: 'failed', e: 'failed' } as const;
    const { queue, uploaded } = await processQueue([mk('a'), mk('b'), mk('c'), mk('d'), mk('e', MAX_ATTEMPTS - 1), mk('x')],
      async (s) => { if (s.entryId === 'x') throw new Error('boom'); return outcome[s.entryId as keyof typeof outcome]; });
    expect(uploaded.map((x) => x.entryId)).toEqual(['a']);
    expect(queue.map((x) => [x.entryId, x.attempts])).toEqual([['b', 0], ['c', 0], ['d', 1], ['x', 1]]);
  });
});

describe('layout', () => {
  it('switches to two panes at 768dp', () => {
    expect(isTablet(767)).toBe(false);
    expect(isTablet(768)).toBe(true);
  });
});
