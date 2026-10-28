import { describe, expect, it } from 'vitest';
import {
  accrualFor, addDaysIso, consumeCredits, allocateByWeight, attendanceDecision, availableBalance, canApprovePerson, canPerson, canSeeCost, carryForwardLapse, compOffDays,
  costPaise, defaultHrSettings, hrSettingsSchema, haversineMeters, ipAllowed, ipInCidr, isValidCidr, leaveDays, mondayOf, nearestFence, pnlOf, roundCoord, SYSTEM_ROLES,
  timerMinutes, utilisationPct, weekCapacity, type Actor,
} from './index.js';

const cal = (holidays: string[] = []) => ({ weekendDays: [0], holidays: new Set(holidays) });

describe('geofence', () => {
  it('haversine distance and fence membership', () => {
    const office = { lat: 18.5204, lng: 73.8567 };
    expect(haversineMeters(office, office)).toBe(0);
    // ~0.001° latitude ≈ 111 m
    expect(Math.round(haversineMeters(office, { lat: 18.5214, lng: 73.8567 }))).toBeGreaterThan(105);
    expect(Math.round(haversineMeters(office, { lat: 18.5214, lng: 73.8567 }))).toBeLessThan(118);
    // Pune → Mumbai ≈ 120 km
    expect(haversineMeters(office, { lat: 19.076, lng: 72.8777 }) / 1000).toBeGreaterThan(115);
    const f = [{ id: 'pune', ...office, radiusM: 150 }, { id: 'far', lat: 19.076, lng: 72.8777, radiusM: 150 }];
    expect(nearestFence({ lat: 18.5214, lng: 73.8567 }, f)).toMatchObject({ id: 'pune', inside: true });
    expect(nearestFence({ lat: 18.5304, lng: 73.8567 }, f)).toMatchObject({ id: 'pune', inside: false });
    expect(nearestFence(office, [])).toBeNull();
    expect(roundCoord(18.520434567)).toBe(18.5204);
  });
  it('CIDR matching (IPv4, mapped IPv6, IPv6) and policy decisions', () => {
    expect(ipInCidr('192.168.1.77', '192.168.1.0/24')).toBe(true);
    expect(ipInCidr('192.168.2.1', '192.168.1.0/24')).toBe(false);
    expect(ipInCidr('::ffff:10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(ipInCidr('203.0.113.9', '203.0.113.9')).toBe(true);
    expect(ipInCidr('2001:db8::1', '2001:db8::/32')).toBe(true);
    expect(ipInCidr('2001:db9::1', '2001:db8::/32')).toBe(false);
    expect(ipInCidr('10.0.0.1', '2001:db8::/32')).toBe(false);
    expect(ipInCidr('999.1.1.1', '0.0.0.0/0')).toBe(false);
    expect(isValidCidr('10.0.0.0/8')).toBe(true);
    expect(isValidCidr('10.0.0.0/33')).toBe(false);
    expect(ipAllowed(null, ['0.0.0.0/0'])).toBe(false);
    const p = defaultHrSettings().attendance;
    expect(attendanceDecision(p, { inFence: true, ipOk: null })).toEqual({ ok: true, status: 'ok', flags: [] });
    expect(attendanceDecision(p, { inFence: false, ipOk: null })).toEqual({ ok: false, status: 'flagged', flags: ['out_of_fence'] });
    expect(attendanceDecision({ ...p, mode: 'either', outside: 'approval' }, { inFence: false, ipOk: true }).ok).toBe(true);
    expect(attendanceDecision({ ...p, mode: 'both', outside: 'approval' }, { inFence: true, ipOk: false })).toEqual({ ok: false, status: 'needs_approval', flags: ['ip_not_allowed'] });
  });
});

describe('leave days', () => {
  it('skips weekends and holidays, counts half days', () => {
    // 2026-10-05 is a Monday
    expect(mondayOf('2026-10-08')).toBe('2026-10-05');
    expect(leaveDays({ from: '2026-10-05', to: '2026-10-11' }, cal())).toBe(6); // Sunday excluded
    expect(leaveDays({ from: '2026-10-05', to: '2026-10-11' }, cal(['2026-10-07']))).toBe(5);
    expect(leaveDays({ from: '2026-10-05', to: '2026-10-07', startHalf: true, endHalf: true }, cal())).toBe(2);
    expect(leaveDays({ from: '2026-10-05', to: '2026-10-05', startHalf: true }, cal())).toBe(0.5);
    expect(leaveDays({ from: '2026-10-05', to: '2026-10-11' }, { ...cal(['2026-10-07']), excludeWeekends: false, excludeHolidays: false })).toBe(7);
    expect(() => leaveDays({ from: '2026-10-05', to: '2026-10-05', startHalf: true, endHalf: true }, cal())).toThrow();
  });
  it('accrual, carry-forward lapse, comp-off and FIFO expiry', () => {
    expect(accrualFor({ kind: 'monthly', days: 1.5 }, '2026-07')).toBe(1.5);
    expect(accrualFor({ kind: 'annual', days: 12 }, '2026-04')).toBe(12);
    expect(accrualFor({ kind: 'annual', days: 12 }, '2026-05')).toBe(0);
    expect(carryForwardLapse(20, 15)).toBe(5);
    expect(carryForwardLapse(10, 15)).toBe(0);
    expect(carryForwardLapse(10, null)).toBe(0);
    const cfg = defaultHrSettings().compOff;
    expect([compOffDays(100, cfg), compOffDays(240, cfg), compOffDays(500, cfg)]).toEqual([0, 0.5, 1]);
    const e = [{ delta: 1, expiresOn: '2026-10-10', on: '2026-07-12' }, { delta: 1, expiresOn: '2026-12-31', on: '2026-10-01' }, { delta: -0.5, on: '2026-10-02' }];
    expect(availableBalance(e, '2026-10-05')).toBe(1.5);
    expect(availableBalance(e, '2026-10-20')).toBe(1); // first credit lapsed after half of it was used
    expect(availableBalance([{ delta: 5, on: '2026-04-01' }, { delta: -2, on: '2026-05-01' }], '2030-01-01')).toBe(3);
    // Debits record the credits they consume (so a cancel restores their expiry).
    expect(consumeCredits(e, 1, '2026-10-05')).toEqual([{ days: 0.5, expiresOn: '2026-10-10' }, { days: 0.5, expiresOn: '2026-12-31' }]);
    expect(consumeCredits(e, 1, '2026-10-20')).toEqual([{ days: 1, expiresOn: '2026-12-31' }]);
    expect(consumeCredits([{ delta: 1, on: '2026-01-01' }], 2, '2026-02-01')).toEqual([{ days: 1, expiresOn: null }, { days: 1, expiresOn: null }]);
  });
});

describe('time, cost and P&L maths', () => {
  it('timer minutes from server timestamps with a cap', () => {
    const s = new Date('2026-10-05T09:00:00Z');
    expect(timerMinutes(s, new Date('2026-10-05T10:30:29Z'), 720)).toEqual({ minutes: 90, capped: false });
    expect(timerMinutes(s, new Date('2026-10-05T09:00:10Z'), 720)).toEqual({ minutes: 1, capped: false });
    expect(timerMinutes(s, new Date('2026-10-06T09:00:00Z'), 720)).toEqual({ minutes: 720, capped: true });
    expect(() => hrSettingsSchema.parse({ timer: { capMinutes: 2000 } })).toThrow(); // cap ≤ 24 h
  });
  it('cost per entry and exact allocation', () => {
    expect(costPaise(90, 100_000)).toBe(150_000);
    expect(costPaise(-90, 100_000)).toBe(-150_000);
    expect(costPaise(7, 33_333)).toBe(3_889);
    expect(allocateByWeight(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateByWeight(-100, [1, 1, 1])).toEqual([-34, -33, -33]);
    expect(allocateByWeight(1000, [300, 700])).toEqual([300, 700]);
    expect(allocateByWeight(10, [0, 0])).toEqual([5, 5]);
    expect(allocateByWeight(99_999, [3, 7, 11]).reduce((s, x) => s + x, 0)).toBe(99_999);
    expect(pnlOf({ revenuePaise: 100_000, costPaise: 150_000, wipPaise: 0, minutes: 60 })).toMatchObject({ marginPaise: -50_000, marginPct: -50, loss: true });
    expect(pnlOf({ revenuePaise: 100_000, costPaise: null, wipPaise: 0, minutes: 60 })).toMatchObject({ marginPaise: null, loss: false });
  });
  it('capacity spreads weekly minutes over working days, minus holidays and leave', () => {
    const w = '2026-10-05';
    expect(weekCapacity(w, 2400, cal(), new Map())).toEqual({ capacityMinutes: 2400, workDays: 6, holidays: 0, leaveDays: 0 });
    expect(weekCapacity(w, 2400, cal([addDaysIso(w, 1)]), new Map([[addDaysIso(w, 2), 1], [addDaysIso(w, 3), 0.5]]))).toEqual({ capacityMinutes: 1400, workDays: 6, holidays: 1, leaveDays: 1.5 });
    expect(utilisationPct(1200, 2400)).toBe(50);
    expect(utilisationPct(10, 0)).toBeNull();
  });
});

describe('person-scoped permissions', () => {
  const role = (k: string) => SYSTEM_ROLES.find((r) => r.key === k)!;
  const actor = (k: string, userId = 'me', extra: Partial<Actor> = {}): Actor => ({ userId, teamIds: ['t1'], branchId: 'b1', roles: [role(k)], ...extra });
  const person = (userId: string, extra = {}) => ({ userId, branchId: 'b1', teamIds: [] as string[], managerId: null as string | null, ...extra });
  it('own, manager, team and firm-wide scopes; nobody approves themself', () => {
    expect(canPerson(actor('article'), 'time', 'view', person('me'))).toBe(true);
    expect(canPerson(actor('article'), 'time', 'view', person('other'))).toBe(false);
    expect(canPerson(actor('senior'), 'time', 'view', person('other', { managerId: 'me' }))).toBe(true);
    expect(canPerson(actor('manager'), 'time', 'view', person('other', { teamIds: ['t1'] }))).toBe(true);
    expect(canPerson(actor('manager'), 'time', 'view', person('other', { teamIds: ['t2'] }))).toBe(false);
    expect(canApprovePerson(actor('partner'), 'time', person('other'))).toBe(true);
    expect(canApprovePerson(actor('partner'), 'time', person('me'))).toBe(false);
    expect(canApprovePerson(actor('article'), 'time', person('other', { managerId: 'me' }))).toBe(true);
    expect(canApprovePerson(actor('senior'), 'time', person('other'))).toBe(false);
    expect(canSeeCost(actor('partner'))).toBe(true);
    expect(canSeeCost(actor('admin'))).toBe(true);
    expect(canSeeCost(actor('manager'))).toBe(false);
    expect(canSeeCost(actor('accountant'))).toBe(false);
  });
});
