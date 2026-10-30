import { BadRequestException, ForbiddenException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import {
  catalogueReport, DATASETS, dashboardWidgetsSchema, datasetMeta, effectiveScope, explainDefinition, opsFor, REPORT_CATALOGUE, ROLE_DASHBOARD_TEMPLATES,
  type DashboardWidget, type ReportDefinition,
} from '@worko/domain';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { clientScopeSql, Params } from '../clients/scope.js';
import { Clock } from '../common/clock.js';
import { KeyService } from '../crypto/key.service.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { requireFirmWide } from '../tasks/system-actor.js';
import { ReportEngine, type RunOptions, type RunResult } from './engine.js';
import { renderRun, type ExportFormat, type ExportMode } from './render.js';

export type Source = { definition?: unknown; reportId?: string; catalogueKey?: string };
export type ShareIn = { firm?: boolean; roles?: string[]; userIds?: string[] };
const nf = () => new NotFoundException('Report not found');
const has = (a: RequestActor, m: Parameters<typeof effectiveScope>[1], x: Parameters<typeof effectiveScope>[2]) => !!a.superAdmin || (effectiveScope(a, m, x)?.scope ?? 'none') !== 'none';
/** Publishing to the firm/roles and editing role-default dashboards: firm-wide reports:approve (D164). */
export const firmPublisher = (a: RequestActor) => !!a.superAdmin || effectiveScope(a, 'reports', 'approve')?.scope === 'all';
const ROLE_ORDER = ['partner', 'manager', 'senior', 'accountant', 'article', 'admin', 'auditor'];
export const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex');

const savedOut = (r: Record<string, unknown>, a: RequestActor) => ({
  id: r.id, name: r.name, description: r.description, ownerId: r.owner_id, ownerName: r.owner_name ?? null, definition: r.definition, explanation: explainDefinition(r.definition as ReportDefinition),
  currentVersion: r.current_version, source: r.source, catalogueKey: r.catalogue_key, share: { firm: r.shared_firm, roles: r.shared_roles, userIds: r.shared_user_ids },
  canEdit: r.owner_id === a.userId || firmPublisher(a), createdAt: r.created_at, updatedAt: r.updated_at, version: r.version,
});
const dashOut = (r: Record<string, unknown>, a: RequestActor) => ({
  id: r.id, name: r.name, ownerId: r.owner_id, roleKey: r.role_key, widgets: r.widgets, canEdit: r.role_key ? firmPublisher(a) : r.owner_id === a.userId, updatedAt: r.updated_at, version: r.version,
});

/** Saved reports (builder), sharing, versions, dashboards, ad-hoc runs and exports (M17). Every run re-scopes to the VIEWER (D161). */
@Injectable()
export class ReportsService {
  constructor(private db: DbService, private audit: AuditService, private keys: KeyService, private clock: Clock, readonly engine: ReportEngine) {}

  // ---------- Catalogue ----------
  datasets(a: RequestActor) {
    return this.engine.allowedDatasets(a, DATASETS).map(({ meta, hidden }) => ({
      key: meta.key, label: meta.label, description: meta.description, module: meta.module, entity: meta.entity ?? null, params: meta.params ?? [],
      columns: meta.columns.map((c) => ({ key: c.key, label: c.label, type: c.type, description: c.description ?? null, values: c.values ?? null, sensitivity: c.sensitivity ?? null,
        ref: c.ref ?? null, hidden: hidden.has(c.key), ops: opsFor(c.type) })),
    }));
  }
  catalogue(a: RequestActor) {
    return REPORT_CATALOGUE.filter((r) => { const m = datasetMeta(r.definition.dataset); return m && this.engine.mayUse(a, m); })
      .map((r) => ({ key: r.key, name: r.name, description: r.description, dataset: r.definition.dataset, definition: r.definition, explanation: explainDefinition(r.definition) }));
  }

  // ---------- Sources ----------
  visibleSql(a: RequestActor, p: Params, r = 'r') {
    if (a.superAdmin) return 'TRUE';
    const me = p.add(a.userId);
    return `(${r}.owner_id = ${me}::uuid OR ${r}.shared_firm OR ${r}.shared_roles && ${p.add(a.roles.map((x) => x.key))}::text[] OR ${me}::uuid = ANY(${r}.shared_user_ids))`;
  }
  async savedRow(tx: Tx, a: RequestActor, id: string, lock = false) {
    const p = new Params([id]);
    const r = (await tx.query(`SELECT r.*, u.name AS owner_name FROM saved_report r LEFT JOIN app_user u ON u.id = r.owner_id WHERE r.id = $1 AND r.deleted_at IS NULL AND ${this.visibleSql(a, p)}${lock ? ' FOR UPDATE OF r' : ''}`, p.values)).rows[0];
    if (!r) throw nf();
    return r as Record<string, unknown>;
  }
  /** Definition + name for a run; a saved report must be visible to the caller (owner / shared), else 404. */
  async resolve(a: RequestActor, s: Source, tx?: Tx): Promise<{ definition: unknown; name: string; reportId: string | null; catalogueKey: string | null; ownerId: string | null }> {
    const given = [s.definition !== undefined, !!s.reportId, !!s.catalogueKey].filter(Boolean).length;
    if (given !== 1) throw new BadRequestException({ message: 'Give exactly one of definition, reportId or catalogueKey', code: 'invalid_source' });
    if (s.catalogueKey) { const c = catalogueReport(s.catalogueKey); if (!c) throw nf(); return { definition: c.definition, name: c.name, reportId: null, catalogueKey: c.key, ownerId: null }; }
    if (s.reportId) {
      const r = tx ? await this.savedRow(tx, a, s.reportId) : await this.db.tenantTx(a.tenantId, (t) => this.savedRow(t, a, s.reportId!));
      return { definition: r.definition, name: r.name as string, reportId: r.id as string, catalogueKey: null, ownerId: r.owner_id as string };
    }
    return { definition: s.definition, name: 'Ad-hoc report', reportId: null, catalogueKey: null, ownerId: null };
  }

  async run(a: RequestActor, s: Source & Pick<RunOptions, 'params' | 'drill' | 'page' | 'pageSize'>) {
    const src = await this.resolve(a, s);
    const r = await this.present(a, await this.engine.run(a, src.definition, { params: s.params, drill: s.drill, page: s.page, pageSize: s.pageSize }), src.ownerId);
    return { ...r, name: src.name, reportId: src.reportId, catalogueKey: src.catalogueKey };
  }

  // ---------- Exports ----------
  /** Exports need reports:export; files with PII/cost/fee/amount columns also need the source module's export (D165). */
  requireExport(a: RequestActor, r: RunResult) {
    if (!has(a, 'reports', 'export')) throw new ForbiddenException({ message: 'Needs reports:export', code: 'export_forbidden' });
    const meta = datasetMeta(r.dataset.key)!;
    const sensitive = r.columns.some((c) => meta.columns.find((m) => m.key === c.key)?.sensitivity)
      || r.definition.aggregates.some((x) => x.column && meta.columns.find((m) => m.key === x.column)?.sensitivity);
    if (sensitive && !has(a, meta.module, 'export')) throw new ForbiddenException({ message: `Needs ${meta.module}:export for sensitive columns`, code: 'export_forbidden' });
  }
  async export(a: RequestActor, s: Source & { params?: Record<string, string | number>; format: ExportFormat; mode?: ExportMode }) {
    const src = await this.resolve(a, s);
    const r = await this.present(a, await this.engine.run(a, src.definition, { params: s.params, allRows: true }), src.ownerId);
    this.requireExport(a, r);
    const mode = s.mode ?? (r.definition.groupBy.length ? 'groups' : 'rows');
    const file = await renderRun(r, s.format, src.name, mode);
    await this.db.tenantTx(a.tenantId, (tx) => this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'report.exported', entity: 'report', entityId: src.reportId,
      diff: { dataset: r.dataset.key, catalogueKey: src.catalogueKey, format: s.format, mode, rows: r.rowCount, columns: r.columns.map((c) => c.key), hidden: r.hiddenColumns } }));
    return file;
  }

  /**
   * Recipient-bound, expiring download (D166, D171). The file is RE-RENDERED AS THE DOWNLOADER now: their current
   * reports:export, dataset/module permissions, sharing, client visibility and field hiding apply — a revocation since
   * delivery takes effect immediately. Only the recipient (any session) may download; others 404; expired 410. Audited (metadata).
   */
  download(a: RequestActor, token: string) { return this.downloadWhere(a, 'token_hash = $1', tokenHash(token)); }
  /** Same, by export id (the in-app `report.ready` notification carries the id). */
  downloadById(a: RequestActor, id: string) { return this.downloadWhere(a, 'id = $1', id); }
  private async downloadWhere(a: RequestActor, where: string, v: string) {
    const e = await this.db.tenantTx(a.tenantId, async (tx) => {
      const e = (await tx.query(`SELECT x.*, s.report_id, s.catalogue_key, s.params, s.name AS schedule_name, s.deleted_at AS schedule_deleted FROM report_export x
        LEFT JOIN report_schedule s ON s.id = x.schedule_id WHERE x.${where} AND x.deleted_at IS NULL`, [v])).rows[0];
      if (!e || e.user_id !== a.userId) throw new NotFoundException('Link not found');
      if (e.expires_at <= this.clock.now()) throw new GoneException({ message: 'This link has expired', code: 'link_expired' });
      if (!e.schedule_id || e.schedule_deleted) throw new GoneException({ message: 'The scheduled report no longer exists', code: 'source_gone' });
      return e;
    });
    if (!has(a, 'reports', 'export')) throw new ForbiddenException({ message: 'Needs reports:export', code: 'export_forbidden' });
    const src = await this.resolve(a, { reportId: e.report_id ?? undefined, catalogueKey: e.catalogue_key ?? undefined });
    const r = await this.engine.run(a, src.definition, { params: e.params, allRows: true });
    this.requireExport(a, r);
    const shown = await this.present(a, r, src.ownerId);
    const file = await renderRun(shown, e.format as ExportFormat, String(e.schedule_name ?? src.name), r.definition.groupBy.length ? 'groups' : 'rows');
    await this.db.tenantTx(a.tenantId, async (tx) => {
      await tx.query('UPDATE report_export SET downloads = downloads + 1, last_downloaded_at = $2, version = version + 1 WHERE id = $1', [e.id, this.clock.now()]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'report.downloaded', entity: 'report_export', entityId: e.id,
        diff: { scheduleId: e.schedule_id, period: e.period_key, dataset: r.dataset.key, format: e.format, rows: r.rowCount } });
    });
    return file;
  }

  // ---------- Filter-value redaction for non-owners (D176) ----------
  /**
   * A viewer who doesn't own a shared definition must not learn filter values they couldn't see themselves: values of filters
   * on columns hidden from them, and client-identifying values (client id/name, client master name/file no./PAN) naming a client
   * outside their clients:view scope, become "[hidden]". The filter still applies server-side.
   */
  async redactFor(a: RequestActor, raw: unknown, ownerId: string | null): Promise<unknown> {
    const d = raw as ReportDefinition;
    if (a.superAdmin || !d || ownerId === a.userId || !Array.isArray(d.filters) || !d.filters.length) return raw;
    const meta = datasetMeta(d.dataset); if (!meta) return raw;
    const hidden = this.engine.hidden(a, meta);
    const idCols = new Set(meta.key === 'clients' ? ['id', 'name', 'fileNo', 'pan'] : ['clientId', 'clientName']);
    const field: Record<string, string> = { id: 'id', clientId: 'id', name: 'name', clientName: 'name', fileNo: 'file_no', pan: 'pan' };
    const filters = await this.db.tenantTx(a.tenantId, async (tx) => {
      const out = [];
      for (const f of d.filters) {
        if (f.value === undefined || f.value === null) { out.push(f); continue; }
        let secret = hidden.has(f.column);
        if (!secret && idCols.has(f.column)) {
          const vals = (Array.isArray(f.value) ? f.value : [f.value]).map(String);
          const col = field[f.column]!;
          const p = new Params([vals]);
          const n = (await tx.query(`SELECT count(DISTINCT c.${col === 'id' ? 'id::text' : col})::int AS n FROM client c WHERE c.deleted_at IS NULL AND ${col === 'id' ? 'c.id::text' : `c.${col}`} = ANY($1::text[])
            AND ${clientScopeSql(a, 'clients', 'view', p)}`, p.values)).rows[0].n;
          secret = ['contains', 'starts_with'].includes(f.op) || n < new Set(vals).size;
        }
        out.push(secret ? { ...f, value: Array.isArray(f.value) ? f.value.map(() => '[hidden]') : '[hidden]' } : f);
      }
      return out;
    });
    return { ...d, filters };
  }
  /** A run result as shown to this viewer (definition + explanation redacted for non-owners). */
  async present<T extends RunResult>(a: RequestActor, r: T, ownerId: string | null): Promise<T> {
    if (ownerId === null || ownerId === a.userId) return r;
    const definition = await this.redactFor(a, r.definition, ownerId) as RunResult['definition'];
    return { ...r, definition, explanation: explainDefinition(definition) };
  }

  // ---------- Saved reports ----------
  list(a: RequestActor) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params();
      const rows = (await tx.query(`SELECT r.*, u.name AS owner_name FROM saved_report r LEFT JOIN app_user u ON u.id = r.owner_id WHERE r.deleted_at IS NULL AND ${this.visibleSql(a, p)}
        ORDER BY lower(r.name), r.id LIMIT 500`, p.values)).rows;
      return rows;
    }).then(async (rows) => ({ items: await Promise.all(rows.map((r) => this.shown(a, r))) }));
  }
  /** savedOut with the definition redacted for non-owners (D176). */
  private async shown(a: RequestActor, r: Record<string, unknown>) { return savedOut({ ...r, definition: await this.redactFor(a, r.definition, r.owner_id as string) }, a); }
  async get(a: RequestActor, id: string) { return this.shown(a, await this.db.tenantTx(a.tenantId, (tx) => this.savedRow(tx, a, id))); }
  async versions(a: RequestActor, id: string) {
    const { owner, rows } = await this.db.tenantTx(a.tenantId, async (tx) => {
      const r = await this.savedRow(tx, a, id);
      return { owner: r.owner_id as string, rows: (await tx.query(`SELECT report_version AS "reportVersion", name, definition, changed_by AS "changedBy", changed_at AS "changedAt" FROM saved_report_version WHERE report_id = $1 ORDER BY report_version DESC`, [id])).rows };
    });
    return { items: await Promise.all(rows.map(async (v) => ({ ...v, definition: await this.redactFor(a, v.definition, owner) }))) };
  }
  private async checkShare(tx: Tx, a: RequestActor, s: ShareIn) {
    if ((s.firm || (s.roles?.length ?? 0) > 0) && !firmPublisher(a)) throw new ForbiddenException({ message: 'Sharing with the firm or roles needs firm-wide reports:approve', code: 'forbidden' });
    if (s.roles?.length) {
      const known = new Set((await tx.query('SELECT key FROM role WHERE deleted_at IS NULL AND key = ANY($1)', [s.roles])).rows.map((r) => r.key));
      const bad = s.roles.filter((k) => !known.has(k)); if (bad.length) throw new BadRequestException({ message: `Unknown role ${bad.join(', ')}`, code: 'unknown_role' });
    }
    if (s.userIds?.length) {
      const ok = (await tx.query(`SELECT count(*)::int AS n FROM app_user WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL AND status = 'active' AND kind = 'staff'`, [[...new Set(s.userIds)]])).rows[0].n;
      if (ok !== new Set(s.userIds).size) throw new BadRequestException({ message: 'Unknown user', code: 'unknown_user' });
    }
  }
  async create(a: RequestActor, b: { name: string; description?: string | null; definition?: unknown; share?: ShareIn; source?: 'builder' | 'catalogue' | 'nl_query'; catalogueKey?: string | null }, tx0?: Tx) {
    const def = this.engine.check(a, b.definition);
    const { resolved: _r, ...stored } = def;
    const work = async (tx: Tx) => {
      if (b.share) await this.checkShare(tx, a, b.share);
      const id = uuidv7();
      await tx.query(`INSERT INTO saved_report (id, tenant_id, name, description, owner_id, definition, shared_firm, shared_roles, shared_user_ids, source, catalogue_key, updated_by, device_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$5,$12)`, [id, a.tenantId, b.name, b.description ?? null, a.userId, JSON.stringify(stored), !!b.share?.firm, b.share?.roles ?? [],
        [...new Set(b.share?.userIds ?? [])], b.source ?? 'builder', b.catalogueKey ?? null, a.deviceId]);
      await tx.query(`INSERT INTO saved_report_version (id, tenant_id, report_id, report_version, name, definition, changed_by, device_id) VALUES ($1,$2,$3,1,$4,$5,$6,$7)`,
        [uuidv7(), a.tenantId, id, b.name, JSON.stringify(stored), a.userId, a.deviceId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'report.saved', entity: 'saved_report', entityId: id,
        diff: { name: b.name, dataset: stored.dataset, source: b.source ?? 'builder', shared: !!(b.share?.firm || b.share?.roles?.length || b.share?.userIds?.length) } });
      return id;
    };
    const id = tx0 ? await work(tx0) : await this.db.tenantTx(a.tenantId, work);
    return tx0 ? { id } : this.get(a, id);
  }
  private requireOwner(a: RequestActor, r: Record<string, unknown>) {
    if (r.owner_id === a.userId || firmPublisher(a)) return;
    throw new ForbiddenException({ message: 'Only the owner edits a saved report', code: 'forbidden' });
  }
  async update(a: RequestActor, id: string, b: { name?: string; description?: string | null; definition?: unknown }) {
    const def = b.definition !== undefined ? this.engine.check(a, b.definition) : null;
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const r = await this.savedRow(tx, a, id, true);
      this.requireOwner(a, r);
      const stored = def ? (({ resolved: _r, ...x }) => x)(def) : null;
      const changed = !!stored && JSON.stringify(stored) !== JSON.stringify(r.definition);
      const ver = Number(r.current_version) + (changed ? 1 : 0);
      await tx.query(`UPDATE saved_report SET name = $2, description = $3, definition = $4, current_version = $5, updated_by = $6, device_id = $7, updated_at = now(), version = version + 1 WHERE id = $1`,
        [id, b.name ?? r.name, b.description === undefined ? r.description : b.description, JSON.stringify(stored ?? r.definition), ver, a.userId, a.deviceId]);
      if (changed) await tx.query(`INSERT INTO saved_report_version (id, tenant_id, report_id, report_version, name, definition, changed_by, device_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [uuidv7(), a.tenantId, id, ver, b.name ?? r.name, JSON.stringify(stored), a.userId, a.deviceId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'report.updated', entity: 'saved_report', entityId: id, diff: { fields: Object.keys(b), definitionChanged: changed, reportVersion: ver } });
    });
    return this.get(a, id);
  }
  async share(a: RequestActor, id: string, s: ShareIn) {
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const r = await this.savedRow(tx, a, id, true);
      this.requireOwner(a, r);
      await this.checkShare(tx, a, s);
      await tx.query(`UPDATE saved_report SET shared_firm = $2, shared_roles = $3, shared_user_ids = $4, updated_by = $5, updated_at = now(), version = version + 1 WHERE id = $1`,
        [id, !!s.firm, s.roles ?? [], [...new Set(s.userIds ?? [])], a.userId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'report.shared', entity: 'saved_report', entityId: id, diff: { firm: !!s.firm, roles: s.roles ?? [], users: (s.userIds ?? []).length } });
    });
    return this.get(a, id);
  }
  async remove(a: RequestActor, id: string) {
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const r = await this.savedRow(tx, a, id, true);
      this.requireOwner(a, r);
      await tx.query('UPDATE saved_report SET deleted_at = now(), updated_by = $2, version = version + 1 WHERE id = $1', [id, a.userId]);
      // Schedules of a deleted report stop (they can't run without it).
      await tx.query(`UPDATE report_schedule SET enabled = false, updated_by = $2, version = version + 1, updated_at = now() WHERE report_id = $1 AND deleted_at IS NULL`, [id, a.userId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'report.deleted', entity: 'saved_report', entityId: id, diff: { name: r.name } });
    });
  }

  // ---------- Dashboards ----------
  private dashVisibleSql(a: RequestActor, p: Params) {
    if (a.superAdmin || firmPublisher(a)) return `(d.role_key IS NOT NULL OR d.owner_id = ${p.add(a.userId)}::uuid)`;
    return `(d.owner_id = ${p.add(a.userId)}::uuid OR d.role_key = ANY(${p.add(a.roles.map((r) => r.key))}::text[]))`;
  }
  private async dashRow(tx: Tx, a: RequestActor, id: string, lock = false) {
    const p = new Params([id]);
    const r = (await tx.query(`SELECT d.* FROM dashboard d WHERE d.id = $1 AND d.deleted_at IS NULL AND ${this.dashVisibleSql(a, p)}${lock ? ' FOR UPDATE' : ''}`, p.values)).rows[0];
    if (!r) throw new NotFoundException('Dashboard not found');
    return r as Record<string, unknown>;
  }
  private async checkWidgets(tx: Tx, a: RequestActor, raw: unknown): Promise<DashboardWidget[]> {
    const p = dashboardWidgetsSchema.safeParse(raw);
    if (!p.success) throw new BadRequestException({ message: 'Invalid widgets', code: 'invalid_widgets', issues: p.error.issues });
    for (const w of p.data) {
      if (w.catalogueKey && !catalogueReport(w.catalogueKey)) throw new BadRequestException({ message: `Unknown catalogue report ${w.catalogueKey}`, code: 'invalid_widgets' });
      if (w.reportId) await this.savedRow(tx, a, w.reportId);
    }
    return p.data;
  }
  dashboards(a: RequestActor) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params();
      const rows = (await tx.query(`SELECT d.* FROM dashboard d WHERE d.deleted_at IS NULL AND ${this.dashVisibleSql(a, p)} ORDER BY d.role_key NULLS LAST, lower(d.name), d.id`, p.values)).rows;
      const def = (await tx.query('SELECT dashboard_id FROM dashboard_default WHERE user_id = $1 AND deleted_at IS NULL', [a.userId])).rows[0]?.dashboard_id ?? null;
      return { items: rows.map((r) => dashOut(r, a)), defaultId: def };
    });
  }
  getDashboard(a: RequestActor, id: string) { return this.db.tenantTx(a.tenantId, async (tx) => dashOut(await this.dashRow(tx, a, id), a)); }
  async createDashboard(a: RequestActor, b: { name: string; widgets: unknown; roleKey?: string | null }) {
    const id = await this.db.tenantTx(a.tenantId, async (tx) => {
      if (b.roleKey) {
        requireFirmWide(a, 'reports', 'approve');
        if (!(await tx.query('SELECT 1 FROM role WHERE key = $1 AND deleted_at IS NULL', [b.roleKey])).rowCount) throw new BadRequestException({ message: 'Unknown role', code: 'unknown_role' });
        if ((await tx.query('SELECT 1 FROM dashboard WHERE role_key = $1 AND deleted_at IS NULL', [b.roleKey])).rowCount) throw new BadRequestException({ message: 'That role already has a default dashboard', code: 'role_dashboard_exists' });
      }
      const widgets = await this.checkWidgets(tx, a, b.widgets);
      const id = uuidv7();
      await tx.query(`INSERT INTO dashboard (id, tenant_id, name, owner_id, role_key, widgets, updated_by, device_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, a.tenantId, b.name, b.roleKey ? null : a.userId, b.roleKey ?? null, JSON.stringify(widgets), a.userId, a.deviceId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'dashboard.created', entity: 'dashboard', entityId: id, diff: { name: b.name, roleKey: b.roleKey ?? null, widgets: widgets.length } });
      return id;
    });
    return this.getDashboard(a, id);
  }
  async updateDashboard(a: RequestActor, id: string, b: { name?: string; widgets?: unknown }) {
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const d = await this.dashRow(tx, a, id, true);
      if (d.role_key ? !firmPublisher(a) : d.owner_id !== a.userId) throw new ForbiddenException({ message: d.role_key ? 'Needs firm-wide reports:approve' : 'Only the owner edits a dashboard', code: 'forbidden' });
      const widgets = b.widgets !== undefined ? await this.checkWidgets(tx, a, b.widgets) : d.widgets;
      await tx.query('UPDATE dashboard SET name = $2, widgets = $3, updated_by = $4, device_id = $5, updated_at = now(), version = version + 1 WHERE id = $1', [id, b.name ?? d.name, JSON.stringify(widgets), a.userId, a.deviceId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'dashboard.updated', entity: 'dashboard', entityId: id, diff: { fields: Object.keys(b) } });
    });
    return this.getDashboard(a, id);
  }
  async removeDashboard(a: RequestActor, id: string) {
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const d = await this.dashRow(tx, a, id, true);
      if (d.role_key ? !firmPublisher(a) : d.owner_id !== a.userId) throw new ForbiddenException({ message: 'Not allowed', code: 'forbidden' });
      await tx.query('UPDATE dashboard SET deleted_at = now(), updated_by = $2, version = version + 1 WHERE id = $1', [id, a.userId]);
      await tx.query('DELETE FROM dashboard_default WHERE dashboard_id = $1', [id]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'dashboard.deleted', entity: 'dashboard', entityId: id, diff: { name: d.name } });
    });
  }
  async setDefault(a: RequestActor, dashboardId: string | null) {
    await this.db.tenantTx(a.tenantId, async (tx) => {
      if (dashboardId) await this.dashRow(tx, a, dashboardId);
      if (dashboardId) await tx.query(`INSERT INTO dashboard_default (tenant_id, user_id, dashboard_id, updated_by, device_id) VALUES ($1,$2,$3,$2,$4)
        ON CONFLICT (tenant_id, user_id) DO UPDATE SET dashboard_id = $3, deleted_at = NULL, updated_at = now(), version = dashboard_default.version + 1`, [a.tenantId, a.userId, dashboardId, a.deviceId]);
      else await tx.query('DELETE FROM dashboard_default WHERE user_id = $1', [a.userId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'dashboard.default_set', entity: 'dashboard', entityId: dashboardId, diff: { dashboardId } });
    });
    return this.defaultDashboard(a);
  }
  /** The viewer's dashboard: personal default → their role's default (firm-edited) → the built-in role template → none. */
  defaultDashboard(a: RequestActor) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const mine = (await tx.query('SELECT dashboard_id FROM dashboard_default WHERE user_id = $1 AND deleted_at IS NULL', [a.userId])).rows[0]?.dashboard_id;
      if (mine) { try { return { ...dashOut(await this.dashRow(tx, a, mine), a), origin: 'user' }; } catch { /* no longer visible: fall through */ } }
      const roles = [...a.roles.map((r) => r.key)].sort((x, y) => (ROLE_ORDER.indexOf(x) + 99) % 99 - (ROLE_ORDER.indexOf(y) + 99) % 99);
      for (const k of roles) {
        const d = (await tx.query('SELECT * FROM dashboard WHERE role_key = $1 AND deleted_at IS NULL', [k])).rows[0];
        if (d) return { ...dashOut(d, a), origin: 'role' };
      }
      for (const k of roles) { const t = ROLE_DASHBOARD_TEMPLATES[k]; if (t) return { id: null, name: t.name, ownerId: null, roleKey: k, widgets: t.widgets, canEdit: false, origin: 'template' }; }
      return { id: null, name: null, ownerId: null, roleKey: null, widgets: [] as DashboardWidget[], canEdit: false, origin: 'none' };
    });
  }
  /** Every widget runs AS THE VIEWER; a widget the viewer can't use answers with an error code instead of failing the dashboard. */
  /** Per dashboard request: total wall-time and scanned-row budget (D173); widgets past it answer `budget_exceeded`. */
  dashboardBudget = { ms: Number(process.env.DASHBOARD_BUDGET_MS ?? 20_000), rows: Number(process.env.DASHBOARD_BUDGET_ROWS ?? 60_000) };
  async widgetData(a: RequestActor, widgets: DashboardWidget[]) {
    const out = [];
    const started = Date.now(); let rows = 0;
    for (const w of widgets) {
      if (Date.now() - started > this.dashboardBudget.ms || rows > this.dashboardBudget.rows) { out.push({ id: w.id, kind: w.kind, title: w.title, error: 'budget_exceeded' }); continue; }
      try {
        const src = await this.resolve(a, { reportId: w.reportId, catalogueKey: w.catalogueKey });
        const r = await this.present(a, await this.engine.run(a, src.definition, { params: w.params, pageSize: w.kind === 'table' ? 10 : 1 }), src.ownerId);
        rows += r.rowCount;
        const alias = w.value ?? r.definition.aggregates[0]?.as ?? 'count';
        out.push({ id: w.id, kind: w.kind, title: w.title, dataset: r.dataset.key, explanation: r.explanation, hiddenColumns: r.hiddenColumns, asOf: r.asOf,
          ...(w.kind === 'kpi' ? { value: r.totals[alias] ?? null, valueKey: alias, type: r.columns.find((c) => alias.endsWith(`_${c.key}`))?.type ?? (alias === 'count' ? 'int' : null) } : {}),
          ...(w.kind === 'chart' ? { chart: w.chart ?? r.chart?.type ?? 'bar', groups: r.groups.slice(0, 24), totals: r.totals } : {}),
          ...(w.kind === 'table' ? { columns: r.columns, rows: r.rows, rowCount: r.rowCount } : {}) });
      } catch (e) {
        const code = (e as { response?: { code?: string } }).response?.code ?? ((e as { status?: number }).status === 404 ? 'not_found' : 'error');
        out.push({ id: w.id, kind: w.kind, title: w.title, error: code });
      }
    }
    return out;
  }
  async dashboardData(a: RequestActor, id: string | 'default') {
    const d = id === 'default' ? await this.defaultDashboard(a) : await this.getDashboard(a, id);
    return { dashboard: d, widgets: await this.widgetData(a, d.widgets as DashboardWidget[]) };
  }
}

export const shareSchema = z.object({ firm: z.boolean().optional(), roles: z.array(z.string().regex(/^[a-z_]{2,40}$/)).max(20).optional(), userIds: z.array(z.string().uuid()).max(200).optional() }).strict();
