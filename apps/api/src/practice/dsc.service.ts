import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { daysBetween, dueThresholds, type Action } from '@worko/domain';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { Clock } from '../common/clock.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { insertNotifications } from '../notifications/insert.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { SyncService } from '../sync/sync.service.js';
import { systemActor } from '../tasks/system-actor.js';
import { firmAll } from './scope.js';
import { clientFor, createLinkedTask, Cursor, loadPracticeSettings, Params, staffUser, visibleSql, ymd } from './common.js';

export type Custody = 'in_office' | 'with_client' | 'with_staff';
export type DscIn = {
  clientId?: string | null; holderKind: 'client_contact' | 'staff'; contactId?: string | null; holderUserId?: string | null; holderName?: string | null;
  dscClass: string; dscType: 'sign' | 'encrypt' | 'combo'; issuer: string; serialNo?: string | null; validFrom: string; validTo: string; tokenLabel?: string | null;
  custody?: Custody; custodyUserId?: string | null; notes?: string | null;
};
export type LicenceIn = { clientId: string; licenceType: string; number?: string | null; authority?: string | null; validFrom?: string | null; validTo?: string | null;
  renewalDue?: string | null; documentIds?: string[]; status?: 'active' | 'renewal_in_progress' | 'lapsed' | 'surrendered'; notes?: string | null };

/** Never stored: anything that looks like a token PIN/password is refused outright (D117). */
export const SECRET_KEY_RX = /pin|pass(word|code|phrase)?|secret|otp/i;

const dscOut = (r: Record<string, unknown>) => ({
  id: r.id, clientId: r.client_id, clientName: r.client_name ?? null, holderKind: r.holder_kind, contactId: r.contact_id, holderUserId: r.holder_user_id, holderName: r.holder_name,
  dscClass: r.dsc_class, dscType: r.dsc_type, issuer: r.issuer, serialNo: r.serial_no, validFrom: ymd(r.valid_from), validTo: ymd(r.valid_to), tokenLabel: r.token_label,
  custody: r.custody, custodyUserId: r.custody_user_id, alertsSent: r.alerts_sent, renewalTaskId: r.renewal_task_id, notes: r.notes, version: r.version,
});
const licOut = (r: Record<string, unknown>) => ({
  id: r.id, clientId: r.client_id, clientName: r.client_name ?? null, licenceType: r.licence_type, number: r.number, authority: r.authority, validFrom: ymd(r.valid_from),
  validTo: ymd(r.valid_to), renewalDue: ymd(r.renewal_due), documentIds: r.document_ids, alertsSent: r.alerts_sent, renewalTaskId: r.renewal_task_id, status: r.status, notes: r.notes, version: r.version,
});


@Injectable()
export class DscService {
  constructor(private db: DbService, private audit: AuditService, private sync: SyncService, private realtime: RealtimeService, private clock: Clock) {}

