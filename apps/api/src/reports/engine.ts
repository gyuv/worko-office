import { BadRequestException, ForbiddenException, HttpException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import {
  aggregate, canSeeCost, columnMeta, compileFilters, drillDefinition, effectiveScope, explainDefinition, groupRows, hiddenColumns, hiddenFieldsOf, matchesFilters, referencedColumns,
  REPORT_LIMITS, sortRows, validateDefinition, type AggValues, type ColumnType, type DatasetMeta, type RefType, type ReportGroup, type ResolvedFilter, type ValidDefinition,
} from '@worko/domain';
import type { RequestActor } from '../auth/context.js';
import { BillingAutoService } from '../billing/auto.service.js';
import { BillingReportsService } from '../billing/reports.service.js';
import { Params } from '../clients/scope.js';
import { Clock } from '../common/clock.js';
import { ComplianceService } from '../compliance/compliance.service.js';
import { DbService } from '../db/db.service.js';
import { AttendanceService } from '../hr/attendance.service.js';
import { TimeReportsService } from '../time/reports.service.js';
import { TimeService } from '../time/time.service.js';
import { normalise, serverDatasets, type Ctx, type Row, type ServerDataset, type SqlDataset } from './datasets.js';

export type RunOptions = { page?: number; pageSize?: number; drill?: Record<string, unknown>; params?: Record<string, string | number>; allRows?: boolean };
export type RunResult = {
  dataset: { key: string; label: string; module: string };
  definition: Omit<ValidDefinition, 'resolved'>; explanation: string;
  columns: Array<{ key: string; label: string; type: ColumnType }>; hiddenColumns: string[];
  params: Record<string, string | number>; asOf: string;
  rows: Array<{ values: Row; refs: Partial<Record<RefType, string>> }>; rowCount: number; page: number; pageSize: number;
  totals: AggValues; groups: ReportGroup[]; groupsTruncated: boolean; chart: ValidDefinition['chart'] | null;
};

const invalid = (issues: string[]) => new BadRequestException({ message: 'Invalid report definition', code: 'invalid_definition', issues });
const hasAny = (a: RequestActor, m: Parameters<typeof effectiveScope>[1], x: Parameters<typeof effectiveScope>[2]) => !!a.superAdmin || (effectiveScope(a, m, x)?.scope ?? 'none') !== 'none';

/**
 * Compiles and runs report definitions (M17, D160–D163): validation against the fixed catalogue → permission (reports:view +
 * the dataset's source module) → column access (cost / field hiding) → parameterised SQL with the actor's row scope inside a
 * READ ONLY transaction with a statement timeout → in-memory group/aggregate/sort/page. Every caller (builder, saved and shared
 * reports, dashboards, schedules, NL query, exports) goes through `run` AS THE VIEWER — never as the report's owner.
 */
@Injectable()
export class ReportEngine {
  /** Hard limits (instance fields so tests can lower them). */
  /** = REPORT_LIMITS.maxRows: a definition's `limit` can never exceed what one run may scan. */
  maxScan = Number(process.env.REPORT_MAX_SCAN ?? REPORT_LIMITS.maxRows);
  timeoutMs = Number(process.env.REPORT_TIMEOUT_MS ?? 5_000);
  private readonly ds: Record<string, ServerDataset>;

  constructor(private db: DbService, private clock: Clock, billingAuto: BillingAutoService, billingReports: BillingReportsService, timeReports: TimeReportsService, time: TimeService,
    compliance: ComplianceService, attendance: AttendanceService) {
    this.ds = serverDatasets({ billingAuto, billingReports, timeReports, time, compliance, attendance });
  }

  /** Datasets the actor may use, with the columns they would see (the builder's and the NL query's catalogue). */
  allowedDatasets(a: RequestActor, metas: readonly DatasetMeta[]) {
    return metas.filter((m) => this.mayUse(a, m)).map((m) => ({ meta: m, hidden: this.hidden(a, m) }));
  }
  mayUse(a: RequestActor, m: DatasetMeta) { return hasAny(a, 'reports', 'view') && hasAny(a, m.module, 'view') && (m.alsoRequires ?? []).every((x) => hasAny(a, x, 'view')) && !!this.ds[m.key]; }
  hidden(a: RequestActor, m: DatasetMeta) { return hiddenColumns(m, { canSeeCost: canSeeCost(a), hiddenFields: hiddenFieldsOf(a) }); }

  /** Validates (and checks permissions) without running — for saving reports/widgets. */
  check(a: RequestActor, raw: unknown): ValidDefinition {
    const v = validateDefinition(raw, this.clock.todayIst());
    if (!v.ok) throw invalid(v.issues);
    if (!this.mayUse(a, v.meta)) throw new ForbiddenException({ message: `Needs reports:view and ${[v.meta.module, ...(v.meta.alsoRequires ?? [])].join(', ')}:view`, code: 'dataset_forbidden' });
    return v.def;
  }

  async run(a: RequestActor, raw: unknown, o: RunOptions = {}): Promise<RunResult> {
    const today = this.clock.todayIst();
    let base = raw as Record<string, unknown>;
    if (o.params && base && typeof base === 'object') base = { ...base, params: { ...((base.params as object) ?? {}), ...o.params } };
    let v = validateDefinition(base, today);
    if (!v.ok) throw invalid(v.issues);
    if (o.drill) {
      const keys = Object.keys(o.drill);
      if (!keys.length || keys.some((k) => !v.ok || !v.def.groupBy.includes(k))) throw invalid(['drill: keys must be group-by columns']);
      v = validateDefinition(drillDefinition(v.def, o.drill), today);
      if (!v.ok) throw invalid(v.issues);
    }
    const { def, meta } = v;
    if (!this.mayUse(a, meta)) throw new ForbiddenException({ message: `Needs reports:view and ${[meta.module, ...(meta.alsoRequires ?? [])].join(', ')}:view`, code: 'dataset_forbidden' });

    // Column access: hidden columns silently drop out of the selection/aggregates; using them to filter, group or sort is refused.
    const hidden = this.hidden(a, meta);
    const used = [...def.filters.map((f) => f.column), ...def.groupBy, ...def.sort.map((s) => s.by)].filter((k) => hidden.has(k));
    if (used.length) throw new ForbiddenException({ message: `Not allowed to filter, group or sort by ${[...new Set(used)].join(', ')}`, code: 'column_hidden', columns: [...new Set(used)] });
    const hiddenUsed = referencedColumns(def, meta).filter((k) => hidden.has(k));
    const columns = def.columns.filter((k) => !hidden.has(k));
    const aggs = def.aggregates.filter((x) => !x.column || !hidden.has(x.column));
    const shownKey = (k?: string) => (k && (aggs.some((x) => x.as === k) || (columnMeta(meta, k) && !hidden.has(k))) ? k : undefined);
    const visible: ValidDefinition = { ...def, columns, aggregates: aggs, chart: def.chart && { ...def.chart, x: shownKey(def.chart.x), y: shownKey(def.chart.y) } };

    const rows = await this.load(a, meta, visible, today);
    if (rows.length > this.maxScan) throw new UnprocessableEntityException({ message: `More than ${this.maxScan} rows — add filters`, code: 'too_many_rows', limit: this.maxScan });

    const totals = { count: rows.length, ...aggregate(rows, aggs, meta) };
    let groups = groupRows(rows, visible, meta);
    if (def.limit && groups.length) groups = groups.slice(0, def.limit);
    const groupsTruncated = groups.length > REPORT_LIMITS.maxGroups;
    if (groupsTruncated) groups = groups.slice(0, REPORT_LIMITS.maxGroups);
    const rowSort = def.sort.filter((s) => !!columnMeta(meta, s.by));
    let sorted = sortRows(rows, rowSort, (r, k) => r[k]);
    if (def.limit) sorted = sorted.slice(0, def.limit);
    const pageSize = o.allRows ? Math.max(1, sorted.length) : Math.min(o.pageSize ?? 100, REPORT_LIMITS.maxPageSize);
    const page = o.allRows ? 1 : Math.max(1, o.page ?? 1);
    const refCols = meta.columns.filter((x) => x.ref);
    const out = sorted.slice((page - 1) * pageSize, page * pageSize).map((r) => {
      const refs: Partial<Record<RefType, string>> = {};
      if (meta.entity && r.id) refs[meta.entity] = r.id as string;
      for (const col of refCols) if (r[col.key] && !hidden.has(col.key) && !refs[col.ref!]) refs[col.ref!] = r[col.key] as string;
      return { values: Object.fromEntries(columns.map((k) => [k, r[k] ?? null])), refs };
    });
    const { resolved: _r, ...shown } = visible;
    return {
      dataset: { key: meta.key, label: meta.label, module: meta.module }, definition: shown, explanation: explainDefinition(shown),
      columns: columns.map((k) => { const m = columnMeta(meta, k)!; return { key: k, label: m.label, type: m.type }; }), hiddenColumns: [...new Set(hiddenUsed)],
      params: def.params, asOf: today, rows: out, rowCount: sorted.length, page, pageSize, totals, groups, groupsTruncated, chart: visible.chart ?? null,
    };
  }

  /** Rows of the dataset after ALL filters (scope always applied), with every referenced column normalised. */
  private async load(a: RequestActor, meta: DatasetMeta, def: ValidDefinition, today: string): Promise<Row[]> {
    const ds = this.ds[meta.key]!;
    const need = new Set([...referencedColumns(def, meta), ...meta.columns.filter((x) => x.ref).map((x) => x.key)]);
    if (ds.kind === 'service' && ds.before) await ds.before(a);
    // Everything below runs on ONE connection (service datasets use their *Tx variants): no nested pool checkouts (D173).
    return this.db.readOnlyTx(a.tenantId, async (tx) => {
      await tx.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(this.timeoutMs))}`);
      const p = new Params(); let todayPh: string | null = null;
      const c: Ctx = { a, tx, p, today, params: def.params, todaySql: () => (todayPh ??= p.add(today)) };
      try {
        if (ds.kind === 'service') {
          const rows = (await ds.load(c)).map((r) => Object.fromEntries(meta.columns.map((m) => [m.key, normalise(r[m.key], m.type)])));
          return rows.filter((r) => matchesFilters(r, def.resolved, meta));
        }
        return await this.sql(ds, c, meta, def, need);
      } catch (e) {
        if ((e as { code?: string }).code === '57014') throw new HttpException({ message: 'The report took too long — narrow it with filters', code: 'report_timeout' }, 503);
        throw e;
      }
    });
  }

  private async sql(ds: SqlDataset, c: Ctx, meta: DatasetMeta, def: ValidDefinition, need: Set<string>): Promise<Row[]> {
    const memo = new Map<string, string>();
    const expr = (k: string) => { const e = ds.cols[k]; if (e === undefined) return undefined; if (!memo.has(k)) memo.set(k, typeof e === 'function' ? e(c) : e); return memo.get(k)!; };
    for (const [, dv] of Object.entries(ds.derived ?? {}).filter(([k]) => need.has(k))) for (const n of dv.needs) need.add(n);
    const where = ds.where(c);
    const sqlFilters: ResolvedFilter[] = []; const memFilters: ResolvedFilter[] = [];
    for (const f of def.resolved) (ds.cols[f.column] !== undefined ? sqlFilters : memFilters).push(f);
    where.push(...compileFilters(sqlFilters, (k) => { const e = expr(k); const m = columnMeta(meta, k); return e && m ? { expr: e, type: m.type } : undefined; }, (v) => c.p.add(v)));
    const select = [...need].filter((k) => ds.cols[k] !== undefined).map((k) => {
      const m = columnMeta(meta, k)!; const e = expr(k)!;
      return `${m.type === 'date' ? `to_char(${e}, 'YYYY-MM-DD')` : e} AS "${k}"`;
    });
    if (!select.length) select.push('1 AS "_"');
    const q = `SELECT ${select.join(', ')} FROM ${ds.from} WHERE ${where.map((w) => `(${w})`).join(' AND ')} ORDER BY ${ds.order} LIMIT ${this.maxScan + 1}`;
    const raw = (await c.tx.query(q, c.p.values)).rows as Row[];
    if (raw.length > this.maxScan) throw new UnprocessableEntityException({ message: `More than ${this.maxScan} rows — add filters`, code: 'too_many_rows', limit: this.maxScan });
    const extra = ds.prepare ? await ds.prepare(c) : undefined;
    const rows = raw.map((r) => {
      const o: Row = {};
      for (const k of need) { const m = columnMeta(meta, k); if (m && k in r) o[k] = normalise(r[k], m.type); }
      for (const [k, dv] of Object.entries(ds.derived ?? {})) if (need.has(k)) o[k] = normalise(dv.fn(o, extra, c), columnMeta(meta, k)!.type);
      return o;
    });
    return memFilters.length ? rows.filter((r) => matchesFilters(r, memFilters, meta)) : rows;
  }
}
