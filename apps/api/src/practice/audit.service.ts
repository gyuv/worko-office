import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { can, clientCtx, effectiveScope, invalidatedByEvidence, normalizeAddress, signoffError, type SignoffLevel } from '@worko/domain';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { visibilityOf } from '../clients/scope.js';
import { Clock } from '../common/clock.js';
import { CommService } from '../comm/comm.service.js';
import { addressFor } from '../comm/common.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { clientFor, createLinkedTask, Cursor, loadPracticeSettings, Params, requireFirmWide, staffUser, visibleSql, ymd } from './common.js';
import { udinPortalUrl } from './udin-gate.js';

export type ProgrammeSection = { key: string; title: string; procedures: Array<{ key: string; title: string; evidence: string[] }> };
type EngagementIn = { clientId: string; fy: string; auditType: string; programmeId?: string | null; partnerId?: string | null; managerId?: string | null; taskId?: string | null;
  createTask?: boolean; udinRequired?: boolean; reportDue?: string | null };
type UdinIn = { clientId: string; engagementId?: string | null; taskId?: string | null; udin: string; documentType: string; generatedOn: string; membershipNo: string;
  signingPartnerId?: string | null; documentId?: string | null };

const engOut = (r: Record<string, unknown>) => ({
  id: r.id, clientId: r.client_id, clientName: r.client_name ?? null, fy: r.fy, auditType: r.audit_type, programmeId: r.programme_id, partnerId: r.partner_id, managerId: r.manager_id,
  taskId: r.task_id, status: r.status, udinRequired: r.udin_required, udinRecorded: r.udin_recorded ?? null, version: r.version, createdAt: r.created_at,
});
const procOut = (r: Record<string, unknown>) => ({
  id: r.id, sectionKey: r.section_key, sectionTitle: r.section_title, key: r.key, title: r.title, requiredEvidence: r.required_evidence, notApplicable: r.not_applicable,
  conclusion: r.conclusion, preparedBy: r.prepared_by, preparedAt: r.prepared_at, reviewedBy: r.reviewed_by, reviewedAt: r.reviewed_at, partnerBy: r.partner_by, partnerAt: r.partner_at,
  workpapers: Number(r.workpapers ?? 0),
});
const pbcOut = (r: Record<string, unknown>) => ({
  id: r.id, engagementId: r.engagement_id, title: r.title, description: r.description, dueDate: ymd(r.due_date), status: r.status, documentIds: r.document_ids,
  rejectionReason: r.rejection_reason, reminderCount: r.reminder_count, lastRemindedOn: ymd(r.last_reminded_on),
});
const udinOut = (r: Record<string, unknown>) => ({
  id: r.id, clientId: r.client_id, engagementId: r.engagement_id, taskId: r.task_id, udin: r.udin, documentType: r.document_type, generatedOn: ymd(r.generated_on),
  membershipNo: r.membership_no, signingPartnerId: r.signing_partner_id, documentId: r.document_id, revokedAt: r.revoked_at, revokeReason: r.revoke_reason, createdAt: r.created_at,
});

@Injectable()
export class AuditWorkService {
  constructor(private db: DbService, private audit: AuditService, private realtime: RealtimeService, private clock: Clock, private comm: CommService) {}

