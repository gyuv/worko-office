import { proposalTotals } from '@worko/domain';
import { describe, expect, it } from 'vitest';
import { applyMove, defaultRate, diffRows, dropNeighbours, filterBoard, linePayload, emptyLine, moveBlocked, proposalPublicToken, proposalWebHref, totalsRows, type Column, type Lead } from './logic';

const L = (id: string, stage: Lead['stage'], extra: Partial<Lead> = {}): Lead => ({ id, name: id, company: null, email: null, phone: null, pan: null, gstin: null, entityType: null, stateCode: null, source: 'referral',
  ownerId: 'u1', stage, position: 0, lostReason: null, expectedValuePaise: 100, nextFollowupOn: null, notes: null, clientId: null, convertedAt: null, createdAt: '', version: 1, ...extra });

describe('kanban ordering', () => {
  const col = [L('a', 'new'), L('b', 'new'), L('c', 'new')];
  it('neighbours for top, middle, end and same-column moves', () => {
    expect(dropNeighbours(col, 'x', 0)).toEqual({ beforeId: null, afterId: 'a' });
    expect(dropNeighbours(col, 'x', 2)).toEqual({ beforeId: 'b', afterId: 'c' });
    expect(dropNeighbours(col, 'x', 99)).toEqual({ beforeId: 'c', afterId: null });
    expect(dropNeighbours(col, 'a', 1)).toEqual({ beforeId: 'b', afterId: 'c' }); // a moved below b
    expect(dropNeighbours([], 'x', 0)).toEqual({ beforeId: null, afterId: null });
  });
  it('optimistic move updates columns, counts and values', () => {
    const board: Column[] = [{ stage: 'new', count: 3, valuePaise: 300, items: col }, { stage: 'lost', count: 0, valuePaise: 0, items: [] }];
    const b = applyMove(board, 'b', 'lost', 0, 'Price');
    expect(b[0]!.items.map((x) => x.id)).toEqual(['a', 'c']);
    expect(b[0]!.valuePaise).toBe(200);
    expect(b[1]!.items[0]).toMatchObject({ id: 'b', stage: 'lost', lostReason: 'Price' });
    expect(applyMove(board, 'c', 'new', 0)[0]!.items.map((x) => x.id)).toEqual(['c', 'a', 'b']);
  });
  it('filters by owner/source and blocks invalid moves', () => {
    const board: Column[] = [{ stage: 'new', count: 2, valuePaise: 0, items: [L('a', 'new'), L('b', 'new', { ownerId: 'u2', source: 'website' })] }];
    expect(filterBoard(board, { ownerId: 'u2' })[0]!.items.map((x) => x.id)).toEqual(['b']);
    expect(filterBoard(board, { source: 'referral' })[0]!.count).toBe(1);
    expect(moveBlocked('new', 'won', false)).toBe('convert_to_win');
    expect(moveBlocked('won', 'new', true)).toBe('lead_won_final');
    expect(moveBlocked('lost', 'proposal', false)).toBe('invalid_transition');
    expect(moveBlocked('lost', 'new', false)).toBeNull();
  });
});

describe('proposals', () => {
  it('totals rows show cycles with value and first-year value', () => {
    const t = proposalTotals([{ serviceTypeId: null, description: 'GST', frequency: 'monthly', qty: 1, feePaise: 100_000, gstRate: 18 }, { serviceTypeId: null, description: 'ITR', frequency: 'annual', qty: 1, feePaise: 500_000, gstRate: 18 }], 'intra');
    const rows = totalsRows(t);
    expect(rows.map((r) => r.key)).toEqual(['monthly', 'annual', 'firstYear']);
    expect(rows[0]).toMatchObject({ taxablePaise: 100_000, taxPaise: 18_000, totalPaise: 118_000 });
    expect(rows[2]!.totalPaise).toBe(118_000 * 12 + 590_000);
  });
  it('line payload: rate-table lines omit the fee unless overridden', () => {
    expect(linePayload({ ...emptyLine(), serviceTypeId: 's1', feeRupees: '1000' })).not.toHaveProperty('feePaise');
    expect(linePayload({ ...emptyLine(), serviceTypeId: 's1', feeRupees: '1,000.50', override: true })).toMatchObject({ feePaise: 100050 });
    expect(linePayload({ ...emptyLine(), description: 'x' })).toEqual({ error: 'free_line' });
    expect(linePayload({ ...emptyLine(), description: 'x', feeRupees: '1.234' })).toEqual({ error: 'invalid_amount' });
  });
  it('picks the firm-wide default rate on the date', () => {
    const r = (id: string, from: string, extra = {}) => ({ id, serviceTypeId: 's', clientId: null, groupId: null, amountPaise: 1, effectiveFrom: from, effectiveTo: null, ...extra });
    expect(defaultRate([r('old', '2025-04-01'), r('new', '2026-04-01'), r('future', '2027-01-01'), r('client', '2026-05-01', { clientId: 'c' })], 's', '2026-10-29')?.id).toBe('new');
  });
  it('renders version diffs', () => {
    const base = { serviceTypeId: 's', description: 'GST returns', frequency: 'monthly' as const, qty: 1, feePaise: 100_000, gstRate: 18 };
    const rows = diffRows({ added: [{ ...base, serviceTypeId: null, description: 'ROC' }], removed: [], changed: [{ key: 'k', fields: ['feePaise'], from: base, to: { ...base, feePaise: 120_000 } }], terms: true, validUntil: false });
    expect(rows.map((r) => r.kind)).toEqual(['added', 'changed', 'terms']);
    expect(rows[1]!.details[0]).toMatch(/feePaise: ₹1,000\.00 → ₹1,200\.00/);
  });
  it('maps accept links', () => {
    expect(proposalWebHref('http://localhost:3000/v1/proposals/public/tok.x')).toBe('#/proposal/tok.x');
    expect(proposalPublicToken('#/proposal/tok.x')).toBe('tok.x');
    expect(proposalPublicToken('', '/v1/proposals/public/abc')).toBe('abc');
    expect(proposalPublicToken('#/leads')).toBeNull();
  });
});
