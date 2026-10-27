import { describe, expect, it, vi } from 'vitest';
import { backoffMs, defaultPrefs, inQuietHours, istMinutes, nextAllowed, planDelivery, prefsSchema, ReminderScheduler, type LocalReminder } from './index.js';

const ist = (hhmm: string, day = '2026-10-27') => new Date(`${day}T${hhmm}:00+05:30`);

describe('quiet hours (IST)', () => {
  const q = { start: '21:00', end: '08:00' };
  it('handles windows that wrap midnight', () => {
    expect(istMinutes(ist('00:30'))).toBe(30);
    expect(inQuietHours(ist('22:00'), q)).toBe(true);
    expect(inQuietHours(ist('07:59'), q)).toBe(true);
    expect(inQuietHours(ist('08:00'), q)).toBe(false);
    expect(inQuietHours(ist('13:00'), q)).toBe(false);
    expect(inQuietHours(ist('13:00'), { start: '12:00', end: '14:00' })).toBe(true);
    expect(inQuietHours(ist('13:00'), null)).toBe(false);
  });
  it('defers to the end of the window, across midnight', () => {
    expect(nextAllowed(ist('22:15'), q).toISOString()).toBe(ist('08:00', '2026-10-28').toISOString());
    expect(nextAllowed(ist('06:00'), q).toISOString()).toBe(ist('08:00').toISOString());
    expect(nextAllowed(ist('10:00'), q)).toEqual(ist('10:00'));
  });
});

describe('delivery plan', () => {
  const prefs = prefsSchema.parse({ categories: { 'task.commented': { muted: true }, 'invoice.due': { push: false } } });
  it('respects mutes, push-off and quiet hours; critical overrides all', () => {
    expect(planDelivery({ category: 'task.commented', priority: 'normal', fireAt: ist('10:00'), prefs }).reason).toBe('muted');
    expect(planDelivery({ category: 'invoice.due', priority: 'normal', fireAt: ist('10:00'), prefs }).push).toBe(false);
    const q = planDelivery({ category: 'task.overdue', priority: 'high', fireAt: ist('23:00'), prefs });
    expect(q).toMatchObject({ push: true, reason: 'quiet_hours' });
    expect(planDelivery({ category: 'task.commented', priority: 'critical', fireAt: ist('23:00'), prefs })).toEqual({ push: true, sendAt: ist('23:00') });
  });
  it('backs off exponentially with a cap', () => {
    expect([1, 2, 3].map((a) => backoffMs(a))).toEqual([30_000, 60_000, 120_000]);
    expect(backoffMs(30)).toBe(6 * 3600_000);
  });
});

describe('offline reminder scheduler', () => {
  const r = (id: string, at: string, extra: Partial<LocalReminder> = {}): LocalReminder =>
    ({ id, title: id, body: '', category: 'notice.hearing', priority: 'high', fireAt: ist(at).toISOString(), ...extra });
  it('fires due reminders once, reports time to the next, skips read ones', () => {
    let now = ist('10:00').getTime();
    const show = vi.fn();
    const s = new ReminderScheduler({ now: () => now, show, prefs: defaultPrefs });
    const items = [r('a', '09:59'), r('b', '10:30'), r('c', '09:00', { readAt: 'x' })];
    expect(s.tick(items)).toBe(30 * 60_000);
    expect(show.mock.calls.map((c) => c[0].id)).toEqual(['a']);
    now = ist('10:31').getTime();
    s.tick(items); s.tick(items);
    expect(show.mock.calls.map((c) => c[0].id)).toEqual(['a', 'b']);
  });
  it('re-fires after snooze and survives restarts via load/save', () => {
    let now = ist('10:00').getTime(); let saved: string[] = [];
    const show = vi.fn();
    const mk = () => new ReminderScheduler({ now: () => now, show, prefs: defaultPrefs, load: () => saved, save: (x) => (saved = x) });
    mk().tick([r('a', '09:00')]);
    mk().tick([r('a', '09:00')]); // restart: not repeated
    expect(show).toHaveBeenCalledTimes(1);
    now = ist('11:00').getTime();
    mk().tick([r('a', '09:00', { snoozedUntil: ist('10:45').toISOString() })]);
    expect(show).toHaveBeenCalledTimes(2);
  });
  it('lists upcoming reminders for OS pre-scheduling, quiet-hours aware', () => {
    const s = new ReminderScheduler({ now: () => ist('10:00').getTime(), show() {}, prefs: defaultPrefs });
    const up = s.upcoming([r('late', '22:00', { priority: 'normal' }), r('soon', '11:00')]);
    expect(up.map((u) => u.reminder.id)).toEqual(['soon', 'late']);
    expect(up[1]!.at).toBe(ist('08:00', '2026-10-28').getTime());
  });
});
