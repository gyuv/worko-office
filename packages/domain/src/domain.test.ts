import { describe, expect, it } from 'vitest';
import {
  can, covers, coversRole, formatCompactINR, formatINR, fyLabel, fyStartYear, gstinCheckChar, incomeTaxPeriodLabel,
  isValidGstin, isValidPan, isValidUdin, maskAadhaar, panFromGstin, splitGst, SYSTEM_ROLES, type Actor,
} from './index.js';

describe('identifiers', () => {
  it('validates PAN', () => {
    expect(isValidPan('ABCPE1234F')).toBe(true);
    expect(isValidPan('ABCXE1234F')).toBe(false);
  });
  it('GSTIN checksum round-trips', () => {
    const base = '27ABCPE1234F1Z';
    const g = base + gstinCheckChar(base);
    expect(isValidGstin(g)).toBe(true);
    expect(isValidGstin(base + (g[14] === '0' ? '1' : '0'))).toBe(false);
    expect(panFromGstin(g)).toBe('ABCPE1234F');
  });
  it('UDIN format', () => {
    expect(isValidUdin('26123456ABCDEF1234')).toBe(true);
    expect(isValidUdin('2612345ABCDEF1234')).toBe(false);
  });
  it('masks Aadhaar', () => expect(maskAadhaar('1234 5678 9012')).toBe('XXXX XXXX 9012'));
});

describe('money', () => {
  it('formats Indian grouping', () => {
    expect(formatINR(123456789)).toBe('₹12,34,567.89');
    expect(formatINR(-50)).toBe('-₹0.50');
    expect(formatCompactINR(125_00_000_00)).toBe('₹1.25 Cr');
  });
  it('splits GST by place of supply', () => {
    expect(splitGst(100000, 18, '27', '27')).toEqual({ cgst: 9000, sgst: 9000, igst: 0 });
    expect(splitGst(100000, 18, '27', '29')).toEqual({ cgst: 0, sgst: 0, igst: 18000 });
  });
});

describe('financial year', () => {
  it('derives FY', () => {
    expect(fyStartYear('2026-03-31')).toBe(2025);
    expect(fyStartYear('2026-04-01')).toBe(2026);
    expect(fyLabel(2099)).toBe('2099-00');
  });
  it('labels by regime', () => {
    expect(incomeTaxPeriodLabel(2025)).toEqual({ regime: 'ITA1961', label: 'FY 2025-26 (AY 2026-27)' });
    expect(incomeTaxPeriodLabel(2026)).toEqual({ regime: 'ITA2025', label: 'Tax Year 2026-27' });
  });
});

describe('permissions', () => {
  const role = (k: string) => SYSTEM_ROLES.find((r) => r.key === k)!;
  const actor = (k: string): Actor => ({ userId: 'u1', teamIds: ['t1'], branchId: 'b1', roles: [role(k)] });
  it('partner can do everything', () => expect(can(actor('partner'), 'vault', 'reveal')).toBe(true));
  it('article sees only own tasks', () => {
    expect(can(actor('article'), 'tasks', 'view', { ownerUserIds: ['u1'] })).toBe(true);
    expect(can(actor('article'), 'tasks', 'view', { ownerUserIds: ['u2'] })).toBe(false);
    expect(can(actor('article'), 'billing', 'view')).toBe(false);
  });
  it('manager sees team work', () => {
    expect(can(actor('manager'), 'tasks', 'view', { teamId: 't1' })).toBe(true);
    expect(can(actor('manager'), 'tasks', 'view', { teamId: 't2' })).toBe(false);
    expect(can(actor('manager'), 'settings', 'view', { teamId: 't1' })).toBe(false);
    expect(can(actor('manager'), 'users', 'create', { teamId: 't1' })).toBe(false);
  });
  it('coversRole() checks group subsets and hidden fields', () => {
    const grp = (ids: string[]): Actor => ({ userId: 'u', teamIds: [], branchId: null, roles: [{ key: 'g', name: 'g', system: false, hiddenFields: ['client.fees'], grants: [{ module: 'clients', action: 'view', scope: 'groups', clientGroupIds: ids }] }] });
    const a = grp(['00000000-0000-0000-0000-000000000001']);
    expect(coversRole(a, { grants: [{ module: 'clients', action: 'view', scope: 'groups', clientGroupIds: ['00000000-0000-0000-0000-000000000001'] }], hiddenFields: ['client.fees'] })).toBe(true);
    expect(coversRole(a, { grants: [{ module: 'clients', action: 'view', scope: 'groups', clientGroupIds: ['00000000-0000-0000-0000-000000000002'] }], hiddenFields: ['client.fees'] })).toBe(false);
    expect(coversRole(a, { grants: [], hiddenFields: [] })).toBe(false); // would reveal fees
    expect(coversRole(actor('manager'), role('partner'))).toBe(false);
    expect(coversRole(actor('partner'), role('article'))).toBe(true);
  });
  it('covers() blocks granting wider scope than you hold', () => {
    expect(covers(actor('partner'), { module: 'billing', action: 'edit', scope: 'all' })).toBe(true);
    expect(covers(actor('manager'), { module: 'tasks', action: 'view', scope: 'team' })).toBe(true);
    expect(covers(actor('manager'), { module: 'tasks', action: 'view', scope: 'all' })).toBe(false);
  });
  it('sensitive client restricts even partners', () => {
    expect(can(actor('partner'), 'clients', 'view', { sensitive: true, allowedUserIds: ['u9'] })).toBe(false);
  });
  it('auditor cannot touch vault or edit', () => {
    expect(can(actor('auditor'), 'vault', 'view')).toBe(false);
    expect(can(actor('auditor'), 'billing', 'edit')).toBe(false);
  });
});
