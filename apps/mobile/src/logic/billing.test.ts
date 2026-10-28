import type { LocalRow } from '@worko/sync';
import { describe, expect, it } from 'vitest';
import {
  allocationPreview, buildReceipt, clientOutstanding, collectionsToday, daysOverdue, filterInvoices, hasGrant, parsePaise, rupeesInputToPaise, toInvoiceItem,
} from './billing';

const TODAY = '2026-10-28';
const inv = (id: string, f: Record<string, unknown>): LocalRow => ({ table: 'invoice', id, version: 1, deleted: false,
  fields: { client_id: 'c1', kind: 'invoice', status: 'issued', number: id.toUpperCase(), issue_date: '2026-09-01', total_paise: '11800', balance_paise: '11800', ...f } });
const item = (id: string, f: Record<string, unknown> = {}) => toInvoiceItem(inv(id, f));

describe('paise parsing', () => {
  it('parses decimal strings and integers, rejects floats/garbage', () => {
    expect(parsePaise('11800')).toBe(11800);
    expect(parsePaise(' -50 ')).toBe(-50);
    expect(parsePaise(42)).toBe(42);
    expect(parsePaise('118.5')).toBe(0);
    expect(parsePaise(1.5)).toBe(0);
    expect(parsePaise('1e5')).toBe(0);
    expect(parsePaise('99999999999999999999')).toBe(0);
    expect(parsePaise(null)).toBe(0);
  });
  it('converts typed rupees without floats', () => {
    expect(rupeesInputToPaise('1,180.50')).toBe(118050);
    expect(rupeesInputToPaise('₹ 0.1')).toBe(10);
    expect(rupeesInputToPaise('0.29')).toBe(29);
    expect(rupeesInputToPaise('')).toBe(0);
    expect(rupeesInputToPaise('1.234')).toBeNull();
    expect(rupeesInputToPaise('-5')).toBeNull();
  });
});

describe('overdue and outstanding', () => {
  it('counts days overdue from the passed date only', () => {
    expect(daysOverdue({ dueDate: '2026-10-01' }, TODAY)).toBe(27);
    expect(daysOverdue({ dueDate: '2026-11-01' }, TODAY)).toBe(0);
    expect(daysOverdue({ dueDate: null }, TODAY)).toBe(0);
  });
  const items = [
    item('a', { due_date: '2026-09-15', balance_paise: '5000' }),
    item('b', { due_date: '2026-11-15', status: 'partially_paid', balance_paise: '3000' }),
    item('paid', { status: 'paid', balance_paise: '0' }),
    item('cn', { kind: 'credit_note', balance_paise: '1000' }),
    item('draft', { status: 'draft', number: null }),
    item('other', { client_id: 'c2', due_date: '2026-10-01' }),
  ];
  it('sums open balances and overdue for a client, nets advances', () => {
    const rec: LocalRow = { table: 'receipt', id: 'r', version: 1, deleted: false, fields: { client_id: 'c1', unallocated_paise: '700' } };
    const o = clientOutstanding(items, [rec], 'c1', TODAY);
    expect(o.open.map((x) => x.id)).toEqual(['a', 'b']);
    expect(o).toMatchObject({ outstandingPaise: 8000, overduePaise: 5000, overdueCount: 1, maxDaysOverdue: 43, advancePaise: 700, netPaise: 7300 });
  });
  it('filters unpaid/overdue and hides drafts', () => {
    expect(filterInvoices(items, 'all', TODAY).map((x) => x.id)).not.toContain('draft');
    expect(filterInvoices(items, 'unpaid', TODAY).map((x) => x.id).sort()).toEqual(['a', 'b', 'other']);
    expect(filterInvoices(items, 'overdue', TODAY).map((x) => x.id).sort()).toEqual(['a', 'other']);
    expect(filterInvoices(items, 'all', TODAY, 'OTH').map((x) => x.id)).toEqual(['other']);
  });
  it('collections: most overdue first, then amount', () => {
    const list = collectionsToday([...items, item('big', { due_date: '2026-09-15', balance_paise: '90000' })], TODAY);
    expect(list.map((x) => [x.id, x.days])).toEqual([['big', 43], ['a', 43], ['other', 27]]);
  });
});

describe('receipt', () => {
  const open = [item('late', { due_date: '2026-10-20', balance_paise: '10000' }), item('early', { due_date: '2026-09-01', balance_paise: '6000' })];
  it('previews FIFO oldest-due first, TDS before cash, rest advance', () => {
    const p = allocationPreview(open, 12000, 1000);
    expect(p.allocations).toEqual([{ invoiceId: 'early', amountPaise: 5000, tdsPaise: 1000 }, { invoiceId: 'late', amountPaise: 7000, tdsPaise: 0 }]);
    expect(p.advancePaise).toBe(0);
    expect(allocationPreview(open, 20000, 0).advancePaise).toBe(4000);
  });
  it('validates the form; TDS needs a section', () => {
    const f = { amount: '100', tds: '10', tdsSection: '', mode: 'upi', reference: '', receivedOn: TODAY };
    expect(buildReceipt('c1', f)).toEqual({ ok: false, errors: ['tdsSection'] });
    expect(buildReceipt('c1', { ...f, tdsSection: '194J' })).toEqual({ ok: true, body: { clientId: 'c1', receivedOn: TODAY, amountPaise: 10000, tdsPaise: 1000, tdsSection: '194J', mode: 'upi', reference: null } });
    expect(buildReceipt('c1', { ...f, amount: '0', tds: '' })).toMatchObject({ ok: false, errors: ['empty'] });
    expect(buildReceipt('c1', { ...f, amount: 'x', mode: 'barter', tds: '' })).toMatchObject({ ok: false, errors: ['amount', 'mode'] });
  });
  it('gates by grants', () => {
    expect(hasGrant([{ module: 'receipts', action: 'create', scope: 'assigned' }], 'receipts', 'create')).toBe(true);
    expect(hasGrant([{ module: 'billing', action: 'view', scope: 'none' }], 'billing', 'view')).toBe(false);
    expect(hasGrant(undefined, 'billing', 'view')).toBe(false);
  });
});
