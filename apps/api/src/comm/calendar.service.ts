import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import {
  availableSlots, buildIcs, effectiveScope, normalizeEmail, normalizePhone, renderTemplate, type IcsEvent, type Interval, type WorkingHours,
} from '@worko/domain';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { loadTeamIds, loadUserRoles } from '../auth/roles.repo.js';
import { publicBase } from '../billing/providers.js';
import { Params } from '../clients/scope.js';
import { Clock } from '../common/clock.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { JobQueueService } from '../jobs/job-queue.service.js';
import { insertNotifications } from '../notifications/insert.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { SyncService } from '../sync/sync.service.js';
import { systemActor } from '../tasks/system-actor.js';
import { taskScopeSql } from '../tasks/scope.js';
import { CommService } from './comm.service.js';
import { firmName, istDay, loadCommSettings, matchAddress } from './common.js';
import { calendarScopeSql } from './sync-rules.js';

export const REMINDER_JOB = 'comm.appt_reminder';
const DAY = 86_400_000;
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const dayAdd = (iso: string, k: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + k * DAY).toISOString().slice(0, 10);
const istStart = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - 330 * 60_000);
const fmtIst = (d: Date) => `${d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} IST`;

// ---------- Signed appointment links (revocable: the nonce rotates on reschedule/cancel) ----------
const linkKey = () => createHash('sha256').update(`appointment-link:${process.env.JWT_SIGNING_KEY ?? 'worko-dev-only-signing-key'}`).digest();
export function signAppointmentLink(tenantId: string, id: string, nonce: string) {
  const payload = Buffer.from(JSON.stringify({ t: tenantId, a: id, n: nonce })).toString('base64url');
  return `${payload}.${createHmac('sha256', linkKey()).update(payload).digest('base64url')}`;
}
function verifyAppointmentLink(token: string): { tenantId: string; id: string; nonce: string } | null {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expect = createHmac('sha256', linkKey()).update(payload).digest(); const got = Buffer.from(sig, 'base64url');
  if (got.length !== expect.length || !timingSafeEqual(got, expect)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { t: string; a: string; n: string };
    return isUuid(p.t) && isUuid(p.a) && typeof p.n === 'string' ? { tenantId: p.t, id: p.a, nonce: p.n } : null;
  } catch { return null; }
}
const nonceEq = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

type PageIn = { slug: string; title: string; description?: string | null; hostUserIds?: string[]; slotMinutes?: number; bufferMinutes?: number; workingHours: WorkingHours;
  horizonDays?: number; minNoticeMinutes?: number; createTask?: boolean; active?: boolean };
type BookIn = { startsAt: string; name: string; email?: string | null; phone?: string | null; purpose: string; consent?: boolean };
type CalItem = { source: 'event' | 'task' | 'leave' | 'holiday'; id: string; kind: string; title: string; startsAt: Date; endsAt: Date; allDay: boolean; clientId: string | null; clientName: string | null; editable: boolean };

@Injectable()
export class CalendarService implements OnModuleInit {
  constructor(private db: DbService, private audit: AuditService, private sync: SyncService, private realtime: RealtimeService, private jobs: JobQueueService,
    private clock: Clock, private comm: CommService) {}

  onModuleInit() { this.jobs.register(REMINDER_JOB, (j, at) => this.remind(j.tenant_id, j.ref_id, at)); }
  private staff(a: RequestActor) { if (!a.roles.length && !a.superAdmin) throw new ForbiddenException(); }
  private publish(tenantId: string, cursor: number) { if (cursor) this.realtime.publish({ type: 'changed', tenantId, cursor }); }

