import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  ageBucket, AGE_BUCKETS, isLevelOf, NOTICE_AUTHORITIES, noticeTaskDue, noticeTransitionError, type FieldSuggestion, type NoticeAuthority, type NoticeOutcome, type NoticeStatus,
} from '@worko/domain';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { Clock } from '../common/clock.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { DocumentsService } from '../documents/documents.service.js';
import { insertNotifications } from '../notifications/insert.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { STORAGE, type StorageAdapter } from '../storage/storage.js';
import { SyncService } from '../sync/sync.service.js';
import { clientFor, createLinkedTask, Cursor, loadPracticeSettings, Params, staffUser, usersSeeing, visibleSql, ymd } from './common.js';
import { extractableSchema } from './schemas.js';
import { NOTICE_EXTRACTORS, textOf, type NoticeExtractor } from './extractor.js';

export type NoticeIn = {
  clientId: string; authority: NoticeAuthority; level?: string; section?: string | null; referenceNo?: string | null; din?: string | null; title: string; description?: string | null;
  issueDate?: string | null; receivedOn?: string; responseDue?: string | null; assessmentYear?: string | null; financialYear?: string | null; period?: string | null;
  demandPaise?: number; assigneeId?: string | null; reviewerId?: string | null; createTask?: boolean; appealOf?: string | null;
};
export type NoticePatch = Partial<Omit<NoticeIn, 'clientId' | 'createTask' | 'appealOf'>>;
type HearingIn = { startsAt: string; endsAt?: string | null; venue?: string | null; virtualLink?: string | null };

const COLS: Record<string, string> = {
  authority: 'authority', level: 'level', section: 'section', referenceNo: 'reference_no', din: 'din', title: 'title', description: 'description', issueDate: 'issue_date',
  receivedOn: 'received_on', responseDue: 'response_due', assessmentYear: 'assessment_year', financialYear: 'financial_year', period: 'period', demandPaise: 'demand_paise',
  assigneeId: 'assignee_id', reviewerId: 'reviewer_id',
};
/** Fields an extraction may fill (others — PAN/GSTIN — are shown for matching only). */
const EXTRACTABLE = ['authority', 'section', 'din', 'referenceNo', 'assessmentYear', 'financialYear', 'issueDate', 'responseDue', 'demandPaise'];

export const noticeOut = (r: Record<string, unknown>) => ({
  id: r.id, clientId: r.client_id, clientName: r.client_name ?? null, authority: r.authority, level: r.level, section: r.section, referenceNo: r.reference_no, din: r.din,
  title: r.title, description: r.description, issueDate: ymd(r.issue_date), receivedOn: ymd(r.received_on), responseDue: ymd(r.response_due), assessmentYear: r.assessment_year,
  financialYear: r.financial_year, period: r.period, demandPaise: Number(r.demand_paise), status: r.status, outcome: r.outcome, outcomeNote: r.outcome_note,
  finalDemandPaise: r.final_demand_paise === null || r.final_demand_paise === undefined ? null : Number(r.final_demand_paise), assigneeId: r.assignee_id, reviewerId: r.reviewer_id,
  taskId: r.task_id, appealOf: r.appeal_of, closedAt: r.closed_at, version: r.version, createdAt: r.created_at,
});
const hearingOut = (r: Record<string, unknown>) => ({
  id: r.id, noticeId: r.notice_id, startsAt: r.starts_at, endsAt: r.ends_at, venue: r.venue, virtualLink: r.virtual_link, status: r.status, adjournedFrom: r.adjourned_from,
  adjournmentReason: r.adjournment_reason, prepDone: r.prep_done, outcomeNote: r.outcome_note, ownerId: r.owner_id, calendarEventId: r.calendar_event_id,
});
const extractionOut = (r: Record<string, unknown>) => ({
  id: r.id, clientId: r.client_id, noticeId: r.notice_id, documentId: r.document_id, documentVersion: r.document_version, provider: r.provider,
  suggestions: r.suggestions, status: r.status, confirmedFields: r.confirmed_fields, createdAt: r.created_at,
});