  private rec(tx: Tx, a: RequestActor, action: string, entity: string, entityId: string | null, diff?: unknown) {
    return this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action, entity, entityId, diff });
  }
  private publish(tenantId: string, c: Cursor) { if (c.v) this.realtime.publish({ type: 'changed', tenantId, cursor: c.v }); }

  // ---------- Programmes (firm templates) ----------
  programmes(a: RequestActor) {
    return this.db.tenantTx(a.tenantId, async (tx) => (await tx.query('SELECT * FROM audit_programme ORDER BY active DESC, name')).rows.map((r) => ({
      id: r.id, name: r.name, auditType: r.audit_type, sections: r.sections, udinRequired: r.udin_required, active: r.active, version: r.version })));
  }
  async createProgramme(a: RequestActor, b: { name: string; auditType: string; sections: ProgrammeSection[]; udinRequired?: boolean }) {
    requireFirmWide(a, 'audit', 'create');
    checkSections(b.sections);
    const id = uuidv7();
    await this.db.tenantTx(a.tenantId, async (tx) => {
      await tx.query('INSERT INTO audit_programme (id, tenant_id, name, audit_type, sections, udin_required, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [id, a.tenantId, b.name, b.auditType, JSON.stringify(b.sections), b.udinRequired ?? true, a.userId]);
      await this.rec(tx, a, 'audit_programme.created', 'audit_programme', id, { name: b.name, auditType: b.auditType, procedures: b.sections.reduce((n, s) => n + s.procedures.length, 0) });
    });
    return { id };
  }
  async updateProgramme(a: RequestActor, id: string, b: { name?: string; sections?: ProgrammeSection[]; active?: boolean; udinRequired?: boolean }) {
    requireFirmWide(a, 'audit', 'edit');
    if (b.sections) checkSections(b.sections);
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const r = await tx.query(`UPDATE audit_programme SET name = COALESCE($2, name), sections = COALESCE($3, sections), active = COALESCE($4, active), udin_required = COALESCE($5, udin_required),
        version = version + 1, updated_at = now() WHERE id = $1`, [id, b.name ?? null, b.sections ? JSON.stringify(b.sections) : null, b.active ?? null, b.udinRequired ?? null]);
      if (!r.rowCount) throw new NotFoundException();
      await this.rec(tx, a, 'audit_programme.updated', 'audit_programme', id, { name: b.name, active: b.active, sections: b.sections ? b.sections.length : undefined });
    });
  }

  // ---------- Engagements ----------
  private async loadEng(tx: Tx, a: RequestActor, id: string, action: 'view' | 'edit' | 'create' = 'view') {
    const e = (await tx.query('SELECT e.*, c.name AS client_name FROM audit_engagement e JOIN client c ON c.id = e.client_id WHERE e.id = $1 AND e.deleted_at IS NULL', [id])).rows[0];
    if (!e) throw new NotFoundException();
    const c = await clientFor(tx, a, e.client_id, 'audit', action);
    return { e, c };
  }

  listEngagements(a: RequestActor, q: { clientId?: string; fy?: string; status?: string; limit: number; offset: number }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params(); const where = ['e.deleted_at IS NULL', 'c.deleted_at IS NULL', visibleSql(a, 'audit', p)];
      if (q.clientId) where.push(`e.client_id = ${p.add(q.clientId)}`);
      if (q.fy) where.push(`e.fy = ${p.add(q.fy)}`);
      if (q.status) where.push(`e.status = ${p.add(q.status)}`);
      const rows = (await tx.query(`SELECT e.*, c.name AS client_name, EXISTS (SELECT 1 FROM udin_record u WHERE u.engagement_id = e.id AND u.revoked_at IS NULL) AS udin_recorded,
        count(*) OVER () AS total FROM audit_engagement e JOIN client c ON c.id = e.client_id WHERE ${where.join(' AND ')} ORDER BY e.fy DESC, c.name LIMIT ${p.add(q.limit)} OFFSET ${p.add(q.offset)}`, p.values)).rows;
      return { total: Number(rows[0]?.total ?? 0), items: rows.map(engOut) };
    });
  }

  async createEngagement(a: RequestActor, b: EngagementIn) {
    const cur = new Cursor();
    const id = await this.db.tenantTx(a.tenantId, async (tx) => {
      const c = await clientFor(tx, a, b.clientId, 'audit', 'create');
      await staffUser(tx, b.partnerId, 'partnerId'); await staffUser(tx, b.managerId, 'managerId');
      const prog = b.programmeId ? (await tx.query('SELECT * FROM audit_programme WHERE id = $1 AND active', [b.programmeId])).rows[0] : null;
      if (b.programmeId && !prog) throw new BadRequestException({ message: 'Unknown programme', code: 'invalid:programmeId' });
      if (b.taskId) {
        const t = (await tx.query('SELECT client_id, outcome FROM task WHERE id = $1 AND deleted_at IS NULL', [b.taskId])).rows[0];
        if (!t || t.client_id !== b.clientId || t.outcome) throw new BadRequestException({ message: 'Task must be an open task of this client', code: 'invalid:taskId' });
      }
      const id = uuidv7();
      let taskId = b.taskId ?? null;
      if (!taskId && b.createTask !== false) {
        const t = await createLinkedTask(tx, a.tenantId, { clientId: b.clientId, title: `${b.auditType.replace(/_/g, ' ')} — FY ${b.fy}`, statutoryDue: b.reportDue ?? null, actBy: null,
          assigneeId: b.managerId ?? c.manager_id ?? null, managerId: b.managerId ?? null, ruleId: `audit:${id}`, createdBy: a.userId });
        taskId = t.id; cur.add(t.cursor);
      }
      try {
        await tx.query('SAVEPOINT eng');
        await tx.query(`INSERT INTO audit_engagement (id, tenant_id, client_id, fy, audit_type, programme_id, programme_snapshot, partner_id, manager_id, task_id, udin_required, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [id, a.tenantId, b.clientId, b.fy, b.auditType, prog?.id ?? null, prog ? JSON.stringify(prog.sections) : null,
          b.partnerId ?? c.partner_id ?? null, b.managerId ?? c.manager_id ?? null, taskId, b.udinRequired ?? prog?.udin_required ?? true, a.userId]);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new ConflictException({ message: 'Engagement exists for this client, FY and audit type', code: 'engagement_exists' });
        throw e;
      }
      // Instantiate procedures from the programme snapshot (later programme edits don't touch running engagements).
      let sort = 0;
      for (const s of ((prog?.sections ?? []) as ProgrammeSection[])) for (const pr of s.procedures) {
        await tx.query(`INSERT INTO audit_procedure (id, tenant_id, engagement_id, section_key, section_title, key, title, required_evidence, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [uuidv7(), a.tenantId, id, s.key, s.title, pr.key, pr.title, pr.evidence ?? [], sort++]);
      }
      await this.rec(tx, a, 'audit_engagement.created', 'audit_engagement', id, { clientId: b.clientId, fy: b.fy, auditType: b.auditType, programmeId: prog?.id ?? null, procedures: sort, taskId });
      return id;
    });
    this.publish(a.tenantId, cur);
    return { id };
  }

  getEngagement(a: RequestActor, id: string) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const { e } = await this.loadEng(tx, a, id);
      const procedures = (await tx.query(`SELECT p.*, (SELECT count(*) FROM audit_workpaper w WHERE w.procedure_id = p.id AND w.unlinked_at IS NULL) AS workpapers
        FROM audit_procedure p WHERE p.engagement_id = $1 ORDER BY p.sort, p.key`, [id])).rows.map(procOut);
      const pbc = (await tx.query('SELECT * FROM pbc_item WHERE engagement_id = $1 AND deleted_at IS NULL ORDER BY due_date NULLS LAST, created_at', [id])).rows.map(pbcOut);
      const udins = (await tx.query('SELECT * FROM udin_record WHERE engagement_id = $1 ORDER BY created_at', [id])).rows.map(udinOut);
      const signed = (l: 'prepared_by' | 'reviewed_by' | 'partner_by') => procedures.filter((p) => p.notApplicable || p[l === 'prepared_by' ? 'preparedBy' : l === 'reviewed_by' ? 'reviewedBy' : 'partnerBy']).length;
      return { ...engOut({ ...e, udin_recorded: udins.some((u) => !u.revokedAt) }), procedures, pbc, udins,
        progress: { total: procedures.length, prepared: signed('prepared_by'), reviewed: signed('reviewed_by'), partner: signed('partner_by') }, udinPortalUrl: udinPortalUrl() };
    });
  }

  async updateEngagement(a: RequestActor, id: string, b: { status?: string; partnerId?: string | null; managerId?: string | null }) {
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const { e } = await this.loadEng(tx, a, id, 'edit');
      if (b.partnerId !== undefined) await staffUser(tx, b.partnerId, 'partnerId');
      if (b.managerId !== undefined) await staffUser(tx, b.managerId, 'managerId');
      if (b.status === 'closed' && e.udin_required && !(await tx.query('SELECT 1 FROM udin_record WHERE engagement_id = $1 AND revoked_at IS NULL', [id])).rowCount) {
        throw new BadRequestException({ message: 'Record the UDIN first', code: 'udin_required' });
      }
      await tx.query(`UPDATE audit_engagement SET status = COALESCE($2, status), partner_id = CASE WHEN $3 THEN $4::uuid ELSE partner_id END,
        manager_id = CASE WHEN $5 THEN $6::uuid ELSE manager_id END, version = version + 1, updated_at = now() WHERE id = $1`,
      [id, b.status ?? null, b.partnerId !== undefined, b.partnerId ?? null, b.managerId !== undefined, b.managerId ?? null]);
      await this.rec(tx, a, 'audit_engagement.updated', 'audit_engagement', id, b);
    });
  }

  // ---------- Procedures & sign-offs ----------
  private async loadProc(tx: Tx, a: RequestActor, id: string, action: 'view' | 'edit') {
    const p = (await tx.query('SELECT * FROM audit_procedure WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!p) throw new NotFoundException();
    const { e, c } = await this.loadEng(tx, a, p.engagement_id, action === 'edit' ? 'view' : 'view');
    return { p, e, c };
  }

  private rights(a: RequestActor, e: Record<string, unknown>, c: Record<string, unknown>) {
    const ctx = clientCtx(visibilityOf(c));
    return {
      canPrepare: can(a, 'audit', 'edit', ctx),
      canReview: can(a, 'audit', 'approve', ctx),
      // Partner sign-off: the engagement's partner, or firm-wide audit approvers.
      canPartner: !!a.superAdmin || (e.partner_id === a.userId && can(a, 'audit', 'approve', ctx)) || effectiveScope(a, 'audit', 'approve')?.scope === 'all',
    };
  }

  async updateProcedure(a: RequestActor, id: string, b: { notApplicable?: boolean; conclusion?: string | null }) {
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const { p, e, c } = await this.loadProc(tx, a, id, 'edit');
      if (!this.rights(a, e, c).canPrepare) throw new ForbiddenException();
      if (p.reviewed_by) throw new ConflictException({ message: 'Reviewed procedures are locked; ask the partner to reopen', code: 'procedure_locked' });
      await tx.query('UPDATE audit_procedure SET not_applicable = COALESCE($2, not_applicable), conclusion = CASE WHEN $3 THEN $4 ELSE conclusion END, version = version + 1, updated_at = now() WHERE id = $1',
        [id, b.notApplicable ?? null, b.conclusion !== undefined, b.conclusion ?? null]);
      await this.rec(tx, a, 'audit_procedure.updated', 'audit_procedure', id, { notApplicable: b.notApplicable, conclusion: b.conclusion !== undefined ? '[set]' : undefined });
    });
  }

  async signoff(a: RequestActor, id: string, level: SignoffLevel) {
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const { p, e, c } = await this.loadProc(tx, a, id, 'edit');
      const why = signoffError({ preparedBy: p.prepared_by, reviewedBy: p.reviewed_by, partnerBy: p.partner_by }, level, a.userId, this.rights(a, e, c));
      if (why === 'forbidden') throw new ForbiddenException({ message: 'Not allowed to sign at this level', code: 'forbidden' });
      if (why) throw new BadRequestException({ message: 'Rejected', code: why });
      // Evidence must be current: a workpaper with a newer document version needs re-linking (which invalidates) before signing.
      const stale = (await tx.query(`SELECT 1 FROM audit_workpaper w JOIN document d ON d.id = w.document_id WHERE w.procedure_id = $1 AND w.unlinked_at IS NULL
        AND (d.current_version <> w.document_version OR d.deleted_at IS NOT NULL) LIMIT 1`, [id])).rowCount;
      if (stale) throw new ConflictException({ message: 'A workpaper changed since it was linked; refresh it first', code: 'evidence_changed' });
      const col = level === 'preparer' ? 'prepared' : level === 'reviewer' ? 'reviewed' : 'partner';
      const now = this.clock.now();
      await tx.query(`UPDATE audit_procedure SET ${col === 'partner' ? 'partner_by' : `${col}_by`} = $2, ${col === 'partner' ? 'partner_at' : `${col}_at`} = $3, version = version + 1, updated_at = now() WHERE id = $1`, [id, a.userId, now]);
      await tx.query(`INSERT INTO audit_signoff_event (id, tenant_id, procedure_id, level, action, user_id, at) VALUES ($1,$2,$3,$4,'signed',$5,$6)`, [uuidv7(), a.tenantId, id, level, a.userId, now]);
      await this.rec(tx, a, 'audit_procedure.signed', 'audit_procedure', id, { level, engagementId: e.id });
    });
  }

  /** Clears sign-offs (all levels) with a reason; partner only. History stays in the append-only trail. */
  async reopen(a: RequestActor, id: string, reason: string) {
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const { p, e, c } = await this.loadProc(tx, a, id, 'edit');
      if (!this.rights(a, e, c).canPartner) throw new ForbiddenException({ message: 'Only the engagement partner can reopen', code: 'forbidden' });
      await this.clearSignoffs(tx, a, p, 'reopened', reason);
      await this.rec(tx, a, 'audit_procedure.reopened', 'audit_procedure', id, { reason, engagementId: e.id });
    });
  }

  private async clearSignoffs(tx: Tx, a: RequestActor, p: Record<string, unknown>, action: 'reopened' | 'invalidated', reason: string) {
    const levels = invalidatedByEvidence({ preparedBy: p.prepared_by as string, reviewedBy: p.reviewed_by as string, partnerBy: p.partner_by as string });
    if (!levels.length) return levels;
    const now = this.clock.now();
    for (const l of levels) await tx.query(`INSERT INTO audit_signoff_event (id, tenant_id, procedure_id, level, action, user_id, reason, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [uuidv7(), a.tenantId, p.id, l, action, a.userId, reason.slice(0, 500), now]);
    await tx.query(`UPDATE audit_procedure SET partner_by = NULL, partner_at = NULL, reviewed_by = NULL, reviewed_at = NULL, prepared_by = NULL, prepared_at = NULL,
      evidence_changed_at = CASE WHEN $2 THEN $3::timestamptz ELSE evidence_changed_at END, version = version + 1, updated_at = now() WHERE id = $1`, [p.id, action === 'invalidated', now]);
    return levels;
  }

  trail(a: RequestActor, id: string) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      await this.loadProc(tx, a, id, 'view');
      return (await tx.query(`SELECT s.level, s.action, s.user_id AS "userId", u.name AS "userName", s.reason, s.at FROM audit_signoff_event s LEFT JOIN app_user u ON u.id = s.user_id
        WHERE s.procedure_id = $1 ORDER BY s.at, s.id`, [id])).rows;
    });
  }

  // ---------- Workpapers ----------
  async linkWorkpaper(a: RequestActor, procedureId: string, documentId: string) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const { p, e, c } = await this.loadProc(tx, a, procedureId, 'edit');
      if (!this.rights(a, e, c).canPrepare) throw new ForbiddenException();
      const d = (await tx.query('SELECT client_id, current_version FROM document WHERE id = $1 AND deleted_at IS NULL', [documentId])).rows[0];
      if (!d || d.client_id !== e.client_id) throw new BadRequestException({ message: 'Workpaper must be a document of the engagement client', code: 'invalid:documentId' });
      const existing = (await tx.query('SELECT id FROM audit_workpaper WHERE procedure_id = $1 AND document_id = $2 AND unlinked_at IS NULL FOR UPDATE', [procedureId, documentId])).rows[0];
      const id = existing?.id ?? uuidv7();
      if (existing) await tx.query('UPDATE audit_workpaper SET document_version = $2, linked_by = $3, linked_at = $4 WHERE id = $1', [id, d.current_version, a.userId, this.clock.now()]);
      else await tx.query(`INSERT INTO audit_workpaper (id, tenant_id, engagement_id, procedure_id, document_id, document_version, linked_by, linked_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, a.tenantId, e.id, procedureId, documentId, d.current_version, a.userId, this.clock.now()]);
      const invalidated = await this.clearSignoffs(tx, a, p, 'invalidated', `evidence ${existing ? 'refreshed' : 'added'}: document ${documentId} v${d.current_version}`);
      await this.rec(tx, a, 'audit_workpaper.linked', 'audit_procedure', procedureId, { documentId, version: d.current_version, invalidated });
      return { id, documentVersion: d.current_version, invalidated };
    });
  }

  async unlinkWorkpaper(a: RequestActor, id: string) {
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const w = (await tx.query('SELECT * FROM audit_workpaper WHERE id = $1 AND unlinked_at IS NULL', [id])).rows[0];
      if (!w) throw new NotFoundException();
      const { p, e, c } = await this.loadProc(tx, a, w.procedure_id, 'edit');
      if (!this.rights(a, e, c).canPrepare) throw new ForbiddenException();
      await tx.query('UPDATE audit_workpaper SET unlinked_at = $2, unlinked_by = $3 WHERE id = $1', [id, this.clock.now(), a.userId]);
      const invalidated = await this.clearSignoffs(tx, a, p, 'invalidated', `evidence removed: document ${w.document_id}`);
      await this.rec(tx, a, 'audit_workpaper.unlinked', 'audit_procedure', w.procedure_id, { documentId: w.document_id, invalidated });
    });
  }

  workpapers(a: RequestActor, procedureId: string) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      await this.loadProc(tx, a, procedureId, 'view');
      return (await tx.query(`SELECT w.id, w.document_id AS "documentId", d.name, w.document_version AS "documentVersion", d.current_version AS "currentVersion", w.linked_by AS "linkedBy", w.linked_at AS "linkedAt"
        FROM audit_workpaper w JOIN document d ON d.id = w.document_id WHERE w.procedure_id = $1 AND w.unlinked_at IS NULL ORDER BY w.linked_at`, [procedureId])).rows;
    });
  }

  // ---------- PBC ----------
  async addPbc(a: RequestActor, engagementId: string, items: Array<{ title: string; description?: string | null; dueDate?: string | null }>) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const { e } = await this.loadEng(tx, a, engagementId, 'edit');
      const ids: string[] = [];
      for (const it of items) {
        const id = uuidv7(); ids.push(id);
        await tx.query('INSERT INTO pbc_item (id, tenant_id, engagement_id, client_id, title, description, due_date, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [id, a.tenantId, engagementId, e.client_id, it.title, it.description ?? null, it.dueDate ?? null, a.userId]);
      }
      await this.rec(tx, a, 'pbc.requested', 'audit_engagement', engagementId, { count: items.length });
      return { ids };
    });
  }

  async updatePbc(a: RequestActor, id: string, b: { status?: 'requested' | 'received' | 'accepted' | 'rejected'; documentIds?: string[]; rejectionReason?: string | null; dueDate?: string | null }) {
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const it = (await tx.query('SELECT * FROM pbc_item WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0];
      if (!it) throw new NotFoundException();
      await this.loadEng(tx, a, it.engagement_id, 'edit');
      if (b.status === 'rejected' && !b.rejectionReason?.trim()) throw new BadRequestException({ message: 'Give a reason', code: 'reason_required' });
      if (b.status === 'accepted' && !['received', 'accepted'].includes(it.status)) throw new BadRequestException({ message: 'Receive the item first', code: 'invalid_transition' });
      if (b.documentIds?.length) {
        const ok = (await tx.query('SELECT count(*)::int AS n FROM document WHERE id = ANY($1::uuid[]) AND client_id = $2 AND deleted_at IS NULL', [b.documentIds, it.client_id])).rows[0].n;
        if (ok !== new Set(b.documentIds).size) throw new BadRequestException({ message: 'Documents must belong to the client', code: 'invalid:documentIds' });
      }
      const now = this.clock.now();
      await tx.query(`UPDATE pbc_item SET status = COALESCE($2, status), document_ids = COALESCE($3, document_ids), rejection_reason = CASE WHEN $2 = 'rejected' THEN $4 ELSE rejection_reason END,
        due_date = CASE WHEN $5 THEN $6::date ELSE due_date END, received_at = CASE WHEN $2 = 'received' THEN $7 ELSE received_at END,
        decided_by = CASE WHEN $2 IN ('accepted','rejected') THEN $8::uuid ELSE decided_by END, decided_at = CASE WHEN $2 IN ('accepted','rejected') THEN $7 ELSE decided_at END,
        version = version + 1, updated_at = now() WHERE id = $1`,
      [id, b.status ?? null, b.documentIds ?? null, b.rejectionReason ?? null, b.dueDate !== undefined, b.dueDate ?? null, now, a.userId]);
      await this.rec(tx, a, 'pbc.updated', 'pbc_item', id, { status: b.status, documents: b.documentIds?.length });
    });
  }

  /**
   * Reminds the client about open PBC items (requested/rejected, due on or before `today`, at most every `reminderEveryDays`, up to `maxReminders`).
   * Transactional category through the comm pipeline: consent/opt-out, quiet hours, caps and timeline apply.
   */
  async remindPbcTx(tx: Tx, tenantId: string, today: string, engagementId: string | null, by: string | null) {
    const s = await loadPracticeSettings(tx);
    const p = new Params([today, s.pbc.reminderEveryDays, s.pbc.maxReminders]);
    const rows = (await tx.query(`SELECT i.*, e.fy, e.audit_type FROM pbc_item i JOIN audit_engagement e ON e.id = i.engagement_id
      WHERE i.deleted_at IS NULL AND e.deleted_at IS NULL AND e.status <> 'closed' AND i.status IN ('requested','rejected') AND (i.due_date IS NULL OR i.due_date <= $1::date + 3)
        AND (i.last_reminded_on IS NULL OR i.last_reminded_on <= $1::date - $2::int) AND i.reminder_count < $3
        ${engagementId ? `AND i.engagement_id = ${p.add(engagementId)}` : ''} ORDER BY i.engagement_id, i.due_date NULLS LAST`, p.values)).rows;
    const byEng = new Map<string, typeof rows>();
    for (const r of rows) byEng.set(r.engagement_id, [...(byEng.get(r.engagement_id) ?? []), r]);
    const queued: string[] = []; const skipped: Array<{ engagementId: string; reason: string }> = [];
    for (const [eid, items] of byEng) {
      const clientId = items[0]!.client_id as string;
      const to = await addressFor(tx, clientId, s.pbc.channel);
      const address = normalizeAddress(s.pbc.channel, to.address);
      if (!address) { skipped.push({ engagementId: eid, reason: 'no_address' }); continue; }
      const text = `Reminder: we are awaiting the following for your ${String(items[0]!.audit_type).replace(/_/g, ' ')} (FY ${items[0]!.fy}):\n${items.map((i, n) => `${n + 1}. ${i.title}${i.due_date ? ` (due ${ymd(i.due_date)})` : ''}`).join('\n')}`;
      const q = await this.comm.queueTx(tx, tenantId, { clientId, contactId: to.contactId, channel: s.pbc.channel, address, category: 'transactional', subject: 'Documents pending for your audit',
        text, createdBy: by, now: this.clock.now(), meta: { engagementId: eid, pbcItems: items.map((i) => i.id) }, format: 'text' });
      if ('error' in q) { skipped.push({ engagementId: eid, reason: q.error }); continue; }
      queued.push(q.id);
      await tx.query('UPDATE pbc_item SET reminder_count = reminder_count + 1, last_reminded_on = $2 WHERE id = ANY($1::uuid[])', [items.map((i) => i.id), today]);
      await this.audit.record(tx, tenantId, { actorId: by, deviceId: 'server', action: 'pbc.reminded', entity: 'audit_engagement', entityId: eid, diff: { items: items.length, channel: s.pbc.channel, messageId: q.id } });
    }
    return { queued, skipped };
  }

  async remindPbc(a: RequestActor, engagementId: string) {
    const r = await this.db.tenantTx(a.tenantId, async (tx) => {
      await this.loadEng(tx, a, engagementId, 'edit');
      return this.remindPbcTx(tx, a.tenantId, this.clock.todayIst(), engagementId, a.userId);
    });
    for (const id of r.queued) await this.comm.deliverNow(a.tenantId, id, this.clock.now());
    return { sent: r.queued.length, skipped: r.skipped };
  }

  // ---------- UDIN ----------
  listUdins(a: RequestActor, q: { clientId?: string; engagementId?: string }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params(); const where = ['c.deleted_at IS NULL', visibleSql(a, 'audit', p)];
      if (q.clientId) where.push(`u.client_id = ${p.add(q.clientId)}`);
      if (q.engagementId) where.push(`u.engagement_id = ${p.add(q.engagementId)}`);
      return (await tx.query(`SELECT u.* FROM udin_record u JOIN client c ON c.id = u.client_id WHERE ${where.join(' AND ')} ORDER BY u.generated_on DESC, u.created_at DESC LIMIT 500`, p.values)).rows.map(udinOut);
    });
  }

  async recordUdin(a: RequestActor, b: UdinIn) {
    const cur = new Cursor();
    const id = await this.db.tenantTx(a.tenantId, async (tx) => {
      await clientFor(tx, a, b.clientId, 'audit', 'edit');
      if (b.engagementId) {
        const { e } = await this.loadEng(tx, a, b.engagementId, 'edit');
        if (e.client_id !== b.clientId) throw new BadRequestException({ message: 'Engagement belongs to another client', code: 'invalid:engagementId' });
      }
      if (b.taskId) {
        const t = (await tx.query('SELECT client_id FROM task WHERE id = $1 AND deleted_at IS NULL', [b.taskId])).rows[0];
        if (!t || t.client_id !== b.clientId) throw new BadRequestException({ message: 'Task belongs to another client', code: 'invalid:taskId' });
      }
      if (b.generatedOn > this.clock.todayIst()) throw new BadRequestException({ message: 'UDIN date is in the future', code: 'future_date' });
      if (b.udin.slice(2, 8) !== b.membershipNo) throw new BadRequestException({ message: 'UDIN does not carry this membership number', code: 'membership_mismatch' });
      await staffUser(tx, b.signingPartnerId, 'signingPartnerId');
      if (b.documentId) {
        const d = (await tx.query('SELECT client_id FROM document WHERE id = $1 AND deleted_at IS NULL', [b.documentId])).rows[0];
        if (!d || d.client_id !== b.clientId) throw new BadRequestException({ message: 'Document belongs to another client', code: 'invalid:documentId' });
      }
      const id = uuidv7();
      await tx.query('SAVEPOINT udin');
      try {
        await tx.query(`INSERT INTO udin_record (id, tenant_id, client_id, engagement_id, task_id, udin, document_type, generated_on, membership_no, signing_partner_id, document_id, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [id, a.tenantId, b.clientId, b.engagementId ?? null, b.taskId ?? null, b.udin, b.documentType, b.generatedOn, b.membershipNo,
          b.signingPartnerId ?? null, b.documentId ?? null, a.userId]);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new ConflictException({ message: 'This UDIN is already recorded', code: 'udin_duplicate' });
        throw e;
      }
      // Touch the linked task so devices re-evaluate the close gate.
      const taskIds = [b.taskId, b.engagementId ? (await tx.query('SELECT task_id FROM audit_engagement WHERE id = $1', [b.engagementId])).rows[0]?.task_id : null].filter(Boolean);
      for (const t of taskIds) cur.add(Number((await tx.query('UPDATE task SET updated_at = now() WHERE id = $1 RETURNING sync_cursor', [t])).rows[0]?.sync_cursor ?? 0));
      await this.rec(tx, a, 'udin.recorded', 'udin_record', id, { udin: b.udin, documentType: b.documentType, engagementId: b.engagementId ?? null, taskId: b.taskId ?? null });
      return id;
    });
    this.publish(a.tenantId, cur);
    return { id };
  }

  async revokeUdin(a: RequestActor, id: string, reason: string) {
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const u = (await tx.query('SELECT * FROM udin_record WHERE id = $1 AND revoked_at IS NULL', [id])).rows[0];
      if (!u) throw new NotFoundException();
      await clientFor(tx, a, u.client_id, 'audit', 'approve');
      await tx.query('UPDATE udin_record SET revoked_at = $2, revoked_by = $3, revoke_reason = $4 WHERE id = $1', [id, this.clock.now(), a.userId, reason]);
      await this.rec(tx, a, 'udin.revoked', 'udin_record', id, { udin: u.udin, reason });
    });
  }
}

function checkSections(sections: ProgrammeSection[]) {
  const keys = sections.map((s) => s.key);
  if (new Set(keys).size !== keys.length) throw new BadRequestException({ message: 'Duplicate section key', code: 'duplicate_key' });
  for (const s of sections) {
    const pk = s.procedures.map((p) => p.key);
    if (new Set(pk).size !== pk.length) throw new BadRequestException({ message: `Duplicate procedure key in ${s.key}`, code: 'duplicate_key' });
  }
}
