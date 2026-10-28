import { describe, expect, it } from 'vitest';
import { ageingCheck, allowedActions, paiseToInput, parseRupees, planAllocation, taxRows, type InvoiceLike } from './logic';

const all = () => true;
const inv = (o: Partial<InvoiceLike>): InvoiceLike => ({ kind: 'invoice', status: 'issued', balancePaise: 1000, allocatedPaise: 0, tdsPaise: 0, creditedPaise: 0, ...o });

describe('rupee parsing (no floats)', () => {
  it('parses to integer paise', () => {
    expect(parseRupees('1,23,456.5')).toBe(12345650);
    expect(parseRupees('0.07')).toBe(7);
    expect(parseRupees('₹ 10')).toBe(1000);
    expect(parseRupees('1.234')).toBeNull();
    expect(parseRupees('abc')).toBeNull();
    expect(paiseToInput(12345650)).toBe('123456.50');
  });
});

describe('invoice state → allowed actions', () => {
  it('drafts are edited/issued/deleted, never sent', () => {
    expect(allowedActions(inv({ status: 'draft' }), all)).toEqual(['edit', 'delete', 'issue']);
  });
  it('issued, unsettled: everything incl. cancel for approvers', () => {
    expect(allowedActions(inv({}), all)).toEqual(['pdf', 'send', 'paymentLink', 'followUp', 'note', 'cancel']);
  });
  it('part paid cannot be cancelled; paid gets no payment link', () => {
    expect(allowedActions(inv({ status: 'partially_paid', allocatedPaise: 10 }), all)).not.toContain('cancel');
    expect(allowedActions(inv({ status: 'paid', balancePaise: 0 }), all)).toEqual(['pdf', 'send', 'note']);
  });
  it('cancelled and credit notes are read-only', () => {
    expect(allowedActions(inv({ status: 'cancelled' }), all)).toEqual(['pdf']);
    expect(allowedActions(inv({ kind: 'credit_note' }), all)).toEqual(['pdf']);
  });
  it('respects permissions (maker-checker)', () => {
    const accountant = (_m: string, a: string) => a !== 'approve';
    expect(allowedActions(inv({}), accountant)).toEqual(['pdf', 'send', 'paymentLink', 'followUp']);
    expect(allowedActions(inv({ status: 'draft' }), () => false)).toEqual([]);
  });
});

describe('tax preview display', () => {
  const base = { taxablePaise: 1000000, cgstPaise: 90000, sgstPaise: 90000, igstPaise: 180000, reimbursementPaise: 0, roundOffPaise: 0, totalPaise: 1180000 };
  it('intra → CGST + SGST', () => expect(taxRows({ ...base, supplyType: 'intra' }).map((r) => r.key)).toEqual(['taxable', 'cgst', 'sgst', 'total']));
  it('inter → IGST', () => expect(taxRows({ ...base, supplyType: 'inter' }).map((r) => r.key)).toEqual(['taxable', 'igst', 'total']));
  it('unregistered → no tax; shows reimbursement and round-off', () =>
    expect(taxRows({ ...base, supplyType: 'unregistered', reimbursementPaise: 5000, roundOffPaise: -40 })).toEqual([
      { key: 'taxable', paise: 1000000 }, { key: 'reimbursement', paise: 5000 }, { key: 'roundOff', paise: -40 }, { key: 'total', paise: 1180000 }]));
});

describe('receipt allocation preview', () => {
  const items = [{ id: 'a', number: 'A/1', dueDate: '2026-04-01', balancePaise: 10000 }, { id: 'b', number: 'A/2', dueDate: '2026-05-01', balancePaise: 20000 }];
  it('FIFO with TDS first, remainder to advance', () => {
    const p = planAllocation(25000, 1000, items);
    expect(p.allocations).toEqual([{ invoiceId: 'a', amountPaise: 9000, tdsPaise: 1000 }, { invoiceId: 'b', amountPaise: 16000, tdsPaise: 0 }]);
    expect(p.advancePaise).toBe(0);
    expect(planAllocation(40000, 0, items).advancePaise).toBe(10000);
  });
  it('manual override: unallocated cash becomes advance; over-allocation flagged', () => {
    const p = planAllocation(15000, 0, items, { b: 5000 });
    expect(p.allocations).toEqual([{ invoiceId: 'b', amountPaise: 5000, tdsPaise: 0 }]);
    expect(p.advancePaise).toBe(10000);
    expect(planAllocation(1000, 0, items, { a: 2000 }).errors).toContain('overAllocated');
    expect(planAllocation(50000, 0, items, { a: 12000 }).errors).toContain('overBalance');
    expect(planAllocation(20000, 500, items, { a: 10000, b: 20000 }).errors).toContain('tdsMismatch');
  });
});

describe('ageing totals', () => {
  const rows = [
    { clientId: 'x', buckets: { notDue: 100, d0_30: 200, d31_60: 0, d61_90: 0, d90plus: 50 }, totalPaise: 350 },
    { clientId: 'y', buckets: { notDue: 0, d0_30: 0, d31_60: 300, d61_90: 0, d90plus: 0 }, totalPaise: 300 },
  ];
  it('reconciles Σ balances with Σ buckets', () => {
    const c = ageingCheck(rows, { notDue: 100, d0_30: 200, d31_60: 300, d61_90: 0, d90plus: 50, totalPaise: 650 });
    expect(c).toMatchObject({ ok: true, sumOfBalances: 650, sumOfBuckets: 650 });
  });
  it('flags a mismatch', () => expect(ageingCheck(rows, { notDue: 100, d0_30: 200, d31_60: 300, d61_90: 0, d90plus: 50, totalPaise: 600 }).ok).toBe(false));
});