@Injectable()
export class NoticesService {
  constructor(private db: DbService, private audit: AuditService, private sync: SyncService, private realtime: RealtimeService, private clock: Clock,
    private docs: DocumentsService, @Inject(STORAGE) private storage: StorageAdapter, @Inject(NOTICE_EXTRACTORS) private extractors: Record<string, NoticeExtractor>) {}

  private publish(tenantId: string, c: Cursor | number) { const v = typeof c === 'number' ? c : c.v; if (v) this.realtime.publish({ type: 'changed', tenantId, cursor: v }); }
  private rec(tx: Tx, a: RequestActor, action: string, entityId: string | null, diff?: unknown) {
    return this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action, entity: 'notice', entityId, diff });
  }

  private async load(tx: Tx, a: RequestActor, id: string, action: 'view' | 'edit' = 'view', lock = false) {
    const n = (await tx.query(`SELECT n.*, c.name AS client_name FROM notice n JOIN client c ON c.id = n.client_id WHERE n.id = $1 AND n.deleted_at IS NULL${lock ? ' FOR UPDATE OF n' : ''}`, [id])).rows[0];
    if (!n) throw new NotFoundException();
    await clientFor(tx, a, n.client_id, 'notices', action);
    return n;
  }

  list(a: RequestActor, q: { clientId?: string; status?: string[]; authority?: string; open?: boolean; overdue?: boolean; assigneeId?: string; q?: string; limit: number; offset: number }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params();
      const where = ['n.deleted_at IS NULL', 'c.deleted_at IS NULL', visibleSql(a, 'notices', p)];
      if (q.clientId) where.push(`n.client_id = ${p.add(q.clientId)}`);
      if (q.status?.length) where.push(`n.status = ANY(${p.add(q.status)}::text[])`);
      if (q.authority) where.push(`n.authority = ${p.add(q.authority)}`);
      if (q.open) where.push(`n.status <> 'closed'`);
      if (q.overdue) where.push(`n.status IN ('received','under_review','drafting') AND n.response_due < ${p.add(this.clock.todayIst())}::date`);
      if (q.assigneeId) where.push(`n.assignee_id = ${p.add(q.assigneeId === 'me' ? a.userId : q.assigneeId)}::uuid`);
      if (q.q) { const t = p.add(q.q); where.push(`(n.title ILIKE '%' || ${t} || '%' OR n.din ILIKE '%' || ${t} || '%' OR n.reference_no ILIKE '%' || ${t} || '%' OR c.name ILIKE '%' || ${t} || '%')`); }
      const rows = (await tx.query(`SELECT n.*, c.name AS client_name, count(*) OVER () AS total FROM notice n JOIN client c ON c.id = n.client_id
        WHERE ${where.join(' AND ')} ORDER BY n.response_due NULLS LAST, n.id LIMIT ${p.add(q.limit)} OFFSET ${p.add(q.offset)}`, p.values)).rows;
      return { total: Number(rows[0]?.total ?? 0), items: rows.map(noticeOut) };
    });
  }

  get(a: RequestActor, id: string) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const n = await this.load(tx, a, id);
      const documents = (await tx.query(`SELECT nd.document_id AS "documentId", nd.kind, d.name, d.current_version AS "currentVersion", nd.linked_at AS "linkedAt"
        FROM notice_document nd JOIN document d ON d.id = nd.document_id AND d.deleted_at IS NULL WHERE nd.notice_id = $1 ORDER BY nd.linked_at`, [id])).rows;
      const hearings = (await tx.query('SELECT * FROM notice_hearing WHERE notice_id = $1 AND deleted_at IS NULL ORDER BY starts_at', [id])).rows.map(hearingOut);
      return { ...noticeOut(n), documents, hearings };
    });
  }

  private validate(authority: string, level: string, n: { issueDate?: string | null; responseDue?: string | null }) {
    if (!(authority in NOTICE_AUTHORITIES)) throw new BadRequestException({ message: 'Unknown authority', code: 'invalid:authority' });
    if (!isLevelOf(authority as NoticeAuthority, level)) throw new BadRequestException({ message: 'Level not valid for this authority', code: 'invalid:level' });
    if (n.issueDate && n.responseDue && n.responseDue < n.issueDate) throw new BadRequestException({ message: 'Response due before issue date', code: 'due_before_issue' });
  }

  async createTx(tx: Tx, a: RequestActor, b: NoticeIn, cur: Cursor) {
    const c = await clientFor(tx, a, b.clientId, 'notices', 'create');
    const level = b.level ?? NOTICE_AUTHORITIES[b.authority].levels[0];
    this.validate(b.authority, level, b);
    await staffUser(tx, b.assigneeId, 'assigneeId'); await staffUser(tx, b.reviewerId, 'reviewerId');
    if (b.appealOf) await this.load(tx, a, b.appealOf);
    const today = this.clock.todayIst();
    const id = uuidv7();
    const r = await tx.query(`INSERT INTO notice (id, tenant_id, client_id, authority, level, section, reference_no, din, title, description, issue_date, received_on, response_due,
        assessment_year, financial_year, period, demand_paise, assignee_id, reviewer_id, appeal_of, created_by, updated_by, device_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21,'server') RETURNING sync_cursor`,
    [id, a.tenantId, b.clientId, b.authority, level, b.section ?? null, b.referenceNo ?? null, b.din ?? null, b.title, b.description ?? null, b.issueDate ?? null, b.receivedOn ?? today,
      b.responseDue ?? null, b.assessmentYear ?? null, b.financialYear ?? null, b.period ?? null, b.demandPaise ?? 0, b.assigneeId ?? null, b.reviewerId ?? null, b.appealOf ?? null, a.userId]);
    cur.add(Number(r.rows[0].sync_cursor));
    if (b.createTask !== false && b.responseDue) {
      const s = await loadPracticeSettings(tx);
      const t = await createLinkedTask(tx, a.tenantId, {
        clientId: b.clientId, title: `Reply to ${NOTICE_AUTHORITIES[b.authority].label} notice${b.section ? ` u/s ${b.section}` : ''}: ${b.title}`.slice(0, 300),
        statutoryDue: b.responseDue, actBy: noticeTaskDue(b.responseDue, s.notices.taskBufferDays, today), assigneeId: b.assigneeId ?? c.manager_id ?? null,
        reviewerId: b.reviewerId ?? null, ruleId: `notice:${id}`, priority: 'high', createdBy: a.userId,
      });
      cur.add(t.cursor);
      cur.add((await this.sync.serverPatch(tx, a, 'notice', id, { task_id: t.id }))?.cursor);
    }
    await this.rec(tx, a, 'notice.created', id, { clientId: b.clientId, authority: b.authority, level, section: b.section ?? null, responseDue: b.responseDue ?? null, demandPaise: b.demandPaise ?? 0 });
    return id;
  }

  async create(a: RequestActor, b: NoticeIn) {
    const cur = new Cursor();
    const id = await this.db.tenantTx(a.tenantId, (tx) => this.createTx(tx, a, b, cur));
    this.publish(a.tenantId, cur);
    return { id };
  }

  async update(a: RequestActor, id: string, b: NoticePatch) {
    const cur = new Cursor();
    await this.db.tenantTx(a.tenantId, async (tx) => {
      await this.updateInTx(tx, a, id, b, cur);
      await this.rec(tx, a, 'notice.updated', id, b);
    });
    this.publish(a.tenantId, cur);
  }

  async setStatus(a: RequestActor, id: string, b: { status: NoticeStatus; outcome?: NoticeOutcome | null; outcomeNote?: string | null; finalDemandPaise?: number | null }) {
    const cur = new Cursor();
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const n = await this.load(tx, a, id, 'edit', true);
      const why = noticeTransitionError(n.status, b.status, b.outcome);
      if (why) throw new BadRequestException({ message: 'Rejected', code: why });
      if (b.status !== 'closed' && b.outcome) throw new BadRequestException({ message: 'Outcome only when closing', code: 'outcome_only_on_close' });
      const now = this.clock.now().toISOString();
      const patch: Record<string, unknown> = { status: b.status };
      if (b.status === 'closed') Object.assign(patch, { outcome: b.outcome, outcome_note: b.outcomeNote ?? null, final_demand_paise: b.finalDemandPaise ?? null, closed_at: now });
      if (b.status === 'submitted') patch.submitted_at = now;
      cur.add((await this.sync.serverPatch(tx, a, 'notice', id, patch))?.cursor);
      await this.rec(tx, a, 'notice.status', id, { from: n.status, to: b.status, outcome: b.outcome ?? null });
    });
    this.publish(a.tenantId, cur);
  }

  async linkDocument(a: RequestActor, id: string, b: { documentId: string; kind: string }) {
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const n = await this.load(tx, a, id, 'edit');
      const d = (await tx.query('SELECT client_id FROM document WHERE id = $1 AND deleted_at IS NULL', [b.documentId])).rows[0];
      if (!d || d.client_id !== n.client_id) throw new BadRequestException({ message: 'Document must belong to the notice client', code: 'invalid:documentId' });
      await tx.query(`INSERT INTO notice_document (tenant_id, notice_id, document_id, kind, linked_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (notice_id, document_id) DO NOTHING`,
        [a.tenantId, id, b.documentId, b.kind, a.userId]);
      await this.rec(tx, a, 'notice.document_linked', id, b);
    });
  }

  // ---------- Extraction: upload → suggestions → confirm ----------
  async extract(a: RequestActor, file: { buffer: Buffer; mimetype: string; originalname: string; size: number }, m: { clientId: string; noticeId?: string | null }, ip: string | null) {
    const settings = await this.db.tenantTx(a.tenantId, async (tx) => {
      await clientFor(tx, a, m.clientId, 'notices', 'create');
      if (m.noticeId) { const n = await this.load(tx, a, m.noticeId, 'edit'); if (n.client_id !== m.clientId) throw new BadRequestException('Notice belongs to another client'); }
      return loadPracticeSettings(tx);
    });
    const doc = await this.docs.upload(a, file, { clientId: m.clientId, category: 'Notices', tags: ['notice'] }, ip);
    const ext = settings.ai.noticeExtraction && this.extractors.anthropic ? this.extractors.anthropic : this.extractors.mock!;
    let suggestions: FieldSuggestion[] = [];
    try { suggestions = await ext.extract(textOf(file.buffer, file.mimetype)); } catch { suggestions = []; }
    const id = uuidv7();
    await this.db.tenantTx(a.tenantId, async (tx) => {
      await tx.query(`INSERT INTO notice_extraction (id, tenant_id, client_id, notice_id, document_id, document_version, provider, suggestions, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, a.tenantId, m.clientId, m.noticeId ?? null, doc.id, doc.version, ext.name, JSON.stringify(suggestions), a.userId]);
      if (m.noticeId) await tx.query(`INSERT INTO notice_document (tenant_id, notice_id, document_id, kind, linked_by) VALUES ($1,$2,$3,'notice',$4) ON CONFLICT DO NOTHING`, [a.tenantId, m.noticeId, doc.id, a.userId]);
      // Metadata only: which fields were suggested, never their values (they may be PII).
      await this.rec(tx, a, 'notice.extracted', m.noticeId ?? null, { extractionId: id, documentId: doc.id, provider: ext.name, fields: suggestions.map((s) => s.field) });
    });
    return { id, documentId: doc.id, provider: ext.name, suggestions, status: 'pending' };
  }

  private async loadExtraction(tx: Tx, a: RequestActor, id: string, action: 'view' | 'create') {
    const e = (await tx.query('SELECT * FROM notice_extraction WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!e) throw new NotFoundException();
    await clientFor(tx, a, e.client_id, 'notices', action);
    return e;
  }

  getExtraction(a: RequestActor, id: string) { return this.db.tenantTx(a.tenantId, async (tx) => extractionOut(await this.loadExtraction(tx, a, id, 'view'))); }

  /**
   * Applies only the fields the user confirms (values may be corrected); creates the notice when none is linked yet.
   * Unconfirmed suggestions never reach the notice.
   */
  async confirmExtraction(a: RequestActor, id: string, b: { fields: Record<string, string | number>; title?: string; assigneeId?: string | null; reviewerId?: string | null; level?: string }) {
    const cur = new Cursor();
    const r = await this.db.tenantTx(a.tenantId, async (tx) => {
      const e = await this.loadExtraction(tx, a, id, 'create');
      if (e.status !== 'pending') throw new ConflictException({ message: 'Extraction already decided', code: 'extraction_decided' });
      const unknown = Object.keys(b.fields).filter((k) => !EXTRACTABLE.includes(k));
      if (unknown.length) throw new BadRequestException({ message: `Not confirmable: ${unknown.join(', ')}`, code: 'invalid:fields' });
      // Same types as a manual edit: a corrected value that doesn't validate is a 400, never a database error.
      const parsed = extractableSchema.safeParse(b.fields);
      if (!parsed.success) throw new BadRequestException({ message: 'Invalid confirmed value', code: 'invalid:fields', issues: parsed.error.issues });
      const f = parsed.data as Record<string, unknown>;
      let noticeId = e.notice_id as string | null;
      if (noticeId) {
        const patch: NoticePatch = { ...(f as NoticePatch) };
        if (b.title) patch.title = b.title;
        await this.updateInTx(tx, a, noticeId, patch, cur);
      } else {
        if (typeof f.authority !== 'string' || !(f.authority in NOTICE_AUTHORITIES)) throw new BadRequestException({ message: 'Confirm the authority', code: 'invalid:authority' });
        noticeId = await this.createTx(tx, a, {
          clientId: e.client_id, authority: f.authority as NoticeAuthority, level: b.level, title: b.title ?? `Notice${f.section ? ` u/s ${String(f.section)}` : ''}`,
          section: (f.section as string) ?? null, din: (f.din as string) ?? null, referenceNo: (f.referenceNo as string) ?? null, issueDate: (f.issueDate as string) ?? null,
          responseDue: (f.responseDue as string) ?? null, assessmentYear: (f.assessmentYear as string) ?? null, financialYear: (f.financialYear as string) ?? null,
          demandPaise: typeof f.demandPaise === 'number' ? f.demandPaise : 0, assigneeId: b.assigneeId ?? null, reviewerId: b.reviewerId ?? null,
        }, cur);
        await tx.query(`INSERT INTO notice_document (tenant_id, notice_id, document_id, kind, linked_by) VALUES ($1,$2,$3,'notice',$4) ON CONFLICT DO NOTHING`, [a.tenantId, noticeId, e.document_id, a.userId]);
      }
      await tx.query(`UPDATE notice_extraction SET status = 'confirmed', notice_id = $2, confirmed_fields = $3, decided_by = $4, decided_at = $5 WHERE id = $1`,
        [id, noticeId, Object.keys(b.fields), a.userId, this.clock.now()]);
      await this.rec(tx, a, 'notice.extraction_confirmed', noticeId, { extractionId: id, fields: Object.keys(b.fields) });
      return { noticeId };
    });
    this.publish(a.tenantId, cur);
    return r;
  }

  /** One path for manual edits and confirmed extractions: validation, people checks and the linked task following the response due. */
  private async updateInTx(tx: Tx, a: RequestActor, id: string, b: NoticePatch, cur: Cursor) {
    const n = await this.load(tx, a, id, 'edit', true);
    if (n.status === 'closed') throw new ConflictException({ message: 'Notice is closed', code: 'notice_closed' });
    const authority = b.authority ?? n.authority; const level = b.level ?? (b.authority && b.authority !== n.authority ? NOTICE_AUTHORITIES[b.authority].levels[0] : n.level);
    this.validate(authority, level, { issueDate: b.issueDate !== undefined ? b.issueDate : ymd(n.issue_date), responseDue: b.responseDue !== undefined ? b.responseDue : ymd(n.response_due) });
    if (b.assigneeId !== undefined) await staffUser(tx, b.assigneeId, 'assigneeId');
    if (b.reviewerId !== undefined) await staffUser(tx, b.reviewerId, 'reviewerId');
    const patch: Record<string, unknown> = { level };
    for (const [k, v] of Object.entries(b)) if (v !== undefined && COLS[k]) patch[COLS[k]!] = v;
    cur.add((await this.sync.serverPatch(tx, a, 'notice', id, patch))?.cursor);
    if (b.responseDue && n.task_id) {
      const s = await loadPracticeSettings(tx);
      const t = (await tx.query('SELECT outcome FROM task WHERE id = $1', [n.task_id])).rows[0];
      if (t && !t.outcome) cur.add((await this.sync.serverPatch(tx, a, 'task', n.task_id, { statutory_due: b.responseDue, act_by: noticeTaskDue(b.responseDue, s.notices.taskBufferDays, this.clock.todayIst()) }))?.cursor);
    }
  }

  async discardExtraction(a: RequestActor, id: string) {
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const e = await this.loadExtraction(tx, a, id, 'create');
      if (e.status !== 'pending') throw new ConflictException({ message: 'Extraction already decided', code: 'extraction_decided' });
      await tx.query(`UPDATE notice_extraction SET status = 'discarded', decided_by = $2, decided_at = $3 WHERE id = $1`, [id, a.userId, this.clock.now()]);
      await this.rec(tx, a, 'notice.extraction_discarded', e.notice_id, { extractionId: id });
    });
  }

  // ---------- Hearings ----------
  private async hearingTx(tx: Tx, a: RequestActor, n: Record<string, unknown>, b: HearingIn, cur: Cursor, adjournedFrom: string | null = null, reason: string | null = null) {
    const starts = new Date(b.startsAt); const ends = b.endsAt ? new Date(b.endsAt) : new Date(starts.getTime() + 3_600_000);
    if (ends < starts) throw new BadRequestException({ message: 'Ends before it starts', code: 'invalid:endsAt' });
    const owner = (n.assignee_id as string) ?? a.userId;
    const attendees = [n.reviewer_id].filter((x): x is string => typeof x === 'string' && x !== owner);
    const eventId = uuidv7(); const id = uuidv7();
    const ev = await tx.query(`INSERT INTO calendar_event (id, tenant_id, owner_id, kind, title, description, location, starts_at, ends_at, client_id, attendee_ids, accepted_ids, created_by, device_id)
      VALUES ($1,$2,$3,'hearing',$4,$5,$6,$7,$8,$9,$10,$10,$11,'server') RETURNING sync_cursor`,
    [eventId, a.tenantId, owner, `Hearing: ${String(n.title).slice(0, 200)}`, `Notice ${n.section ? `u/s ${n.section} ` : ''}— ${n.client_name ?? ''}`.trim(), b.venue ?? b.virtualLink ?? null, starts, ends, n.client_id, attendees, a.userId]);
    cur.add(Number(ev.rows[0].sync_cursor));
    const h = await tx.query(`INSERT INTO notice_hearing (id, tenant_id, notice_id, client_id, starts_at, ends_at, venue, virtual_link, adjourned_from, adjournment_reason, owner_id, calendar_event_id, created_by, updated_by, device_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,'server') RETURNING sync_cursor`,
    [id, a.tenantId, n.id, n.client_id, starts, ends, b.venue ?? null, b.virtualLink ?? null, adjournedFrom, reason, owner, eventId, a.userId]);
    cur.add(Number(h.rows[0].sync_cursor));
    const s = await loadPracticeSettings(tx);
    for (const m of s.notices.hearingReminderMinutesBefore) {
      const r = await insertNotifications(tx, a.tenantId, {
        userIds: [owner, ...attendees], category: 'notice.hearing', priority: 'high', title: `Hearing ${m >= 1440 ? `in ${Math.round(m / 1440)} day(s)` : `in ${m} min`}: ${String(n.title).slice(0, 120)}`,
        body: `${starts.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST`, entityType: 'notice_hearing', entityId: id,
        fireAt: new Date(Math.max(starts.getTime() - m * 60_000, this.clock.now().getTime())), dedupeKey: `hearing:${id}:${m}`,
      });
      cur.add(r.cursor);
    }
    if (n.status !== 'hearing' && n.status !== 'closed' && !noticeTransitionError(n.status as NoticeStatus, 'hearing')) cur.add((await this.sync.serverPatch(tx, a, 'notice', n.id as string, { status: 'hearing' }))?.cursor);
    return id;
  }

  async addHearing(a: RequestActor, noticeId: string, b: HearingIn) {
    const cur = new Cursor();
    const id = await this.db.tenantTx(a.tenantId, async (tx) => {
      const n = await this.load(tx, a, noticeId, 'edit', true);
      if (n.status === 'closed') throw new ConflictException({ message: 'Notice is closed', code: 'notice_closed' });
      const id = await this.hearingTx(tx, a, n, b, cur);
      await this.rec(tx, a, 'notice.hearing_added', noticeId, { hearingId: id, startsAt: b.startsAt });
      return id;
    });
    this.publish(a.tenantId, cur);
    return { id };
  }

  private async loadHearing(tx: Tx, a: RequestActor, id: string) {
    const h = (await tx.query('SELECT * FROM notice_hearing WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0];
    if (!h) throw new NotFoundException();
    const n = await this.load(tx, a, h.notice_id, 'edit', true);
    return { h, n };
  }

  async updateHearing(a: RequestActor, id: string, b: { prepDone?: boolean; status?: 'held' | 'cancelled'; outcomeNote?: string | null; venue?: string | null; virtualLink?: string | null }) {
    const cur = new Cursor();
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const { h } = await this.loadHearing(tx, a, id);
      if (h.status !== 'scheduled') throw new ConflictException({ message: 'Hearing is no longer scheduled', code: 'hearing_not_scheduled' });
      const patch: Record<string, unknown> = {};
      if (b.prepDone !== undefined) patch.prep_done = b.prepDone;
      if (b.status) patch.status = b.status;
      if (b.outcomeNote !== undefined) patch.outcome_note = b.outcomeNote;
      if (b.venue !== undefined) patch.venue = b.venue;
      if (b.virtualLink !== undefined) patch.virtual_link = b.virtualLink;
      cur.add((await this.sync.serverPatch(tx, a, 'notice_hearing', id, patch))?.cursor);
      if (b.status === 'cancelled') cur.add(await this.withdrawReminders(tx, id));
      if (b.status === 'cancelled' && h.calendar_event_id) cur.add(Number((await tx.query('UPDATE calendar_event SET deleted_at = now() WHERE id = $1 RETURNING sync_cursor', [h.calendar_event_id])).rows[0]?.sync_cursor ?? 0));
      await this.rec(tx, a, 'notice.hearing_updated', h.notice_id, { hearingId: id, ...b });
    });
    this.publish(a.tenantId, cur);
  }

  /** Adjournment keeps history: the old hearing is marked adjourned and a new one (new event + reminders) points back to it. */
  async adjourn(a: RequestActor, id: string, b: HearingIn & { reason?: string | null }) {
    const cur = new Cursor();
    const newId = await this.db.tenantTx(a.tenantId, async (tx) => {
      const { h, n } = await this.loadHearing(tx, a, id);
      if (h.status !== 'scheduled') throw new ConflictException({ message: 'Hearing is no longer scheduled', code: 'hearing_not_scheduled' });
      cur.add((await this.sync.serverPatch(tx, a, 'notice_hearing', id, { status: 'adjourned' }))?.cursor);
      if (h.calendar_event_id) cur.add(Number((await tx.query('UPDATE calendar_event SET deleted_at = now() WHERE id = $1 RETURNING sync_cursor', [h.calendar_event_id])).rows[0]?.sync_cursor ?? 0));
      cur.add(await this.withdrawReminders(tx, id));
      const nid = await this.hearingTx(tx, a, n, { venue: h.venue, virtualLink: h.virtual_link, ...b }, cur, id, b.reason ?? null);
      await this.rec(tx, a, 'notice.hearing_adjourned', h.notice_id, { from: id, to: nid, startsAt: b.startsAt, reason: b.reason ?? null });
      return nid;
    });
    this.publish(a.tenantId, cur);
    return { id: newId };
  }

  /** Future (unfired) reminders of a hearing are soft-deleted; the trigger bumps version/cursor so devices drop them, and delivery skips deleted rows. */
  private async withdrawReminders(tx: Tx, hearingId: string) {
    const r = await tx.query(`UPDATE notification SET deleted_at = now() WHERE entity_type = 'notice_hearing' AND entity_id = $1 AND deleted_at IS NULL AND fire_at > $2 RETURNING sync_cursor`,
      [hearingId, this.clock.now()]);
    return Math.max(0, ...r.rows.map((x) => Number(x.sync_cursor)));
  }

  // ---------- Reports & escalation ----------
  ageing(a: RequestActor, asOf?: string) {
    const today = asOf ?? this.clock.todayIst();
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params();
      const rows = (await tx.query(`SELECT n.authority, n.level, n.received_on, n.demand_paise, n.response_due, n.status FROM notice n JOIN client c ON c.id = n.client_id
        WHERE n.deleted_at IS NULL AND c.deleted_at IS NULL AND n.status <> 'closed' AND ${visibleSql(a, 'notices', p)}`, p.values)).rows;
      const buckets = Object.fromEntries(AGE_BUCKETS.map((b) => [b, { count: 0, demandPaise: 0 }])) as Record<string, { count: number; demandPaise: number }>;
      const byAuthority = new Map<string, { authority: string; level: string; count: number; demandPaise: number }>();
      let overdue = 0; let demand = 0;
      for (const r of rows) {
        const b = buckets[ageBucket(ymd(r.received_on)!, today)]!; b.count++; b.demandPaise += Number(r.demand_paise);
        const k = `${r.authority}|${r.level}`;
        const g = byAuthority.get(k) ?? { authority: r.authority, level: r.level, count: 0, demandPaise: 0 };
        g.count++; g.demandPaise += Number(r.demand_paise); byAuthority.set(k, g);
        demand += Number(r.demand_paise);
        if (['received', 'under_review', 'drafting'].includes(r.status) && r.response_due && ymd(r.response_due)! < today) overdue++;
      }
      return { asOf: today, open: rows.length, overdue, demandPaise: demand, buckets: AGE_BUCKETS.map((b) => ({ bucket: b, ...buckets[b]! })),
        byAuthority: [...byAuthority.values()].sort((x, y) => x.authority.localeCompare(y.authority) || x.level.localeCompare(y.level)) };
    });
  }

  /**
   * Daily escalation (idempotent by dedupe key): overdue responses and hearings within `hearingPrepDays` without preparation
   * notify the assignee (requires ack); the notification pipeline escalates to their manager if unacknowledged.
   */
  async escalateTx(tx: Tx, tenantId: string, today: string): Promise<{ notified: number; cursor: number }> {
    const s = await loadPracticeSettings(tx);
    let notified = 0; const cur = new Cursor();
    const overdue = (await tx.query(`SELECT n.id, n.client_id, n.title, n.response_due, COALESCE(n.assignee_id, c.manager_id, c.partner_id) AS who FROM notice n JOIN client c ON c.id = n.client_id
      WHERE n.deleted_at IS NULL AND n.status IN ('received','under_review','drafting') AND n.response_due < $1`, [today])).rows;
    for (const n of overdue) {
      const who = await usersSeeing(tx, [n.who], n.client_id, 'notices');
      if (!who.length) continue;
      const r = await insertNotifications(tx, tenantId, { userIds: who, category: 'notice.response_due', priority: 'critical', title: `Notice reply overdue: ${String(n.title).slice(0, 120)}`,
        body: `Response was due ${ymd(n.response_due)}`, entityType: 'notice', entityId: n.id, requiresAck: true, escalateAfterMinutes: s.notices.escalateAfterMinutes, dedupeKey: `notice-overdue:${n.id}:${ymd(n.response_due)}` });
      notified += r.ids.length; cur.add(r.cursor);
    }
    const until = new Date(Date.parse(`${today}T00:00:00+05:30`) + (s.notices.hearingPrepDays + 1) * 86_400_000);
    const hs = (await tx.query(`SELECT h.id, h.client_id, h.starts_at, n.title, COALESCE(h.owner_id, n.assignee_id) AS who FROM notice_hearing h JOIN notice n ON n.id = h.notice_id
      WHERE h.deleted_at IS NULL AND h.status = 'scheduled' AND NOT h.prep_done AND h.starts_at >= $1 AND h.starts_at < $2`, [new Date(`${today}T00:00:00+05:30`), until])).rows;
    for (const h of hs) {
      const who = await usersSeeing(tx, [h.who], h.client_id, 'notices');
      if (!who.length) continue;
      const r = await insertNotifications(tx, tenantId, { userIds: who, category: 'notice.hearing', priority: 'high', title: `Hearing prep pending: ${String(h.title).slice(0, 120)}`,
        body: 'Mark preparation done or escalate.', entityType: 'notice_hearing', entityId: h.id, requiresAck: true, escalateAfterMinutes: s.notices.escalateAfterMinutes,
        dedupeKey: `hearing-prep:${h.id}:${(h.starts_at as Date).toISOString()}` });
      notified += r.ids.length; cur.add(r.cursor);
    }
    return { notified, cursor: cur.v };
  }
}