  private rec(tx: Tx, a: RequestActor, action: string, entity: string, entityId: string | null, diff?: unknown) {
    return this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action, entity, entityId, diff });
  }
  private publish(tenantId: string, c: Cursor) { if (c.v) this.realtime.publish({ type: 'changed', tenantId, cursor: c.v }); }

  /** Client-held: clients:view AND dsc on the client. Staff-held (firm) DSC: firm-wide dsc scope; the holder/custodian may view theirs. */
  private async loadDsc(tx: Tx, a: RequestActor, id: string, action: Action) {
    const d = (await tx.query('SELECT d.*, c.name AS client_name FROM dsc d LEFT JOIN client c ON c.id = d.client_id WHERE d.id = $1 AND d.deleted_at IS NULL FOR UPDATE OF d', [id])).rows[0];
    if (!d) throw new NotFoundException();
    if (d.client_id) await clientFor(tx, a, d.client_id, 'dsc', action);
    else {
      const mine = d.holder_user_id === a.userId || d.custody_user_id === a.userId;
      if (!firmAll(a, 'view') && !mine) throw new NotFoundException();
      if (action !== 'view' && !firmAll(a, action)) throw new ForbiddenException();
    }
    return d;
  }

  list(a: RequestActor, q: { clientId?: string; custody?: string; expiringWithinDays?: number; firm?: boolean }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params();
      const where = ['d.deleted_at IS NULL', `(CASE WHEN d.client_id IS NULL THEN (${firmAll(a, 'view') ? 'TRUE' : `(d.holder_user_id = ${p.add(a.userId)}::uuid OR d.custody_user_id = $${p.values.length}::uuid)`})
        ELSE COALESCE(c.deleted_at IS NULL AND ${visibleSql(a, 'dsc', p)}, FALSE) END)`];
      if (q.clientId) where.push(`d.client_id = ${p.add(q.clientId)}`);
      if (q.firm) where.push('d.client_id IS NULL');
      if (q.custody) where.push(`d.custody = ${p.add(q.custody)}`);
      if (q.expiringWithinDays !== undefined) where.push(`d.valid_to <= ${p.add(this.clock.todayIst())}::date + ${p.add(q.expiringWithinDays)}::int`);
      return (await tx.query(`SELECT d.*, c.name AS client_name FROM dsc d LEFT JOIN client c ON c.id = d.client_id WHERE ${where.join(' AND ')} ORDER BY d.valid_to, d.holder_name LIMIT 1000`, p.values)).rows.map(dscOut);
    });
  }

  get(a: RequestActor, id: string) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const d = await this.loadDsc(tx, a, id, 'view');
      const custodyLog = (await tx.query(`SELECT id, from_custody AS "fromCustody", to_custody AS "toCustody", to_user_id AS "toUserId", counterparty, purpose, moved_by AS "movedBy",
        moved_at AS "movedAt", acknowledged_at AS "acknowledgedAt", acknowledged_by AS "acknowledgedBy", acknowledged_name AS "acknowledgedName" FROM dsc_custody WHERE dsc_id = $1 ORDER BY moved_at, id`, [id])).rows;
      return { ...dscOut(d), daysLeft: daysBetween(this.clock.todayIst(), ymd(d.valid_to)!), custodyLog };
    });
  }

  private async holder(tx: Tx, a: RequestActor, b: DscIn, action: Action) {
    if (b.holderKind === 'client_contact') {
      if (!b.clientId) throw new BadRequestException({ message: 'Client required', code: 'invalid:clientId' });
      await clientFor(tx, a, b.clientId, 'dsc', action);
      if (b.contactId) {
        const ct = (await tx.query('SELECT name FROM contact WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL', [b.contactId, b.clientId])).rows[0];
        if (!ct) throw new BadRequestException({ message: 'Contact not of this client', code: 'invalid:contactId' });
        return { clientId: b.clientId, holderName: b.holderName ?? ct.name, holderUserId: null };
      }
      if (!b.holderName) throw new BadRequestException({ message: 'Holder name required', code: 'invalid:holderName' });
      return { clientId: b.clientId, holderName: b.holderName, holderUserId: null };
    }
    if (b.clientId) throw new BadRequestException({ message: 'A staff DSC has no client', code: 'invalid:clientId' });
    if (!firmAll(a, action)) throw new ForbiddenException();
    const u = await staffUser(tx, b.holderUserId, 'holderUserId');
    if (!u) throw new BadRequestException({ message: 'Holder user required', code: 'invalid:holderUserId' });
    return { clientId: null, holderName: b.holderName ?? u.name, holderUserId: u.id };
  }

  async create(a: RequestActor, b: DscIn) {
    const cur = new Cursor();
    const id = await this.db.tenantTx(a.tenantId, async (tx) => {
      const h = await this.holder(tx, a, b, 'create');
      if (b.validTo < b.validFrom) throw new BadRequestException({ message: 'Valid to before valid from', code: 'invalid:validTo' });
      const custody = b.custody ?? 'in_office';
      if ((custody === 'with_staff') !== !!b.custodyUserId) throw new BadRequestException({ message: 'Custodian user required exactly when with staff', code: 'invalid:custodyUserId' });
      await staffUser(tx, b.custodyUserId, 'custodyUserId');
      const id = uuidv7();
      await tx.query('SAVEPOINT dsc');
      try {
        const r = await tx.query(`INSERT INTO dsc (id, tenant_id, client_id, holder_kind, contact_id, holder_user_id, holder_name, dsc_class, dsc_type, issuer, serial_no, valid_from, valid_to, token_label,
            custody, custody_user_id, notes, created_by, updated_by, device_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18,'server') RETURNING sync_cursor`,
        [id, a.tenantId, h.clientId, b.holderKind, b.contactId ?? null, h.holderUserId, h.holderName, b.dscClass, b.dscType, b.issuer, b.serialNo ?? null, b.validFrom, b.validTo, b.tokenLabel ?? null,
          custody, b.custodyUserId ?? null, b.notes ?? null, a.userId]);
        cur.add(Number(r.rows[0].sync_cursor));
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new ConflictException({ message: 'A DSC with this issuer and serial exists', code: 'dsc_duplicate' });
        throw e;
      }
      await tx.query(`INSERT INTO dsc_custody (id, tenant_id, dsc_id, from_custody, to_custody, to_user_id, purpose, moved_by, moved_at) VALUES ($1,$2,$3,'new',$4,$5,'registered',$6,$7)`,
        [uuidv7(), a.tenantId, id, custody, b.custodyUserId ?? null, a.userId, this.clock.now()]);
      await this.rec(tx, a, 'dsc.created', 'dsc', id, { clientId: h.clientId, holderKind: b.holderKind, dscClass: b.dscClass, dscType: b.dscType, issuer: b.issuer, validTo: b.validTo, custody });
      return id;
    });
    this.publish(a.tenantId, cur);
    return { id };
  }

  async update(a: RequestActor, id: string, b: Partial<Pick<DscIn, 'dscClass' | 'dscType' | 'issuer' | 'serialNo' | 'validFrom' | 'validTo' | 'tokenLabel' | 'notes' | 'holderName'>>) {
    const cur = new Cursor();
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const d = await this.loadDsc(tx, a, id, 'edit');
      const map: Record<string, string> = { dscClass: 'dsc_class', dscType: 'dsc_type', issuer: 'issuer', serialNo: 'serial_no', validFrom: 'valid_from', validTo: 'valid_to', tokenLabel: 'token_label', notes: 'notes', holderName: 'holder_name' };
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(b)) if (v !== undefined && map[k]) patch[map[k]!] = v;
      const from = (b.validFrom ?? ymd(d.valid_from))!; const to = (b.validTo ?? ymd(d.valid_to))!;
      if (to < from) throw new BadRequestException({ message: 'Valid to before valid from', code: 'invalid:validTo' });
      // A renewal (new validity) restarts the alert cycle.
      if (b.validTo && b.validTo !== ymd(d.valid_to)) { patch.alerts_sent = []; patch.renewal_task_id = null; }
      cur.add((await this.sync.serverPatch(tx, a, 'dsc', id, patch))?.cursor);
      await this.rec(tx, a, 'dsc.updated', 'dsc', id, b);
    });
    this.publish(a.tenantId, cur);
  }

  async move(a: RequestActor, id: string, b: { to: Custody; toUserId?: string | null; counterparty?: string | null; purpose?: string | null }) {
    const cur = new Cursor();
    const mid = await this.db.tenantTx(a.tenantId, async (tx) => {
      const d = await this.loadDsc(tx, a, id, 'edit');
      if ((b.to === 'with_staff') !== !!b.toUserId) throw new BadRequestException({ message: 'Staff user required exactly when moving to staff', code: 'invalid:toUserId' });
      await staffUser(tx, b.toUserId, 'toUserId');
      if (b.to === d.custody && (b.toUserId ?? null) === d.custody_user_id) throw new BadRequestException({ message: 'Already there', code: 'no_change' });
      const mid = uuidv7();
      await tx.query(`INSERT INTO dsc_custody (id, tenant_id, dsc_id, from_custody, to_custody, to_user_id, counterparty, purpose, moved_by, moved_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [mid, a.tenantId, id, d.custody, b.to, b.toUserId ?? null, b.counterparty ?? null, b.purpose ?? null, a.userId, this.clock.now()]);
      cur.add((await this.sync.serverPatch(tx, a, 'dsc', id, { custody: b.to, custody_user_id: b.toUserId ?? null }))?.cursor);
      await this.rec(tx, a, 'dsc.custody_moved', 'dsc', id, { from: d.custody, to: b.to, toUserId: b.toUserId ?? null, counterparty: b.counterparty ?? null });
      return mid;
    });
    this.publish(a.tenantId, cur);
    return { id: mid };
  }

  /** The receiving staff member acknowledges themselves; a hand-over to a client/office is acknowledged by the recorder with the receiver's name. */
  async acknowledge(a: RequestActor, movementId: string, b: { name?: string | null }) {
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const m = (await tx.query('SELECT * FROM dsc_custody WHERE id = $1 FOR UPDATE', [movementId])).rows[0];
      if (!m) throw new NotFoundException();
      if (m.acknowledged_at) throw new ConflictException({ message: 'Already acknowledged', code: 'already_acknowledged' });
      const latest = (await tx.query('SELECT id FROM dsc_custody WHERE dsc_id = $1 ORDER BY moved_at DESC, id DESC LIMIT 1', [m.dsc_id])).rows[0];
      if (latest?.id !== movementId) throw new ConflictException({ message: 'Superseded by a later movement', code: 'superseded' });
      if (m.to_user_id) {
        if (m.to_user_id !== a.userId) throw new ForbiddenException({ message: 'Only the receiving user can acknowledge', code: 'forbidden' });
        await this.loadDsc(tx, a, m.dsc_id, 'view');
      } else {
        await this.loadDsc(tx, a, m.dsc_id, 'edit');
        if (!b.name?.trim()) throw new BadRequestException({ message: 'Name of the person who received it', code: 'invalid:name' });
      }
      await tx.query('UPDATE dsc_custody SET acknowledged_at = $2, acknowledged_by = $3, acknowledged_name = $4 WHERE id = $1', [movementId, this.clock.now(), a.userId, b.name ?? null]);
      await this.rec(tx, a, 'dsc.custody_acknowledged', 'dsc', m.dsc_id, { movementId });
    });
  }

  // ---------- Licences (module: compliance — D118) ----------
  listLicences(a: RequestActor, q: { clientId?: string; dueWithinDays?: number; status?: string }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params(); const where = ['l.deleted_at IS NULL', 'c.deleted_at IS NULL', visibleSql(a, 'compliance', p)];
      if (q.clientId) where.push(`l.client_id = ${p.add(q.clientId)}`);
      if (q.status) where.push(`l.status = ${p.add(q.status)}`);
      if (q.dueWithinDays !== undefined) where.push(`COALESCE(l.renewal_due, l.valid_to) <= ${p.add(this.clock.todayIst())}::date + ${p.add(q.dueWithinDays)}::int`);
      return (await tx.query(`SELECT l.*, c.name AS client_name FROM licence l JOIN client c ON c.id = l.client_id WHERE ${where.join(' AND ')}
        ORDER BY COALESCE(l.renewal_due, l.valid_to) NULLS LAST, c.name LIMIT 1000`, p.values)).rows.map(licOut);
    });
  }

  private async checkDocs(tx: Tx, clientId: string, ids?: string[]) {
    if (!ids?.length) return;
    const n = (await tx.query('SELECT count(*)::int AS n FROM document WHERE id = ANY($1::uuid[]) AND client_id = $2 AND deleted_at IS NULL', [ids, clientId])).rows[0].n;
    if (n !== new Set(ids).size) throw new BadRequestException({ message: 'Documents must belong to the client', code: 'invalid:documentIds' });
  }

  async createLicence(a: RequestActor, b: LicenceIn) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      await clientFor(tx, a, b.clientId, 'compliance', 'create');
      if (b.validFrom && b.validTo && b.validTo < b.validFrom) throw new BadRequestException({ message: 'Valid to before valid from', code: 'invalid:validTo' });
      await this.checkDocs(tx, b.clientId, b.documentIds);
      const id = uuidv7();
      await tx.query(`INSERT INTO licence (id, tenant_id, client_id, licence_type, number, authority, valid_from, valid_to, renewal_due, document_ids, status, notes, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [id, a.tenantId, b.clientId, b.licenceType, b.number ?? null, b.authority ?? null, b.validFrom ?? null, b.validTo ?? null,
        b.renewalDue ?? null, b.documentIds ?? [], b.status ?? 'active', b.notes ?? null, a.userId]);
      await this.rec(tx, a, 'licence.created', 'licence', id, { clientId: b.clientId, licenceType: b.licenceType, validTo: b.validTo ?? null, renewalDue: b.renewalDue ?? null });
      return { id };
    });
  }

  async updateLicence(a: RequestActor, id: string, b: Partial<Omit<LicenceIn, 'clientId'>>) {
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const l = (await tx.query('SELECT * FROM licence WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0];
      if (!l) throw new NotFoundException();
      await clientFor(tx, a, l.client_id, 'compliance', 'edit');
      await this.checkDocs(tx, l.client_id, b.documentIds);
      const vf = b.validFrom !== undefined ? b.validFrom : ymd(l.valid_from); const vt = b.validTo !== undefined ? b.validTo : ymd(l.valid_to);
      if (vf && vt && vt < vf) throw new BadRequestException({ message: 'Valid to before valid from', code: 'invalid:validTo' });
      const renewed = (b.validTo !== undefined && b.validTo !== ymd(l.valid_to)) || (b.renewalDue !== undefined && b.renewalDue !== ymd(l.renewal_due));
      await tx.query(`UPDATE licence SET licence_type = COALESCE($2, licence_type), number = CASE WHEN $3 THEN $4 ELSE number END, authority = CASE WHEN $5 THEN $6 ELSE authority END,
        valid_from = $7, valid_to = $8, renewal_due = CASE WHEN $9 THEN $10::date ELSE renewal_due END, document_ids = COALESCE($11, document_ids), status = COALESCE($12, status),
        notes = CASE WHEN $13 THEN $14 ELSE notes END, alerts_sent = CASE WHEN $15 THEN '{}' ELSE alerts_sent END, renewal_task_id = CASE WHEN $15 THEN NULL ELSE renewal_task_id END,
        version = version + 1, updated_at = now() WHERE id = $1`,
      [id, b.licenceType ?? null, b.number !== undefined, b.number ?? null, b.authority !== undefined, b.authority ?? null, vf, vt, b.renewalDue !== undefined, b.renewalDue ?? null,
        b.documentIds ?? null, b.status ?? null, b.notes !== undefined, b.notes ?? null, renewed]);
      await this.rec(tx, a, 'licence.updated', 'licence', id, b);
    });
  }

  // ---------- Expiry alerts (daily, idempotent per record × validity × threshold) ----------
  async expiryTx(tx: Tx, tenantId: string, today: string) {
    const s = await loadPracticeSettings(tx);
    const sys = systemActor(tenantId);
    const cur = new Cursor(); let alerts = 0; let tasks = 0;
    const dscs = (await tx.query(`SELECT d.*, c.name AS client_name, c.manager_id, c.partner_id FROM dsc d LEFT JOIN client c ON c.id = d.client_id
      WHERE d.deleted_at IS NULL AND d.valid_to <= $1::date + $2::int AND (c.id IS NULL OR c.deleted_at IS NULL) FOR UPDATE OF d`, [today, Math.max(...s.dsc.thresholds)])).rows;
    for (const d of dscs) {
      const validTo = ymd(d.valid_to)!;
      const due = dueThresholds(validTo, today, s.dsc.thresholds, d.alerts_sent ?? []);
      const left = daysBetween(today, validTo);
      const patch: Record<string, unknown> = {};
      const who = [d.holder_user_id, d.custody_user_id, d.manager_id, d.partner_id, d.created_by].filter((x): x is string => !!x);
      if (due.length && who.length) {
        const t = due[0]!;
        const r = await insertNotifications(tx, tenantId, { userIds: [...new Set(who)].slice(0, 4), category: 'dsc.expiring', priority: t <= 7 ? 'high' : 'normal',
          title: left < 0 ? `DSC expired: ${d.holder_name}` : left === 0 ? `DSC expires today: ${d.holder_name}` : `DSC expires in ${left} days: ${d.holder_name}`,
          body: `${d.dsc_class} ${d.dsc_type} · ${d.issuer} · valid to ${validTo}${d.client_name ? ` · ${d.client_name}` : ''}`, entityType: 'dsc', entityId: d.id, dedupeKey: `dsc:${d.id}:${validTo}:${t}` });
        alerts += r.ids.length; cur.add(r.cursor);
        patch.alerts_sent = [...(d.alerts_sent ?? []), t];
      }
      if (left <= s.dsc.renewalTaskDays && !d.renewal_task_id) {
        const t = await createLinkedTask(tx, tenantId, { clientId: d.client_id, title: `Renew DSC — ${d.holder_name} (${d.dsc_class}, ${d.issuer})`, statutoryDue: validTo < today ? today : validTo,
          actBy: null, assigneeId: d.manager_id ?? d.holder_user_id ?? null, ruleId: `dsc:${d.id}:${validTo}`, priority: left <= 7 ? 'urgent' : 'high', createdBy: null });
        cur.add(t.cursor); tasks++; patch.renewal_task_id = t.id;
      }
      if (Object.keys(patch).length) {
        cur.add((await this.sync.serverPatch(tx, sys, 'dsc', d.id, patch))?.cursor);
        await this.audit.record(tx, tenantId, { actorId: null, deviceId: 'server', action: 'dsc.expiry_alert', entity: 'dsc', entityId: d.id, diff: { threshold: due[0] ?? null, renewalTaskId: patch.renewal_task_id ?? null } });
      }
    }
    const lics = (await tx.query(`SELECT l.*, c.name AS client_name, c.manager_id, c.partner_id FROM licence l JOIN client c ON c.id = l.client_id
      WHERE l.deleted_at IS NULL AND c.deleted_at IS NULL AND l.status IN ('active','renewal_in_progress') AND COALESCE(l.renewal_due, l.valid_to) <= $1::date + $2::int FOR UPDATE OF l`,
    [today, Math.max(...s.licences.thresholds)])).rows;
    for (const l of lics) {
      const dueOn = ymd(l.renewal_due ?? l.valid_to)!;
      const due = dueThresholds(dueOn, today, s.licences.thresholds, l.alerts_sent ?? []);
      const left = daysBetween(today, dueOn);
      const who = [l.manager_id, l.partner_id, l.created_by].filter((x): x is string => !!x);
      let sent: number[] | null = null; let taskId: string | null = null;
      if (due.length && who.length) {
        const r = await insertNotifications(tx, tenantId, { userIds: [...new Set(who)], category: 'licence.expiring', priority: due[0]! <= 7 ? 'high' : 'normal',
          title: `${l.licence_type} ${left < 0 ? 'renewal overdue' : `renewal due in ${left} days`}: ${l.client_name}`, body: `${l.number ?? ''} · due ${dueOn}`.trim(),
          entityType: 'licence', entityId: l.id, dedupeKey: `licence:${l.id}:${dueOn}:${due[0]}` });
        alerts += r.ids.length; cur.add(r.cursor); sent = [...(l.alerts_sent ?? []), due[0]!];
      }
      if (left <= s.licences.renewalTaskDays && !l.renewal_task_id) {
        const t = await createLinkedTask(tx, tenantId, { clientId: l.client_id, title: `Renew ${l.licence_type}${l.number ? ` (${l.number})` : ''}`, statutoryDue: dueOn < today ? today : dueOn,
          actBy: null, assigneeId: l.manager_id ?? null, ruleId: `licence:${l.id}:${dueOn}`, priority: 'high', createdBy: null });
        cur.add(t.cursor); tasks++; taskId = t.id;
      }
      if (sent || taskId) {
        await tx.query('UPDATE licence SET alerts_sent = COALESCE($2, alerts_sent), renewal_task_id = COALESCE($3, renewal_task_id), updated_at = now() WHERE id = $1', [l.id, sent, taskId]);
        await this.audit.record(tx, tenantId, { actorId: null, deviceId: 'server', action: 'licence.expiry_alert', entity: 'licence', entityId: l.id, diff: { threshold: due[0] ?? null, renewalTaskId: taskId } });
      }
    }
    return { alerts, tasks, cursor: cur.v };
  }
}

