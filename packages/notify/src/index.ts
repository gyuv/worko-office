import { z } from 'zod';

/** Notification categories (spec §7). Clients mute/route per category; Android maps each to a channel. */
export const CATEGORIES = [
  'task.assigned', 'task.mentioned', 'task.commented', 'task.stage_changed', 'task.due_today', 'task.due_soon', 'task.overdue',
  'compliance.deadline', 'notice.response_due', 'notice.hearing', 'invoice.due', 'payment.received',
  'dsc.expiring', 'licence.expiring', 'leave.approval', 'attendance.approval', 'document.received', 'client.uploaded',
  'whatsapp.reply', 'comm.inbound', 'chat.mentioned', 'broadcast.approval', 'appointment.booked', 'automation.failed', 'system.security', 'system.test',
] as const;
export type Category = (typeof CATEGORIES)[number];
export type Priority = 'low' | 'normal' | 'high' | 'critical';
export type PushChannel = 'fcm' | 'webpush';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const prefsSchema = z.object({
  quietHours: z.object({ start: hhmm, end: hhmm }).nullable().default({ start: '21:00', end: '08:00' }),
  categories: z.record(z.enum(CATEGORIES), z.object({ push: z.boolean().default(true), muted: z.boolean().default(false) })).default({}),
  digest: z.enum(['off', 'morning', 'morning_evening']).default('off'),
});
export type Prefs = z.infer<typeof prefsSchema>;
export const defaultPrefs = (): Prefs => prefsSchema.parse({});

/** Minutes since IST midnight for an instant. IST has no DST, so a fixed +5:30 offset is exact. */
export function istMinutes(at: Date): number {
  return Math.floor(((at.getTime() / 60_000 + 330) % 1440 + 1440) % 1440);
}
const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

/** Quiet window may wrap midnight (21:00–08:00). start == end means "no quiet hours". */
export function inQuietHours(at: Date, q: Prefs['quietHours']): boolean {
  if (!q) return false;
  const m = istMinutes(at); const s = toMin(q.start); const e = toMin(q.end);
  if (s === e) return false;
  return s < e ? m >= s && m < e : m >= s || m < e;
}

/** Earliest instant >= `at` outside quiet hours. */
export function nextAllowed(at: Date, q: Prefs['quietHours']): Date {
  if (!inQuietHours(at, q)) return at;
  const delta = (toMin(q!.end) - istMinutes(at) + 1440) % 1440;
  const d = new Date(at.getTime() + delta * 60_000);
  d.setUTCSeconds(0, 0);
  return d;
}

export type PlanInput = { category: Category; priority: Priority; fireAt: Date; prefs: Prefs };
export type Plan = { push: boolean; sendAt: Date; reason?: 'muted' | 'push_off' | 'quiet_hours' };

/**
 * Decide whether/when to push. In-app inbox always gets the item (unless muted). Critical items ignore
 * quiet hours and mutes (spec: security alerts, hearings must not be silenced).
 */
export function planDelivery({ category, priority, fireAt, prefs }: PlanInput): Plan {
  const c = prefs.categories[category];
  if (priority !== 'critical') {
    if (c?.muted) return { push: false, sendAt: fireAt, reason: 'muted' };
    if (c && c.push === false) return { push: false, sendAt: fireAt, reason: 'push_off' };
    const at = nextAllowed(fireAt, prefs.quietHours);
    if (at.getTime() !== fireAt.getTime()) return { push: true, sendAt: at, reason: 'quiet_hours' };
  }
  return { push: true, sendAt: fireAt };
}

export function backoffMs(attempt: number, baseMs = 30_000, capMs = 6 * 3600_000): number {
  return Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

/** Minimal shape the local scheduler needs (matches synced `notification` rows). */
export type LocalReminder = {
  id: string; title: string; body: string; category: Category | string; priority: Priority;
  fireAt: string; readAt?: string | null; ackedAt?: string | null; snoozedUntil?: string | null; deletedAt?: string | null;
};

/**
 * Offline reminder scheduler for desktop/mobile. Works off the locally synced notification rows, so reminders
 * fire even with no network. Each reminder fires at most once per device (`fired` survives restarts via `save`).
 */
export class ReminderScheduler {
  private fired: Set<string>;
  constructor(
    private opts: { now: () => number; show: (r: LocalReminder) => void; prefs: () => Prefs; load?: () => string[]; save?: (ids: string[]) => void; maxPerTick?: number },
  ) { this.fired = new Set(opts.load?.() ?? []); }

  private dueAt(r: LocalReminder): number {
    const base = new Date(r.snoozedUntil && r.snoozedUntil > r.fireAt ? r.snoozedUntil : r.fireAt);
    return planDelivery({ category: r.category as Category, priority: r.priority, fireAt: base, prefs: this.opts.prefs() }).sendAt.getTime();
  }

  private key(r: LocalReminder) { return `${r.id}@${r.snoozedUntil ?? ''}`; }

  private active(r: LocalReminder) {
    if (r.readAt || r.ackedAt || r.deletedAt) return false;
    const p = planDelivery({ category: r.category as Category, priority: r.priority, fireAt: new Date(r.fireAt), prefs: this.opts.prefs() });
    return p.push;
  }

  /** Fires everything due; returns ms until the next reminder (or null). Old misses (>24h) are not replayed. */
  tick(items: LocalReminder[]): number | null {
    const now = this.opts.now();
    let next: number | null = null; let shown = 0;
    for (const r of items) {
      if (!this.active(r) || this.fired.has(this.key(r))) continue;
      const due = this.dueAt(r);
      if (due <= now) {
        // Only mark fired once actually shown (or too old to bother); overflow waits for the next tick.
        if (now - due >= 24 * 3600_000) this.fired.add(this.key(r));
        else if (shown < (this.opts.maxPerTick ?? 5)) { this.fired.add(this.key(r)); this.opts.show(r); shown++; }
        else next = 1_000;
      } else next = next === null ? due - now : Math.min(next, due - now);
      if (next !== null && next < 0) next = 0;
    }
    this.opts.save?.([...this.fired].slice(-2000));
    return next;
  }

  /**
   * Startup: mark everything already due as fired without showing it — those are in the inbox already.
   * Only reminders that come due (or arrive) while the app runs pop up.
   */
  prime(items: LocalReminder[]) {
    const now = this.opts.now();
    for (const r of items) if (this.active(r) && this.dueAt(r) <= now) this.fired.add(this.key(r));
    this.opts.save?.([...this.fired].slice(-2000));
  }

  /** Items that should be pre-scheduled with the OS (Android exact alarms) within `horizonMs`. */
  upcoming(items: LocalReminder[], horizonMs = 7 * 86400_000): Array<{ reminder: LocalReminder; at: number }> {
    const now = this.opts.now();
    return items.filter((r) => this.active(r) && !this.fired.has(this.key(r)))
      .map((r) => ({ reminder: r, at: this.dueAt(r) })).filter((x) => x.at > now && x.at - now <= horizonMs)
      .sort((a, b) => a.at - b.at);
  }
}