  // ---------- Calendar view: events + read-only projections ----------
  /** Own/attended events, act-by/due dates of the caller's visible open tasks, own leave and holidays (D107). */
  private async items(tx: Tx, a: RequestActor, from: string, to: string): Promise<CalItem[]> {
    const s = istStart(from); const e = istStart(dayAdd(to, 1));
    const p = new Params([s, e]);
    const ev = (await tx.query(`SELECT x.*, c.name AS client_name FROM calendar_event x LEFT JOIN client c ON c.id = x.client_id
      WHERE x.deleted_at IS NULL AND x.starts_at < $2 AND x.ends_at >= $1 AND ${calendarScopeSql(a, p)} ORDER BY x.starts_at`, p.values)).rows;
    const out: CalItem[] = ev.map((r) => ({ source: 'event', id: r.id, kind: r.kind, title: r.title, startsAt: r.starts_at, endsAt: r.ends_at, allDay: r.all_day, clientId: r.client_id,
      clientName: r.client_name, editable: r.owner_id === a.userId && ['meeting', 'personal'].includes(r.kind) }));
    const tp = new Params([from, to, a.userId]);
    const tasks = (await tx.query(`SELECT t.id, t.title, COALESCE(t.act_by, t.statutory_due) AS d, t.client_id, c.name AS client_name FROM task t LEFT JOIN client c ON c.id = t.client_id
      WHERE t.deleted_at IS NULL AND t.outcome IS NULL AND t.status NOT IN ('done','cancelled') AND COALESCE(t.act_by, t.statutory_due) BETWEEN $1 AND $2
        AND $3::uuid IN (t.assignee_id, t.reviewer_id, t.manager_id, t.leader_id) AND ${taskScopeSql(a, 'view', tp, 't', 'c')} ORDER BY d LIMIT 500`, tp.values)).rows;
    for (const t of tasks) {
      const d = ymd(t.d);
      out.push({ source: 'task', id: t.id, kind: 'task_due', title: t.title, startsAt: istStart(d), endsAt: istStart(d), allDay: true, clientId: t.client_id, clientName: t.client_name, editable: false });
    }
    const lv = (await tx.query(`SELECT l.id, COALESCE(l.approved_from, l.from_date) AS f, COALESCE(l.approved_to, l.to_date) AS t, l.status, lt.name FROM leave_request l JOIN leave_type lt ON lt.id = l.leave_type_id
      WHERE l.user_id = $1 AND l.deleted_at IS NULL AND l.status IN ('pending','approved','partially_approved') AND COALESCE(l.approved_from, l.from_date) <= $3 AND COALESCE(l.approved_to, l.to_date) >= $2`, [a.userId, from, to])).rows;
    for (const l of lv) out.push({ source: 'leave', id: l.id, kind: l.status, title: `${l.name}${l.status === 'pending' ? ' (pending)' : ''}`, startsAt: istStart(ymd(l.f)), endsAt: istStart(ymd(l.t)), allDay: true, clientId: null, clientName: null, editable: false });
    const hol = (await tx.query(`SELECT id, on_date, name FROM holiday WHERE deleted_at IS NULL AND on_date BETWEEN $1 AND $2 AND (branch_id IS NULL OR branch_id IS NOT DISTINCT FROM $3::uuid)`, [from, to, a.branchId])).rows;
    for (const h of hol) out.push({ source: 'holiday', id: h.id, kind: 'holiday', title: h.name, startsAt: istStart(ymd(h.on_date)), endsAt: istStart(ymd(h.on_date)), allDay: true, clientId: null, clientName: null, editable: false });
    return out.sort((x, y) => x.startsAt.getTime() - y.startsAt.getTime());
  }
  events(a: RequestActor, q: { from: string; to: string }) {
    this.staff(a);
    if (q.to < q.from || Date.parse(q.to) - Date.parse(q.from) > 92 * DAY) throw new BadRequestException('Range: from ≤ to, at most 92 days');
    return this.db.tenantTx(a.tenantId, (tx) => this.items(tx, a, q.from, q.to));
  }
  async createEvent(a: RequestActor, b: Record<string, unknown>) {
    this.staff(a);
    const id = uuidv7();
    const r = await this.db.tenantTx(a.tenantId, (tx) => this.sync.applyInTx(tx, a, { table: 'calendar_event', id, baseVersion: 0, patch: b }));
    this.publish(a.tenantId, r.cursor);
    return { id };
  }
  async updateEvent(a: RequestActor, id: string, b: Record<string, unknown>, del = false) {
    this.staff(a);
    const r = await this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params([id]);
      const cur = (await tx.query(`SELECT * FROM calendar_event x WHERE x.id = $1 AND x.deleted_at IS NULL AND ${calendarScopeSql(a, p)}`, p.values)).rows[0];
      if (!cur) throw new NotFoundException();
      return this.sync.applyInTx(tx, a, { table: 'calendar_event', id, baseVersion: cur.version, patch: b, delete: del });
    });
    this.publish(a.tenantId, r.cursor);
  }

  // ---------- ICS feeds ----------
  feeds(a: RequestActor) {
    this.staff(a);
    return this.db.tenantTx(a.tenantId, async (tx) => (await tx.query(`SELECT id, label, mask_clients AS "maskClients", created_at AS "createdAt", revoked_at AS "revokedAt", last_used_at AS "lastUsedAt"
      FROM ics_feed WHERE user_id = $1 ORDER BY created_at DESC`, [a.userId])).rows);
  }
  /** The token is shown once; only its hash is stored. */
  async createFeed(a: RequestActor, b: { maskClients?: boolean; label?: string | null }) {
    this.staff(a);
    const token = randomBytes(24).toString('base64url');
    const id = uuidv7();
    await this.db.tenantTx(a.tenantId, async (tx) => {
      await tx.query('INSERT INTO ics_feed (id, tenant_id, user_id, token_hash, mask_clients, label) VALUES ($1,$2,$3,$4,$5,$6)',
        [id, a.tenantId, a.userId, createHash('sha256').update(token).digest('hex'), b.maskClients ?? false, b.label ?? null]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'calendar.feed_created', entity: 'ics_feed', entityId: id, diff: { maskClients: b.maskClients ?? false } });
    });
    return { id, url: `${publicBase()}/calendar/ics/${a.tenantId}/${token}`, maskClients: b.maskClients ?? false };
  }
  async revokeFeed(a: RequestActor, id: string) {
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const r = await tx.query('UPDATE ics_feed SET revoked_at = $3 WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL', [id, a.userId, this.clock.now()]);
      if (!r.rowCount) throw new NotFoundException();
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'calendar.feed_revoked', entity: 'ics_feed', entityId: id });
    });
  }
  /** Public ICS: titles only, evaluated with the owner's current permissions; client names masked on request (D107). */
  async ics(tenantId: string, token: string): Promise<string> {
    if (!isUuid(tenantId) || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new NotFoundException();
    if (!(await this.db.systemTx((tx) => tx.query('SELECT 1 FROM tenant WHERE id = $1', [tenantId]))).rowCount) throw new NotFoundException();
    const now = this.clock.now();
    return this.db.tenantTx(tenantId, async (tx) => {
      const f = (await tx.query('SELECT f.*, u.branch_id, u.status, u.name FROM ics_feed f JOIN app_user u ON u.id = f.user_id WHERE f.token_hash = $1', [createHash('sha256').update(token).digest('hex')])).rows[0];
      if (!f || f.revoked_at || f.status !== 'active') throw new NotFoundException();
      await tx.query('UPDATE ics_feed SET last_used_at = $2 WHERE id = $1', [f.id, now]);
      const actor: RequestActor = { userId: f.user_id, tenantId, sessionId: '', deviceId: 'ics', branchId: f.branch_id, teamIds: await loadTeamIds(tx, f.user_id), roles: await loadUserRoles(tx, f.user_id) };
      const today = istDay(now);
      const items = await this.items(tx, actor, dayAdd(today, -30), dayAdd(today, 180));
      const evs: IcsEvent[] = items.map((i) => {
        let title = i.title;
        if (i.clientName) {
          if (!f.mask_clients) title = `${title} — ${i.clientName}`;
          else if (i.source === 'event') title = i.kind === 'appointment' ? 'Appointment' : 'Client meeting';
          else title = title.split(new RegExp(i.clientName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')).join('Client');
        }
        return { uid: `${i.source}-${i.id}@worko`, start: i.startsAt, end: i.endsAt, allDay: i.allDay, summary: title };
      });
      return buildIcs(`${f.name} — Worko`, evs, now);
    });
  }

  // ---------- Booking pages ----------
  private async checkHosts(tx: Tx, a: RequestActor, hosts: string[]) {
    if (hosts.some((h) => h !== a.userId) && !a.superAdmin && effectiveScope(a, 'communication', 'edit')?.scope !== 'all') throw new ForbiddenException('Hosts other than yourself need firm-wide communication:edit');
    const n = (await tx.query(`SELECT count(*)::int AS n FROM app_user WHERE id = ANY($1) AND status = 'active' AND kind = 'staff' AND deleted_at IS NULL`, [hosts])).rows[0].n;
    if (n !== new Set(hosts).size) throw new BadRequestException({ message: 'Unknown host', code: 'invalid_host' });
  }
  pages(a: RequestActor) {
    return this.db.tenantTx(a.tenantId, async (tx) => (await tx.query(`SELECT * FROM booking_page WHERE deleted_at IS NULL AND ($1 OR $2::uuid = ANY(host_user_ids)) ORDER BY title`,
      [!!a.superAdmin || effectiveScope(a, 'communication', 'view')?.scope === 'all', a.userId])).rows.map(pageOut));
  }
  async savePage(a: RequestActor, id: string | null, b: Partial<PageIn>) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const cur = id ? (await tx.query('SELECT * FROM booking_page WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0] : null;
      if (id && !cur) throw new NotFoundException();
      if (cur && !cur.host_user_ids.includes(a.userId) && !a.superAdmin && effectiveScope(a, 'communication', 'edit')?.scope !== 'all') throw new NotFoundException();
      const hosts = b.hostUserIds ?? cur?.host_user_ids ?? [a.userId];
      if (!cur || b.hostUserIds) await this.checkHosts(tx, a, hosts);
      const v = { slug: b.slug ?? cur?.slug, title: b.title ?? cur?.title, description: b.description === undefined ? cur?.description ?? null : b.description, slot: b.slotMinutes ?? cur?.slot_minutes ?? 30,
        buffer: b.bufferMinutes ?? cur?.buffer_minutes ?? 0, wh: b.workingHours ?? cur?.working_hours, horizon: b.horizonDays ?? cur?.horizon_days ?? 30, notice: b.minNoticeMinutes ?? cur?.min_notice_minutes ?? 120,
        task: b.createTask ?? cur?.create_task ?? false, active: b.active ?? cur?.active ?? true };
      const pid = id ?? uuidv7();
      try {
        if (cur) await tx.query(`UPDATE booking_page SET slug = $2, title = $3, description = $4, host_user_ids = $5, slot_minutes = $6, buffer_minutes = $7, working_hours = $8, horizon_days = $9,
            min_notice_minutes = $10, create_task = $11, active = $12, updated_by = $13 WHERE id = $1`, [pid, v.slug, v.title, v.description, hosts, v.slot, v.buffer, JSON.stringify(v.wh), v.horizon, v.notice, v.task, v.active, a.userId]);
        else await tx.query(`INSERT INTO booking_page (id, tenant_id, slug, title, description, host_user_ids, slot_minutes, buffer_minutes, working_hours, horizon_days, min_notice_minutes, create_task, active, created_by, updated_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)`, [pid, a.tenantId, v.slug, v.title, v.description, hosts, v.slot, v.buffer, JSON.stringify(v.wh), v.horizon, v.notice, v.task, v.active, a.userId]);
      } catch (e) { if ((e as { code?: string }).code === '23505') throw new ConflictException('Slug already used'); throw e; }
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: cur ? 'booking_page.updated' : 'booking_page.created', entity: 'booking_page', entityId: pid, diff: { ...b } });
      return pageOut((await tx.query('SELECT * FROM booking_page WHERE id = $1', [pid])).rows[0]);
    });
  }
  appointments(a: RequestActor, q: { from?: string; to?: string }) {
    this.staff(a);
    return this.db.tenantTx(a.tenantId, async (tx) => (await tx.query(`SELECT ap.id, ap.page_id AS "pageId", ap.host_user_id AS "hostUserId", ap.starts_at AS "startsAt", ap.ends_at AS "endsAt", ap.status,
        ap.client_id AS "clientId", ap.name, ap.email, ap.phone, ap.purpose, ap.task_id AS "taskId", ap.event_id AS "eventId", ap.reschedules
      FROM appointment ap WHERE ($1 OR ap.host_user_id = $2) AND ($3::date IS NULL OR ap.starts_at >= $3::date - interval '5 hours 30 minutes') AND ($4::date IS NULL OR ap.starts_at < $4::date + interval '18 hours 30 minutes')
      ORDER BY ap.starts_at LIMIT 500`, [!!a.superAdmin || effectiveScope(a, 'communication', 'view')?.scope === 'all', a.userId, q.from ?? null, q.to ?? null])).rows);
  }

  // ---------- Availability ----------
  private async hostSlots(tx: Tx, page: Record<string, unknown>, host: string, from: string, to: string, now: Date, excludeAppt?: string): Promise<Date[]> {
    const s = istStart(from); const e = istStart(dayAdd(to, 1));
    const busy: Interval[] = [
      ...(await tx.query(`SELECT starts_at, ends_at FROM calendar_event WHERE deleted_at IS NULL AND busy AND (owner_id = $1 OR $1 = ANY(attendee_ids)) AND starts_at < $3 AND ends_at > $2
          AND ($4::uuid IS NULL OR appointment_id IS DISTINCT FROM $4)`, [host, s, e, excludeAppt ?? null])).rows,
      ...(await tx.query(`SELECT starts_at, ends_at FROM appointment WHERE host_user_id = $1 AND status = 'booked' AND starts_at < $3 AND ends_at > $2 AND ($4::uuid IS NULL OR id <> $4)`, [host, s, e, excludeAppt ?? null])).rows,
    ].map((r) => ({ start: r.starts_at, end: r.ends_at }));
    const branch = (await tx.query('SELECT branch_id FROM app_user WHERE id = $1', [host])).rows[0]?.branch_id ?? null;
    const off = new Set<string>((await tx.query(`SELECT on_date FROM holiday WHERE deleted_at IS NULL AND NOT optional AND on_date BETWEEN $1 AND $2 AND (branch_id IS NULL OR branch_id IS NOT DISTINCT FROM $3::uuid)`, [from, to, branch])).rows.map((r) => ymd(r.on_date)));
    for (const l of (await tx.query(`SELECT COALESCE(approved_from, from_date) AS f, COALESCE(approved_to, to_date) AS t FROM leave_request WHERE user_id = $1 AND deleted_at IS NULL
        AND status IN ('approved','partially_approved') AND COALESCE(approved_from, from_date) <= $3 AND COALESCE(approved_to, to_date) >= $2`, [host, from, to])).rows) {
      for (let d = ymd(l.f); d <= ymd(l.t); d = dayAdd(d, 1)) off.add(d);
    }
    return availableSlots({ from, to, workingHours: page.working_hours as WorkingHours, slotMinutes: Number(page.slot_minutes), bufferMinutes: Number(page.buffer_minutes), busy, daysOff: [...off],
      now, minNoticeMinutes: Number(page.min_notice_minutes) });
  }
  private async publicPage(firm: string) {
    const t = (await this.db.systemTx((tx) => tx.query('SELECT id FROM tenant WHERE slug = $1', [firm.toLowerCase()]))).rows[0];
    if (!t) throw new NotFoundException();
    return t.id as string;
  }
  private async loadPage(tx: Tx, slug: string) {
    const p = (await tx.query('SELECT * FROM booking_page WHERE slug = $1 AND deleted_at IS NULL AND active', [slug])).rows[0];
    if (!p) throw new NotFoundException();
    return p;
  }
  async publicSlots(firm: string, slug: string, q: { from?: string; to?: string }) {
    const tenantId = await this.publicPage(firm);
    const now = this.clock.now(); const today = istDay(now);
    return this.db.tenantTx(tenantId, async (tx) => {
      const page = await this.loadPage(tx, slug);
      const last = dayAdd(today, page.horizon_days);
      const from = q.from && q.from > today ? q.from : today;
      const to = [q.to ?? dayAdd(from, 13), last, dayAdd(from, 30)].sort()[0]!;
      const all = new Map<number, Date>();
      if (from <= to) for (const h of page.host_user_ids) for (const d of await this.hostSlots(tx, page, h, from, to, now)) all.set(d.getTime(), d);
      return { firm: await firmName(tx), title: page.title, description: page.description, slotMinutes: page.slot_minutes, from, to, slots: [...all.values()].sort((x, y) => x.getTime() - y.getTime()) };
    });
  }

  /** Books a slot: per-host advisory lock + availability re-check, with the exclusion constraint as the last line (D108). */
  async book(firm: string, slug: string, b: BookIn) {
    const tenantId = await this.publicPage(firm);
    const now = this.clock.now();
    const email = b.email ? normalizeEmail(b.email) : null; const phone = b.phone ? normalizePhone(b.phone) : null;
    if (!email && !phone) throw new BadRequestException({ message: 'Email or phone required', code: 'contact_required' });
    if ((b.email && !email) || (b.phone && !phone)) throw new BadRequestException({ message: 'Invalid email or phone', code: 'invalid_contact' });
    const start = new Date(b.startsAt);
    const r = await this.db.tenantTx(tenantId, async (tx) => {
      const page = await this.loadPage(tx, slug);
      const day = istDay(start);
      if (day > dayAdd(istDay(now), page.horizon_days)) throw new ConflictException({ message: 'Slot not available', code: 'slot_unavailable' });
      let host: string | null = null;
      for (const h of page.host_user_ids as string[]) {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`appt:${tenantId}:${h}`]);
        if ((await this.hostSlots(tx, page, h, day, day, now)).some((d) => d.getTime() === start.getTime())) { host = h; break; }
      }
      if (!host) throw new ConflictException({ message: 'Slot not available', code: 'slot_unavailable' });
      const end = new Date(start.getTime() + page.slot_minutes * 60_000);
      const match = email ? await matchAddress(tx, 'email', email) : { clientId: null, contactId: null };
      const m2 = !match.clientId && phone ? await matchAddress(tx, 'whatsapp', phone) : match;
      const clientId = m2.clientId;
      const id = uuidv7(); const eventId = uuidv7(); const nonce = randomBytes(12).toString('base64url');
      await tx.query(`INSERT INTO calendar_event (id, tenant_id, owner_id, kind, title, description, starts_at, ends_at, client_id, appointment_id, created_by, device_id)
        VALUES ($1,$2,$3,'appointment',$4,$5,$6,$7,$8,$9,NULL,'server')`, [eventId, tenantId, host, `Appointment: ${b.name.slice(0, 100)}`, b.purpose.slice(0, 1000), start, end, clientId, id]);
      try {
        await tx.query(`INSERT INTO appointment (id, tenant_id, page_id, host_user_id, starts_at, ends_at, client_id, name, email, phone, purpose, event_id, manage_nonce, device_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'server')`, [id, tenantId, page.id, host, start, end, clientId, b.name, email, phone, b.purpose, eventId, nonce]);
      } catch (e) {
        if ((e as { code?: string }).code === '23P01') throw new ConflictException({ message: 'Slot not available', code: 'slot_unavailable' });
        throw e;
      }
      let taskId: string | null = null;
      if (page.create_task) {
        taskId = uuidv7();
        await tx.query(`INSERT INTO task (id, tenant_id, client_id, title, description, status, priority, act_by, assignee_id, source, device_id) VALUES ($1,$2,$3,$4,$5,'open','normal',$6,$7,'manual','server')`,
          [taskId, tenantId, clientId, `Appointment: ${b.purpose.slice(0, 200)}`, `Booked via ${page.title}`, day, host]);
        await tx.query('UPDATE appointment SET task_id = $2 WHERE id = $1', [id, taskId]);
      }
      if (b.consent) {
        for (const [ch, addr] of [['email', email], ['whatsapp', phone], ['sms', phone]] as const) if (addr) await this.comm.upsertConsent(tx, tenantId, { channel: ch, address: addr, clientId, contactId: null, status: 'opted_in', source: 'booking', by: null, at: now });
      }
      await this.scheduleReminders(tx, tenantId, id, start, now);
      const n = await insertNotifications(tx, tenantId, { userIds: [host], category: 'appointment.booked', title: `New appointment ${fmtIst(start)}`, body: b.purpose.slice(0, 140), entityType: 'appointment', entityId: id, dedupeKey: `appt:${id}:${nonce}` });
      // No names/phones/emails in the audit diff (D108).
      await this.audit.record(tx, tenantId, { actorId: null, deviceId: 'public', action: 'appointment.booked', entity: 'appointment', entityId: id, diff: { pageId: page.id, host, startsAt: start, clientMatched: !!clientId, taskId, consent: !!b.consent } });
      const cursor = Math.max(n.cursor, Number((await tx.query('SELECT sync_cursor FROM calendar_event WHERE id = $1', [eventId])).rows[0].sync_cursor));
      return { id, host, start, end, nonce, cursor };
    });
    this.publish(tenantId, r.cursor);
    const token = signAppointmentLink(tenantId, r.id, r.nonce);
    await this.notifyBooker(tenantId, r.id, 'confirmation', token);
    return { id: r.id, startsAt: r.start, endsAt: r.end, manageToken: token, manageUrl: `${publicBase()}/book/manage/${token}` };
  }

  private async scheduleReminders(tx: Tx, tenantId: string, id: string, start: Date, now: Date) {
    const s = await loadCommSettings(tx);
    for (const m of s.appointments.reminderMinutesBefore) {
      const at = new Date(start.getTime() - m * 60_000);
      if (at > now) await this.jobs.enqueue(tx, tenantId, REMINDER_JOB, id, at);
    }
  }
  private async manageable(tx: Tx, token: string) {
    const t = verifyAppointmentLink(token);
    if (!t) throw new NotFoundException();
    const ap = (await tx.query('SELECT * FROM appointment WHERE id = $1 FOR UPDATE', [t.id])).rows[0];
    if (!ap || !nonceEq(ap.manage_nonce, t.nonce)) throw new NotFoundException();
    return { ap, tenantId: t.tenantId };
  }
  private tenantOf(token: string) { const t = verifyAppointmentLink(token); if (!t) throw new NotFoundException(); return t.tenantId; }
  async manageView(token: string) {
    return this.db.tenantTx(this.tenantOf(token), async (tx) => {
      const { ap } = await this.manageable(tx, token);
      const page = (await tx.query('SELECT title, slug FROM booking_page WHERE id = $1', [ap.page_id])).rows[0];
      return { status: ap.status, startsAt: ap.starts_at, endsAt: ap.ends_at, purpose: ap.purpose, page: page.title, slug: page.slug, firm: await firmName(tx) };
    });
  }
  async reschedule(token: string, b: { startsAt: string }) {
    const tenantId = this.tenantOf(token); const now = this.clock.now(); const start = new Date(b.startsAt);
    const r = await this.db.tenantTx(tenantId, async (tx) => {
      const { ap } = await this.manageable(tx, token);
      if (ap.status !== 'booked' || ap.starts_at <= now) throw new ConflictException({ message: 'Appointment can no longer be changed', code: 'not_changeable' });
      const page = (await tx.query('SELECT * FROM booking_page WHERE id = $1', [ap.page_id])).rows[0];
      const day = istDay(start);
      let host: string | null = null;
      for (const h of [ap.host_user_id, ...(page.host_user_ids as string[]).filter((x) => x !== ap.host_user_id)]) {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`appt:${tenantId}:${h}`]);
        if ((await this.hostSlots(tx, page, h, day, day, now, ap.id)).some((d) => d.getTime() === start.getTime())) { host = h; break; }
      }
      if (!host) throw new ConflictException({ message: 'Slot not available', code: 'slot_unavailable' });
      const end = new Date(start.getTime() + page.slot_minutes * 60_000); const nonce = randomBytes(12).toString('base64url');
      try {
        await tx.query(`UPDATE appointment SET starts_at = $2, ends_at = $3, host_user_id = $4, manage_nonce = $5, reschedules = reschedules + 1, reminders_sent = '{}' WHERE id = $1`, [ap.id, start, end, host, nonce]);
      } catch (e) { if ((e as { code?: string }).code === '23P01') throw new ConflictException({ message: 'Slot not available', code: 'slot_unavailable' }); throw e; }
      const ev = await this.sync.serverPatch(tx, systemActor(tenantId), 'calendar_event', ap.event_id, { starts_at: start, ends_at: end, owner_id: host });
      if (ap.task_id) await this.sync.serverPatch(tx, systemActor(tenantId), 'task', ap.task_id, { act_by: day, assignee_id: host });
      await this.scheduleReminders(tx, tenantId, ap.id, start, now);
      await this.audit.record(tx, tenantId, { actorId: null, deviceId: 'public', action: 'appointment.rescheduled', entity: 'appointment', entityId: ap.id, diff: { from: ap.starts_at, to: start, host } });
      return { id: ap.id, start, end, nonce, cursor: ev?.cursor ?? 0 };
    });
    this.publish(tenantId, r.cursor);
    const newToken = signAppointmentLink(tenantId, r.id, r.nonce);
    await this.notifyBooker(tenantId, r.id, 'rescheduled', newToken);
    return { id: r.id, startsAt: r.start, endsAt: r.end, manageToken: newToken, manageUrl: `${publicBase()}/book/manage/${newToken}` };
  }
  async cancelBooking(token: string) {
    const tenantId = this.tenantOf(token);
    const r = await this.db.tenantTx(tenantId, async (tx) => {
      const { ap } = await this.manageable(tx, token);
      if (ap.status !== 'booked') throw new ConflictException({ message: 'Already cancelled', code: 'not_changeable' });
      await tx.query(`UPDATE appointment SET status = 'cancelled', cancelled_at = $2, manage_nonce = $3 WHERE id = $1`, [ap.id, this.clock.now(), randomBytes(12).toString('base64url')]);
      const ev = (await tx.query('UPDATE calendar_event SET deleted_at = now() WHERE id = $1 RETURNING sync_cursor', [ap.event_id])).rows[0];
      await this.audit.record(tx, tenantId, { actorId: null, deviceId: 'public', action: 'appointment.cancelled', entity: 'appointment', entityId: ap.id, diff: { startsAt: ap.starts_at } });
      return { id: ap.id, cursor: Number(ev?.sync_cursor ?? 0) };
    });
    this.publish(tenantId, r.cursor);
    await this.notifyBooker(tenantId, r.id, 'cancelled', null);
    return { status: 'cancelled' };
  }

  /**
   * Confirmation/reminder to the booker through the channel layer (transactional: consent/opt-out and quiet hours apply).
   * Email works without a template; WhatsApp/SMS need an approved `appointment_<kind>` template (D108).
   */
  private async notifyBooker(tenantId: string, id: string, kind: 'confirmation' | 'reminder' | 'rescheduled' | 'cancelled', token: string | null) {
    const now = this.clock.now();
    const q = await this.db.tenantTx(tenantId, async (tx) => {
      const ap = (await tx.query('SELECT * FROM appointment WHERE id = $1', [id])).rows[0];
      const page = (await tx.query('SELECT title FROM booking_page WHERE id = $1', [ap.page_id])).rows[0];
      const vars: Record<string, string> = { 'firm.name': await firmName(tx), 'contact.name': ap.name, 'appointment.time': fmtIst(ap.starts_at), ...(token ? { 'appointment.link': `${publicBase()}/book/manage/${token}` } : {}) };
      for (const [channel, address] of [['email', ap.email], ['whatsapp', ap.phone], ['sms', ap.phone]] as const) {
        if (!address) continue;
        const t = (await tx.query(`SELECT * FROM comm_template WHERE name = $1 AND channel = $2 AND status = 'approved' AND deleted_at IS NULL ORDER BY language LIMIT 1`, [`appointment_${kind}`, channel])).rows[0];
        if (!t && channel !== 'email') continue;
        const body = t ? renderTemplate(t.body, vars, channel === 'email' ? 'html' : 'text').text
          : `Dear ${ap.name.replace(/[\r\n]/g, ' ')}, your appointment (${page.title}) is ${kind === 'cancelled' ? 'cancelled' : `${kind === 'reminder' ? 'coming up' : 'confirmed'} for ${vars['appointment.time']}`}.${token ? ` Manage: ${vars['appointment.link']}` : ''} — ${vars['firm.name']}`;
        const subject = t?.subject ? renderTemplate(t.subject, vars).text : `Appointment ${kind}: ${page.title}`;
        const res = await this.comm.queueTx(tx, tenantId, { clientId: ap.client_id, contactId: null, channel, address, category: 'transactional', subject: channel === 'email' ? subject : null, text: body,
          templateId: t?.id ?? null, templateName: t?.name ?? null, language: t?.language ?? null, templateParams: [], createdBy: null, now, meta: { appointmentId: id, kind } });
        await this.audit.record(tx, tenantId, { actorId: null, deviceId: 'server', action: 'appointment.notified', entity: 'appointment', entityId: id, diff: { kind, channel, outcome: 'error' in res ? res.error : 'queued' } });
        if (!('error' in res)) return res;
      }
      return null;
    });
    if (q && q.sendAt <= now) await this.comm.deliverNow(tenantId, q.id, now);
  }
  private async remind(tenantId: string, id: string, at: Date) {
    const due = await this.db.tenantTx(tenantId, async (tx) => {
      const ap = (await tx.query('SELECT * FROM appointment WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!ap || ap.status !== 'booked' || ap.starts_at <= at) return false;
      const s = await loadCommSettings(tx);
      const keys = s.appointments.reminderMinutesBefore.filter((m) => ap.starts_at.getTime() - m * 60_000 <= at.getTime()).map((m) => `${ap.starts_at.toISOString()}|${m}`);
      const fresh = keys.filter((k) => !ap.reminders_sent.includes(k));
      if (!fresh.length) return false;
      await tx.query('UPDATE appointment SET reminders_sent = reminders_sent || $2::text[] WHERE id = $1', [id, fresh]);
      return true;
    });
    if (due) await this.notifyBooker(tenantId, id, 'reminder', null);
  }
}

const ymd = (v: unknown): string => (v instanceof Date ? new Date(v.getTime() - v.getTimezoneOffset() * 60_000).toISOString().slice(0, 10) : String(v).slice(0, 10));
const pageOut = (r: Record<string, unknown>) => ({ id: r.id, slug: r.slug, title: r.title, description: r.description, hostUserIds: r.host_user_ids, slotMinutes: r.slot_minutes,
  bufferMinutes: r.buffer_minutes, workingHours: r.working_hours, horizonDays: r.horizon_days, minNoticeMinutes: r.min_notice_minutes, createTask: r.create_task, active: r.active, version: r.version });
