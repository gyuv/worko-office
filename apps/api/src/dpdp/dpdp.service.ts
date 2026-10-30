import { BadRequestException, ConflictException, ForbiddenException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import {
  breachReportDue, canTransitionDpdp, DATA_INVENTORY, DEFAULT_DPDP_SETTINGS, dpdpDueDate, dpdpSettingsSchema, dpdpSlaState, effectiveRetention, ERASED_MARKER,
  planErasure, retentionCutoff, validateRetentionOverride, type DpdpRequestKind, type DpdpRequestStatus, type DpdpSettings, type ErasureStep, type PrincipalType, type RetentionKey,
} from '@worko/domain';
import { AuditService } from '../audit/audit.service.js';
import type { PortalActor, RequestActor } from '../auth/context.js';
import { randomToken, sha256 } from '../auth/crypto.js';
import { Clock } from '../common/clock.js';
import { KeyService } from '../crypto/key.service.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { loadAccess, portalWriter } from '../portal/common.js';
import { requireFirmWide } from '../practice/common.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { SyncService } from '../sync/sync.service.js';

type Settings = { settings: DpdpSettings; retention: Partial<Record<RetentionKey, { days: number }>> };
const PRINCIPAL_TABLE: Record<PrincipalType, string> = { client: 'client', contact: 'contact', lead: 'lead', portal_user: 'portal_user', staff: 'app_user' };
const SYNCED = new Set(['client', 'contact']);
const reqSql = `SELECT r.id, r.kind, r.principal_type AS "principalType", r.principal_id AS "principalId", r.source, r.status, to_char(r.received_on,'YYYY-MM-DD') AS "receivedOn",
  to_char(r.due_on,'YYYY-MM-DD') AS "dueOn", r.assigned_to AS "assignedTo", r.outcome, r.closed_at AS "closedAt", r.created_at AS "createdAt", r.details_enc, r.resolution_enc FROM dpdp_request r`;
const breachSql = `SELECT id, title, severity, occurred_at AS "occurredAt", aware_at AS "awareAt", report_due_at AS "reportDueAt", affected_count AS "affectedCount",
  data_categories AS "dataCategories", status, board_notified_at AS "boardNotifiedAt", principals_notified_at AS "principalsNotifiedAt", principals_notified_count AS "principalsNotifiedCount",
  created_at AS "createdAt", description_enc FROM dpdp_breach`;
/** Purge targets: SQL per purgeable retention key (count + apply), all scoped by RLS to the tenant. */
const PURGE: Partial<Record<RetentionKey, { count: string; apply: string }>> = {
  otp: { count: `SELECT (SELECT count(*) FROM otp_challenge WHERE expires_at < $1) + (SELECT count(*) FROM portal_otp WHERE expires_at < $1) AS n`,
    apply: `WITH a AS (DELETE FROM otp_challenge WHERE expires_at < $1 RETURNING 1), b AS (DELETE FROM portal_otp WHERE expires_at < $1 RETURNING 1) SELECT (SELECT count(*) FROM a) + (SELECT count(*) FROM b) AS n` },
  privacy_exports: { count: `SELECT count(*) AS n FROM dpdp_export WHERE expires_at < $1`, apply: `WITH d AS (DELETE FROM dpdp_export WHERE expires_at < $1 RETURNING token_hash) SELECT count(*) AS n, array_agg(token_hash) AS hashes FROM d` },
  leads: { count: `SELECT count(*) AS n FROM lead WHERE stage = 'lost' AND stage_changed_at < $1 AND name <> '${ERASED_MARKER}'`,
    apply: `WITH u AS (UPDATE lead SET name = '${ERASED_MARKER}', company = NULL, email = NULL, phone = NULL, pan = NULL, notes = NULL WHERE stage = 'lost' AND stage_changed_at < $1 AND name <> '${ERASED_MARKER}' RETURNING 1) SELECT count(*) AS n FROM u` },
  communications: { count: `SELECT count(*) AS n FROM comm_message WHERE created_at < $1 AND body <> '${ERASED_MARKER}'`,
    apply: `WITH u AS (UPDATE comm_message SET body = '${ERASED_MARKER}', subject = NULL, address = NULL WHERE created_at < $1 AND body <> '${ERASED_MARKER}' RETURNING 1) SELECT count(*) AS n FROM u` },
};

/**
 * DPDP tooling (M22): inventory, consent registry, data-principal requests with SLA, export bundles behind expiring links,
 * erasure that respects retention holds, breach register, retention + purge (dry-run first). Tooling only — no legal advice;
 * periods are sample data (// VERIFY AGAINST OFFICIAL DOCS). Audit diffs carry ids/counts/field names, never personal data.
 */
@Injectable()
export class DpdpService {
  constructor(private db: DbService, private audit: AuditService, private keys: KeyService, private clock: Clock, private sync: SyncService, private realtime: RealtimeService) {}

  private async load(tx: Tx): Promise<Settings> {
    const r = (await tx.query('SELECT settings, retention FROM dpdp_settings WHERE tenant_id = current_tenant()')).rows[0];
    return { settings: dpdpSettingsSchema.parse({ ...DEFAULT_DPDP_SETTINGS, ...(r?.settings ?? {}) }), retention: r?.retention ?? {} };
  }

  getSettings(a: RequestActor) { return this.db.tenantTx(a.tenantId, (tx) => this.load(tx).then((s) => ({ ...s, effectiveRetention: effectiveRetention(s.retention) }))); }

  async putSettings(a: RequestActor, b: { settings?: unknown; retention?: Partial<Record<RetentionKey, { days: number }>> }) {
    requireFirmWide(a, 'settings', 'edit');
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const cur = await this.load(tx);
      let s = cur.settings;
      if (b.settings !== undefined) {
        const p = dpdpSettingsSchema.safeParse(b.settings);
        if (!p.success) throw new BadRequestException({ message: 'Invalid settings', issues: p.error.issues });
        s = p.data;
      }
      const retention = { ...cur.retention, ...(b.retention ?? {}) };
      for (const [k, v] of Object.entries(b.retention ?? {})) { const err = validateRetentionOverride(k as RetentionKey, v!.days); if (err) throw new BadRequestException(err); }
      await tx.query(`INSERT INTO dpdp_settings (tenant_id, settings, retention, updated_by) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id) DO UPDATE SET settings = $2, retention = $3, updated_by = $4, updated_at = now()`,
        [a.tenantId, JSON.stringify(s), JSON.stringify(retention), a.userId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'dpdp.settings_updated', entity: 'dpdp_settings', entityId: null, diff: { slaDays: s.slaDays, breachReportHours: s.breachReportHours, retention } });
      return { settings: s, retention, effectiveRetention: effectiveRetention(retention) };
    });
  }

  inventory(a: RequestActor) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const s = await this.load(tx);
      return { inventory: DATA_INVENTORY.map((e) => ({ ...e, exportable: undefined })), retention: effectiveRetention(s.retention) };
    });
  }

  /** Consent registry: messaging consents (staff-recorded and from the portal), addresses masked. */
  consents(a: RequestActor, q: { clientId?: string; limit: number }) {
    return this.db.tenantTx(a.tenantId, async (tx) => (await tx.query(
      `SELECT c.id, c.channel, regexp_replace(c.address, '.(?=.{4})', '•', 'g') AS "addressMasked", c.client_id AS "clientId", cl.name AS "clientName", c.status,
              c.opted_in_at AS "optedInAt", c.opted_in_source AS "optedInSource", c.opted_out_at AS "optedOutAt", c.opted_out_source AS "optedOutSource", c.updated_at AS "updatedAt"
       FROM comm_consent c LEFT JOIN client cl ON cl.id = c.client_id WHERE ($1::uuid IS NULL OR c.client_id = $1) ORDER BY c.updated_at DESC LIMIT $2`, [q.clientId ?? null, q.limit])).rows);
  }

  // ---------------- requests ----------------

  private async principalExists(tx: Tx, type: PrincipalType, id: string) {
    const t = PRINCIPAL_TABLE[type];
    const extra = type === 'staff' ? ` AND kind IN ('staff','freelancer')` : '';
    return !!(await tx.query(`SELECT 1 FROM ${t} WHERE id = $1${extra}`, [id])).rowCount;
  }

  private async out(tx: Tx, tenantId: string, r: Record<string, unknown>, today: string) {
    const { details_enc: d, resolution_enc: res, ...rest } = r;
    return { ...rest, details: d ? await this.keys.decrypt(tx, tenantId, d as Buffer, `dpdp_request:${r.id}:details`) : null,
      resolution: res ? await this.keys.decrypt(tx, tenantId, res as Buffer, `dpdp_request:${r.id}:resolution`) : null,
      sla: dpdpSlaState(r.dueOn as string, today, ['completed', 'partially_completed', 'rejected'].includes(r.status as string)) };
  }

  listRequests(a: RequestActor, q: { status?: string; overdue?: boolean }) {
    const today = this.clock.todayIst();
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const rows = (await tx.query(`${reqSql} WHERE ($1::text IS NULL OR r.status = $1) ORDER BY r.due_on, r.created_at LIMIT 500`, [q.status ?? null])).rows;
      const out = await Promise.all(rows.map((r) => this.out(tx, a.tenantId, r, today)));
      return q.overdue ? out.filter((r) => r.sla === 'overdue') : out;
    });
  }

  private async insertRequest(tx: Tx, tenantId: string, i: { kind: DpdpRequestKind; principalType: PrincipalType; principalId: string; source: 'staff' | 'portal'; portalUserId?: string; details?: string; createdBy: string | null; deviceId: string }) {
    const s = await this.load(tx);
    const id = uuidv7(); const today = this.clock.todayIst();
    await tx.query(`INSERT INTO dpdp_request (id, tenant_id, kind, principal_type, principal_id, source, portal_user_id, details_enc, received_on, due_on, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, tenantId, i.kind, i.principalType, i.principalId, i.source, i.portalUserId ?? null, i.details ? await this.keys.encrypt(tx, tenantId, i.details, `dpdp_request:${id}:details`) : null,
        today, dpdpDueDate(today, i.kind, s.settings), i.createdBy]);
    await this.audit.record(tx, tenantId, { actorId: i.createdBy, deviceId: i.deviceId, action: 'dpdp.request_received', entity: 'dpdp_request', entityId: id,
      diff: { kind: i.kind, principalType: i.principalType, principalId: i.principalId, source: i.source } });
    return id;
  }

  async createRequest(a: RequestActor, b: { kind: DpdpRequestKind; principalType: PrincipalType; principalId: string; details?: string }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      if (!(await this.principalExists(tx, b.principalType, b.principalId))) throw new BadRequestException('Unknown data principal');
      const id = await this.insertRequest(tx, a.tenantId, { ...b, source: 'staff', createdBy: a.userId, deviceId: a.deviceId });
      return this.out(tx, a.tenantId, (await tx.query(`${reqSql} WHERE r.id = $1`, [id])).rows[0], this.clock.todayIst());
    });
  }

  /** Portal intake: about the portal user themself, or a client they have live access to. */
  async portalCreate(p: PortalActor, b: { kind: DpdpRequestKind; clientId?: string; details?: string }) {
    return this.db.tenantTx(p.tenantId, async (tx) => {
      const principal = b.clientId ? { principalType: 'client' as const, principalId: (await loadAccess(tx, p, b.clientId)).clientId } : { principalType: 'portal_user' as const, principalId: p.portalUserId };
      const w = portalWriter(p);
      const id = await this.insertRequest(tx, p.tenantId, { kind: b.kind, ...principal, source: 'portal', portalUserId: p.portalUserId, details: b.details, createdBy: null, deviceId: w.deviceId });
      return { id, status: 'received', dueOn: (await tx.query(`SELECT to_char(due_on,'YYYY-MM-DD') AS d FROM dpdp_request WHERE id = $1`, [id])).rows[0].d };
    });
  }

  portalList(p: PortalActor) {
    return this.db.tenantTx(p.tenantId, async (tx) => (await tx.query(`SELECT id, kind, status, to_char(received_on,'YYYY-MM-DD') AS "receivedOn", to_char(due_on,'YYYY-MM-DD') AS "dueOn", closed_at AS "closedAt"
      FROM dpdp_request WHERE portal_user_id = $1 ORDER BY created_at DESC LIMIT 100`, [p.portalUserId])).rows);
  }

  private async lockRequest(tx: Tx, id: string) {
    const r = (await tx.query(`SELECT * FROM dpdp_request WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!r) throw new NotFoundException();
    return r;
  }

  async updateRequest(a: RequestActor, id: string, b: { status?: DpdpRequestStatus; assignedTo?: string | null; resolution?: string }) {
    requireFirmWide(a, 'settings', 'edit');
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const r = await this.lockRequest(tx, id);
      if (b.status && b.status !== r.status && !canTransitionDpdp(r.status, b.status)) throw new BadRequestException(`Cannot move a ${r.status} request to ${b.status}`);
      if (b.status && b.status !== 'rejected' && r.kind === 'erasure' && ['completed', 'partially_completed'].includes(b.status) && !r.outcome?.erasure) throw new BadRequestException('Run the erasure first');
      await tx.query(`UPDATE dpdp_request SET status = COALESCE($2, status), assigned_to = CASE WHEN $3 THEN $4::uuid ELSE assigned_to END, resolution_enc = COALESCE($5, resolution_enc),
          closed_at = CASE WHEN $2 IN ('completed','partially_completed','rejected') THEN now() ELSE closed_at END WHERE id = $1`,
        [id, b.status ?? null, b.assignedTo !== undefined, b.assignedTo ?? null, b.resolution ? await this.keys.encrypt(tx, a.tenantId, b.resolution, `dpdp_request:${id}:resolution`) : null]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'dpdp.request_updated', entity: 'dpdp_request', entityId: id, diff: { status: b.status, assignedTo: b.assignedTo, resolution: b.resolution ? '[set]' : undefined } });
      return this.out(tx, a.tenantId, (await tx.query(`${reqSql} WHERE r.id = $1`, [id])).rows[0], this.clock.todayIst());
    });
  }

  // ---------------- export (access requests) ----------------

  /** Everything the inventory lists for ONE principal (exportable columns only; documents as a list, not files). */
  private async bundle(tx: Tx, type: PrincipalType, id: string) {
    const out: Record<string, unknown> = { principalType: type, principalId: id, generatedAt: new Date().toISOString(), note: 'Personal data held by the firm about you (DPDP access request).' };
    for (const e of DATA_INVENTORY.filter((x) => x.principal === type)) {
      const cols = e.exportable.map((c) => `"${c}"`).join(', ');
      const extra = e.table === 'app_user' ? ` AND kind IN ('staff','freelancer')` : '';
      const deleted = ['client', 'contact', 'document', 'comm_message', 'invoice', 'receipt', 'lead'].includes(e.table) ? ' AND deleted_at IS NULL' : '';
      out[e.table] = (await tx.query(`SELECT ${cols} FROM ${e.table} WHERE ${e.key} = $1${extra}${deleted} ORDER BY 1 LIMIT 5000`, [id])).rows;
    }
    if (type === 'client') out.contacts = (await tx.query(`SELECT name, role, email, phone FROM contact WHERE client_id = $1 AND deleted_at IS NULL`, [id])).rows;
    if (type === 'portal_user') out.portalAccess = (await tx.query(`SELECT c.name AS client FROM portal_access a JOIN client c ON c.id = a.client_id WHERE a.portal_user_id = $1 AND a.revoked_at IS NULL`, [id])).rows;
    if (type === 'contact') out.messages = (await tx.query(`SELECT channel, direction, subject, body, occurred_at FROM comm_message WHERE contact_id = $1 AND deleted_at IS NULL ORDER BY occurred_at LIMIT 5000`, [id])).rows;
    return out;
  }

  async export(a: RequestActor, id: string) {
    requireFirmWide(a, 'settings', 'export');
    const r = await this.db.tenantTx(a.tenantId, async (tx) => {
      const req = await this.lockRequest(tx, id);
      if (req.kind !== 'access') throw new BadRequestException('Exports are for access requests');
      if (['completed', 'partially_completed', 'rejected'].includes(req.status)) throw new BadRequestException(`Request is ${req.status}`);
      const s = await this.load(tx);
      const body = JSON.stringify(await this.bundle(tx, req.principal_type, req.principal_id), null, 2);
      const token = randomToken(); const exportId = uuidv7(); const hash = sha256(token);
      const expiresAt = new Date(this.clock.now().getTime() + s.settings.exportLinkDays * 86_400_000);
      await tx.query(`INSERT INTO dpdp_export (id, tenant_id, request_id, token_hash, body_enc, expires_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [exportId, a.tenantId, id, hash, await this.keys.encrypt(tx, a.tenantId, body, `dpdp_export:${exportId}:body`), expiresAt, a.userId]);
      await tx.query(`UPDATE dpdp_request SET status = CASE WHEN status = 'received' THEN 'in_progress' ELSE status END, outcome = outcome || $2 WHERE id = $1`, [id, JSON.stringify({ exportId, exportBytes: body.length })]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'dpdp.export_created', entity: 'dpdp_export', entityId: exportId, diff: { requestId: id, bytes: body.length, expiresAt } });
      return { token, hash, exportId, expiresAt };
    });
    await this.db.systemTx((tx) => tx.query('INSERT INTO dpdp_export_index (token_hash, tenant_id) VALUES ($1,$2)', [r.hash, a.tenantId]));
    return { exportId: r.exportId, expiresAt: r.expiresAt.toISOString(), path: `/v1/privacy/exports/${r.token}`, token: r.token };
  }

  /** Signed (random, hashed) expiring link; the bundle is decrypted only here. */
  async download(token: string) {
    const hash = sha256(token);
    const idx = (await this.db.systemTx((tx) => tx.query('SELECT tenant_id FROM dpdp_export_index WHERE token_hash = $1', [hash]))).rows[0];
    if (!idx) throw new NotFoundException();
    return this.db.tenantTx(idx.tenant_id, async (tx) => {
      const e = (await tx.query('SELECT id, body_enc, expires_at, request_id FROM dpdp_export WHERE token_hash = $1', [hash])).rows[0];
      if (!e) throw new NotFoundException();
      if (e.expires_at <= this.clock.now()) throw new GoneException('This link has expired');
      await tx.query('UPDATE dpdp_export SET downloads = downloads + 1 WHERE id = $1', [e.id]);
      await this.audit.record(tx, idx.tenant_id, { actorId: null, deviceId: 'privacy-link', action: 'dpdp.export_downloaded', entity: 'dpdp_export', entityId: e.id, diff: { requestId: e.request_id } });
      return this.keys.decrypt(tx, idx.tenant_id, e.body_enc, `dpdp_export:${e.id}:body`);
    });
  }

  // ---------------- erasure ----------------

  private async erasureFacts(tx: Tx, type: PrincipalType, id: string, today: string) {
    const last = type === 'client' ? (await tx.query(`SELECT to_char(greatest((SELECT max(issue_date) FROM invoice WHERE client_id = $1 AND deleted_at IS NULL),
        (SELECT max(received_on) FROM receipt WHERE client_id = $1 AND deleted_at IS NULL)), 'YYYY-MM-DD') AS d`, [id])).rows[0].d as string | null : null;
    const active = type === 'staff' ? !!(await tx.query(`SELECT 1 FROM app_user WHERE id = $1 AND status = 'active'`, [id])).rowCount : false;
    return { lastAccountingDate: last, today, isActiveStaff: active };
  }

  private valueFor(table: string, field: string, mode: 'null' | 'marker' | 'shred', rowId: string): unknown {
    if (field === 'addresses') return [];
    if ((table === 'portal_user' || table === 'app_user') && field === 'email') return `erased-${rowId}@erased.invalid`;
    return mode === 'marker' ? ERASED_MARKER : null;
  }

  private async applyStep(tx: Tx, a: RequestActor, type: PrincipalType, id: string, step: ErasureStep): Promise<number> {
    const entry = DATA_INVENTORY.find((e) => e.table === step.table && e.principal === type)!;
    const ids = (await tx.query(`SELECT id FROM ${step.table} WHERE ${entry.key} = $1`, [id])).rows.map((r) => r.id as string);
    for (const rowId of ids) {
      const patch: Record<string, unknown> = {};
      for (const f of step.fields) patch[f.name] = this.valueFor(step.table, f.name, f.erase, rowId);
      if (SYNCED.has(step.table)) {
        // Synced columns through serverPatch (field versions); crypto-shredded columns (not synced) directly.
        const shred = Object.keys(patch).filter((k) => k.endsWith('_enc'));
        const synced = Object.fromEntries(Object.entries(patch).filter(([k]) => !k.endsWith('_enc')));
        if (Object.keys(synced).length) await this.sync.serverPatch(tx, a, step.table, rowId, synced);
        if (shred.length) await tx.query(`UPDATE ${step.table} SET ${shred.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [rowId, ...shred.map(() => null)]);
      } else {
        const keys = Object.keys(patch);
        await tx.query(`UPDATE ${step.table} SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}${step.table === 'portal_user' ? `, status = 'disabled'` : ''} WHERE id = $1`,
          [rowId, ...keys.map((k) => (Array.isArray(patch[k]) ? JSON.stringify(patch[k]) : patch[k]))]);
      }
    }
    if (step.table === 'portal_user') await tx.query(`UPDATE portal_session SET revoked_at = now() WHERE portal_user_id = $1 AND revoked_at IS NULL`, [id]);
    return ids.length;
  }

  /** Erasure = anonymisation / crypto-shredding of inventory PII fields; legal holds keep what the law requires (partial or blocked, with reasons). */
  async erase(a: RequestActor, id: string, b: { dryRun?: boolean }) {
    requireFirmWide(a, 'settings', 'approve');
    const today = this.clock.todayIst();
    const r = await this.db.tenantTx(a.tenantId, async (tx) => {
      const req = await this.lockRequest(tx, id);
      if (req.kind !== 'erasure') throw new BadRequestException('Not an erasure request');
      if (['completed', 'partially_completed', 'rejected'].includes(req.status)) throw new BadRequestException(`Request is ${req.status}`);
      if (req.principal_type === 'staff' && req.principal_id === a.userId) throw new ForbiddenException('You cannot erase your own account');
      const s = await this.load(tx);
      const plan = planErasure(req.principal_type, await this.erasureFacts(tx, req.principal_type, req.principal_id, today), effectiveRetention(s.retention));
      const summary = plan.steps.map((st) => ({ table: st.table, action: st.action, reason: st.reason, fields: st.fields.map((f) => f.name) }));
      if (b.dryRun) return { dryRun: true, outcome: plan.outcome, steps: summary, cursor: 0 };
      const rows: Record<string, number> = {};
      for (const st of plan.steps.filter((x) => x.action === 'anonymise')) rows[st.table] = await this.applyStep(tx, a, req.principal_type, req.principal_id, st);
      const status = plan.outcome === 'full' ? 'completed' : plan.outcome === 'partial' ? 'partially_completed' : 'rejected';
      const outcome = { erasure: { outcome: plan.outcome, at: new Date().toISOString(), rows, steps: summary } };
      await tx.query(`UPDATE dpdp_request SET status = $2, outcome = outcome || $3, closed_at = now() WHERE id = $1`, [id, status, JSON.stringify(outcome)]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'dpdp.erasure_executed', entity: 'dpdp_request', entityId: id,
        diff: { principalType: req.principal_type, principalId: req.principal_id, outcome: plan.outcome, rows, retained: summary.filter((x) => x.action === 'retain').map((x) => `${x.table}:${x.reason}`) } });
      const table = PRINCIPAL_TABLE[req.principal_type as PrincipalType];
      const cursor = SYNCED.has(table) ? Number((await tx.query(`SELECT COALESCE(max(sync_cursor),0) AS c FROM ${table} WHERE id = $1`, [req.principal_id])).rows[0]?.c ?? 0) : 0;
      return { dryRun: false, outcome: plan.outcome, status, rows, steps: summary, cursor };
    });
    if (r.cursor) this.realtime.publish({ type: 'changed', tenantId: a.tenantId, cursor: r.cursor });
    const { cursor: _c, ...out } = r;
    return out;
  }

  // ---------------- breaches ----------------

  private async breachOut(tx: Tx, tenantId: string, r: Record<string, unknown>) {
    const { description_enc: d, ...rest } = r;
    return { ...rest, description: d ? await this.keys.decrypt(tx, tenantId, d as Buffer, `dpdp_breach:${r.id}:description`) : null };
  }

  listBreaches(a: RequestActor) {
    return this.db.tenantTx(a.tenantId, async (tx) => Promise.all((await tx.query(`${breachSql} ORDER BY aware_at DESC LIMIT 200`)).rows.map((r) => this.breachOut(tx, a.tenantId, r))));
  }

  async createBreach(a: RequestActor, b: { title: string; description?: string; severity: string; occurredAt?: string; awareAt: string; affectedCount: number; dataCategories: string[] }) {
    requireFirmWide(a, 'settings', 'edit');
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const s = await this.load(tx);
      const id = uuidv7(); const aware = new Date(b.awareAt);
      await tx.query(`INSERT INTO dpdp_breach (id, tenant_id, title, description_enc, severity, occurred_at, aware_at, report_due_at, affected_count, data_categories, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, a.tenantId, b.title, b.description ? await this.keys.encrypt(tx, a.tenantId, b.description, `dpdp_breach:${id}:description`) : null, b.severity, b.occurredAt ?? null, aware,
          breachReportDue(aware, s.settings), b.affectedCount, b.dataCategories, a.userId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'dpdp.breach_recorded', entity: 'dpdp_breach', entityId: id, diff: { severity: b.severity, affectedCount: b.affectedCount, dataCategories: b.dataCategories } });
      return this.breachOut(tx, a.tenantId, (await tx.query(`${breachSql} WHERE id = $1`, [id])).rows[0]);
    });
  }

  async updateBreach(a: RequestActor, id: string, b: { status?: string; affectedCount?: number; boardNotifiedAt?: string | null; principalsNotifiedAt?: string | null; principalsNotifiedCount?: number }) {
    requireFirmWide(a, 'settings', 'edit');
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const r = await tx.query(`UPDATE dpdp_breach SET status = COALESCE($2, status), affected_count = COALESCE($3, affected_count),
          board_notified_at = CASE WHEN $4 THEN $5::timestamptz ELSE board_notified_at END, principals_notified_at = CASE WHEN $6 THEN $7::timestamptz ELSE principals_notified_at END,
          principals_notified_count = COALESCE($8, principals_notified_count) WHERE id = $1`,
        [id, b.status ?? null, b.affectedCount ?? null, b.boardNotifiedAt !== undefined, b.boardNotifiedAt ?? null, b.principalsNotifiedAt !== undefined, b.principalsNotifiedAt ?? null, b.principalsNotifiedCount ?? null]);
      if (!r.rowCount) throw new NotFoundException();
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'dpdp.breach_updated', entity: 'dpdp_breach', entityId: id, diff: b });
      return this.breachOut(tx, a.tenantId, (await tx.query(`${breachSql} WHERE id = $1`, [id])).rows[0]);
    });
  }

  // ---------------- retention purge ----------------

  /** Dry-run: counts in a READ ONLY transaction (cannot change data). Real run: needs a dry-run in the last 24 h (D188). */
  async purge(a: RequestActor, b: { dryRun: boolean }) {
    requireFirmWide(a, 'settings', 'approve');
    const today = this.clock.todayIst();
    const rules = await this.db.tenantTx(a.tenantId, (tx) => this.load(tx)).then((s) => effectiveRetention(s.retention));
    const targets = (Object.keys(PURGE) as RetentionKey[]).filter((k) => rules[k].purgeable);
    const cut = (k: RetentionKey) => `${retentionCutoff(today, rules[k].days)}T00:00:00+05:30`;
    if (b.dryRun) {
      const counts = await this.db.readOnlyTx(a.tenantId, async (tx) => {
        const c: Record<string, number> = {};
        for (const k of targets) c[k] = Number((await tx.query(PURGE[k]!.count, [cut(k)])).rows[0].n);
        return c;
      });
      await this.db.tenantTx(a.tenantId, async (tx) => {
        const id = uuidv7();
        await tx.query(`INSERT INTO dpdp_purge_run (id, tenant_id, dry_run, as_of, counts, run_by) VALUES ($1,$2,true,$3,$4,$5)`, [id, a.tenantId, today, JSON.stringify(counts), a.userId]);
        await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'dpdp.purge_dry_run', entity: 'dpdp_purge_run', entityId: id, diff: { counts } });
      });
      return { dryRun: true, asOf: today, counts, cutoffs: Object.fromEntries(targets.map((k) => [k, retentionCutoff(today, rules[k].days)])) };
    }
    const r = await this.db.tenantTx(a.tenantId, async (tx) => {
      if (!(await tx.query(`SELECT 1 FROM dpdp_purge_run WHERE dry_run AND created_at > now() - interval '24 hours'`)).rowCount) throw new ConflictException({ code: 'dry_run_required', message: 'Run a dry-run first (within the last 24 hours)' });
      const counts: Record<string, number> = {}; let hashes: string[] = [];
      for (const k of targets) {
        const row = (await tx.query(PURGE[k]!.apply, [cut(k)])).rows[0];
        counts[k] = Number(row.n);
        if (row.hashes) hashes = row.hashes.filter(Boolean);
      }
      const id = uuidv7();
      await tx.query(`INSERT INTO dpdp_purge_run (id, tenant_id, dry_run, as_of, counts, run_by) VALUES ($1,$2,false,$3,$4,$5)`, [id, a.tenantId, today, JSON.stringify(counts), a.userId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'dpdp.purge_run', entity: 'dpdp_purge_run', entityId: id, diff: { counts } });
      return { counts, hashes };
    });
    if (r.hashes.length) await this.db.systemTx((tx) => tx.query('DELETE FROM dpdp_export_index WHERE token_hash = ANY($1)', [r.hashes]));
    return { dryRun: false, asOf: today, counts: r.counts };
  }

  purgeRuns(a: RequestActor) {
    return this.db.tenantTx(a.tenantId, async (tx) => (await tx.query(`SELECT id, dry_run AS "dryRun", to_char(as_of,'YYYY-MM-DD') AS "asOf", counts, run_by AS "runBy", created_at AS "createdAt" FROM dpdp_purge_run ORDER BY created_at DESC LIMIT 50`)).rows);
  }
}
