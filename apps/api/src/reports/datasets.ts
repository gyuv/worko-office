import { AGEING_BUCKETS, ageBucket, costPaise, effectiveScope, type ColumnType } from '@worko/domain';
import type { RequestActor } from '../auth/context.js';
import { ruleVisibleSql } from '../automation/automation.service.js';
import type { BillingAutoService } from '../billing/auto.service.js';
import { scopeSql as billingScopeSql } from '../billing/common.js';
import type { BillingReportsService } from '../billing/reports.service.js';
import { clientScopeSql, type Params } from '../clients/scope.js';
import type { ComplianceService } from '../compliance/compliance.service.js';
import type { Tx } from '../db/db.service.js';
import type { AttendanceService } from '../hr/attendance.service.js';
import { personScopeSql } from '../hr/common.js';
import { leadScopeSql } from '../leads/leads.service.js';
import { visibleSql } from '../practice/common.js';
import { dscScopeSql } from '../practice/scope.js';
import { taskScopeSql } from '../tasks/scope.js';
import { costRates, type TimeReportsService } from '../time/reports.service.js';
import type { TimeService } from '../time/time.service.js';

export type Row = Record<string, unknown>;
/** Per-run context. `p` collects the query parameters; `today` is the IST business date (injectable clock). */
export type Ctx = { a: RequestActor; tx: Tx; p: Params; today: string; params: Record<string, string | number>; todaySql: () => string };
type Expr = string | ((c: Ctx) => string);
/**
 * A whitelisted SQL dataset: FROM + mandatory WHERE (soft-delete + the source module's ROW SCOPE for the actor) + column
 * expressions. Definitions only ever pick keys of `cols`; values travel as parameters. `derived` columns are computed in
 * code after the query (their filters run in memory with the same semantics).
 */
export type SqlDataset = { kind: 'sql'; from: string; where: (c: Ctx) => string[]; order: string; cols: Record<string, Expr>;
  derived?: Record<string, { needs: string[]; fn: (r: Row, x: unknown, c: Ctx) => unknown }>; prepare?: (c: Ctx) => Promise<unknown> };
/** A dataset produced by the existing operational report service (so numbers reconcile by construction). */
export type ServiceDataset = { kind: 'service'; load: (c: Ctx) => Promise<Row[]> };
export type ServerDataset = SqlDataset | ServiceDataset;

export type Deps = { billingAuto: BillingAutoService; billingReports: BillingReportsService; timeReports: TimeReportsService; time: TimeService; compliance: ComplianceService; attendance: AttendanceService };

const ist = (e: string) => `to_char((${e}) AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM')`;
const firmWide = (a: RequestActor, ...grants: Array<[Parameters<typeof effectiveScope>[1], Parameters<typeof effectiveScope>[2]]>) => !!a.superAdmin || grants.some(([m, x]) => effectiveScope(a, m, x)?.scope === 'all');

export function serverDatasets(d: Deps): Record<string, ServerDataset> {
  const overdue = (c: Ctx) => `(t.outcome IS NULL AND t.status NOT IN ('done','cancelled') AND COALESCE(t.act_by, t.statutory_due) < ${c.todaySql()}::date)`;
  return {
    tasks: { kind: 'sql', order: 't.statutory_due NULLS LAST, t.id',
      from: `task t LEFT JOIN client c ON c.id = t.client_id LEFT JOIN service_type s ON s.id = t.service_type_id LEFT JOIN app_user ua ON ua.id = t.assignee_id
        LEFT JOIN app_user um ON um.id = t.manager_id LEFT JOIN app_user ur ON ur.id = t.reviewer_id`,
      where: (c) => ['t.deleted_at IS NULL', '(t.client_id IS NULL OR c.deleted_at IS NULL)', taskScopeSql(c.a, 'view', c.p, 't', 'c')],
      cols: { id: 't.id', title: 't.title', clientId: 'c.id', clientName: 'c.name', serviceName: 's.name', serviceCategory: 's.category', status: 't.status', priority: 't.priority',
        outcome: 't.outcome', periodKey: 't.period_key', statutoryDue: 't.statutory_due', actBy: 't.act_by', completedAt: 't.completed_at', assigneeId: 't.assignee_id', assigneeName: 'ua.name',
        managerName: 'um.name', reviewerName: 'ur.name', overdue, daysOverdue: (c) => `CASE WHEN ${overdue(c)} THEN ${c.todaySql()}::date - COALESCE(t.act_by, t.statutory_due) END`, estimateMinutes: 't.estimate_minutes' } },

    // Same visibility and name masking as Time → Entries (D84): client/task names only where the viewer may see them.
    time_entries: { kind: 'sql', order: 'x.work_date, x.id', from: `time_entry x ${d.time.joins}`,
      where: (c) => ['x.deleted_at IS NULL', d.time.visibleSql(c.a, c.p)],
      cols: { id: 'x.id', workDate: 'x.work_date', week: "date_trunc('week', x.work_date)::date", month: "to_char(x.work_date, 'YYYY-MM')", userId: 'x.user_id', userName: 'u.name',
        clientId: (c) => `CASE WHEN c.id IS NOT NULL AND ${clientScopeSql(c.a, 'clients', 'view', c.p, 'c')} THEN c.id END`,
        clientName: (c) => `CASE WHEN c.id IS NOT NULL AND ${clientScopeSql(c.a, 'clients', 'view', c.p, 'c')} THEN c.name END`,
        taskId: (c) => `CASE WHEN t.id IS NOT NULL AND ${taskScopeSql(c.a, 'view', c.p, 't', 'tc')} THEN t.id END`,
        taskTitle: (c) => `CASE WHEN t.id IS NOT NULL AND ${taskScopeSql(c.a, 'view', c.p, 't', 'tc')} THEN t.title END`,
        minutes: 'x.minutes', billable: 'x.billable', status: 'x.status' },
      prepare: (c) => costRates(c.tx),
      derived: { costPaise: { needs: ['userId', 'workDate', 'minutes'], fn: (r, rate) => costPaise(Number(r.minutes), (rate as Awaited<ReturnType<typeof costRates>>)(r.userId as string, r.workDate as string)) } } },

    invoices: { kind: 'sql', order: 'i.issue_date NULLS LAST, i.number, i.id',
      from: `invoice i JOIN client c ON c.id = i.client_id LEFT JOIN firm_entity e ON e.id = i.entity_id LEFT JOIN app_user up ON up.id = c.partner_id LEFT JOIN branch b ON b.id = c.branch_id`,
      where: (c) => ['i.deleted_at IS NULL', 'c.deleted_at IS NULL', billingScopeSql(c.a, 'billing', 'view', c.p)],
      cols: { id: 'i.id', number: 'i.number', kind: 'i.kind', status: 'i.status', issueDate: 'i.issue_date', issueMonth: "to_char(i.issue_date, 'YYYY-MM')", dueDate: 'i.due_date',
        clientId: 'c.id', clientName: 'c.name', entityName: 'e.name', partnerName: 'up.name', branchName: 'b.name', taxablePaise: 'i.taxable_paise', cgstPaise: 'i.cgst_paise',
        sgstPaise: 'i.sgst_paise', igstPaise: 'i.igst_paise', totalPaise: 'i.total_paise', balancePaise: 'i.balance_paise',
        daysPastDue: (c) => `CASE WHEN i.balance_paise > 0 AND i.status IN ('issued','partially_paid') THEN GREATEST(0, ${c.todaySql()}::date - i.due_date) END` } },

    invoice_lines: { kind: 'sql', order: 'i.issue_date NULLS LAST, i.number, l.sort, l.id',
      from: `invoice_line l JOIN invoice i ON i.id = l.invoice_id JOIN client c ON c.id = i.client_id LEFT JOIN service_type s ON s.id = l.service_type_id
        LEFT JOIN app_user up ON up.id = c.partner_id LEFT JOIN branch b ON b.id = c.branch_id`,
      where: (c) => ['i.deleted_at IS NULL', 'c.deleted_at IS NULL', billingScopeSql(c.a, 'billing', 'view', c.p)],
      cols: { id: 'i.id', number: 'i.number', kind: 'i.kind', status: 'i.status', issueDate: 'i.issue_date', issueMonth: "to_char(i.issue_date, 'YYYY-MM')", clientId: 'c.id', clientName: 'c.name',
        serviceName: 's.name', serviceCategory: 's.category', description: 'l.description', reimbursement: 'l.reimbursement', partnerName: 'up.name', branchName: 'b.name',
        taxablePaise: 'l.taxable_paise', totalPaise: 'l.total_paise' } },

    receipts: { kind: 'sql', order: 'r.received_on, r.number, r.id', from: 'receipt r JOIN client c ON c.id = r.client_id',
      where: (c) => ['r.deleted_at IS NULL', 'c.deleted_at IS NULL', billingScopeSql(c.a, 'receipts', 'view', c.p)],
      cols: { id: 'r.id', number: 'r.number', receivedOn: 'r.received_on', receivedMonth: "to_char(r.received_on, 'YYYY-MM')", clientId: 'c.id', clientName: 'c.name', mode: 'r.mode',
        amountPaise: 'r.amount_paise', tdsPaise: 'r.tds_paise', allocatedPaise: 'r.allocated_paise', unallocatedPaise: 'r.unallocated_paise' } },

    clients: { kind: 'sql', order: 'lower(c.name), c.id',
      from: 'client c LEFT JOIN branch b ON b.id = c.branch_id LEFT JOIN app_user up ON up.id = c.partner_id LEFT JOIN app_user um ON um.id = c.manager_id',
      where: (c) => ['c.deleted_at IS NULL', clientScopeSql(c.a, 'clients', 'view', c.p)],
      cols: { id: 'c.id', fileNo: 'c.file_no', name: 'c.name', entityType: 'c.entity_type', status: 'c.status', pan: 'c.pan', email: 'c.email', phone: 'c.phone', branchName: 'b.name',
        partnerName: 'up.name', managerName: 'um.name', createdAt: 'c.created_at' } },

    notices: { kind: 'sql', order: 'n.received_on, n.id', from: 'notice n JOIN client c ON c.id = n.client_id LEFT JOIN app_user ua ON ua.id = n.assignee_id',
      where: (c) => ['n.deleted_at IS NULL', 'c.deleted_at IS NULL', visibleSql(c.a, 'notices', c.p)],
      cols: { id: 'n.id', title: 'n.title', clientId: 'c.id', clientName: 'c.name', authority: 'n.authority', level: 'n.level', section: 'n.section', status: 'n.status', receivedOn: 'n.received_on',
        responseDue: 'n.response_due', ageDays: (c) => `${c.todaySql()}::date - n.received_on`, demandPaise: 'n.demand_paise', assigneeName: 'ua.name',
        overdue: (c) => `(n.status IN ('received','under_review','drafting') AND n.response_due IS NOT NULL AND n.response_due < ${c.todaySql()}::date)` },
      derived: { ageBucket: { needs: ['receivedOn'], fn: (r, _x, c) => (r.receivedOn ? ageBucket(r.receivedOn as string, c.today) : null) } } },

    leads: { kind: 'sql', order: 'l.created_at, l.id', from: 'lead l LEFT JOIN app_user uo ON uo.id = l.owner_id',
      where: (c) => ['l.deleted_at IS NULL', leadScopeSql(c.a, 'view', c.p, 'l')],
      cols: { id: 'l.id', name: 'l.name', company: 'l.company', stage: 'l.stage', source: 'l.source', ownerName: 'uo.name', expectedValuePaise: 'l.expected_value_paise',
        converted: '(l.converted_at IS NOT NULL)', createdAt: 'l.created_at', createdMonth: ist('l.created_at'), email: 'l.email', phone: 'l.phone', pan: 'l.pan' } },

    proposals: { kind: 'sql', order: 'x.created_at, x.id', from: 'proposal x JOIN lead l ON l.id = x.lead_id',
      where: (c) => ['x.deleted_at IS NULL', 'l.deleted_at IS NULL', leadScopeSql(c.a, 'view', c.p, 'l')],
      cols: { id: 'x.id', number: 'x.number', title: 'x.title', leadId: 'l.id', leadName: 'l.name', status: 'x.status', currentVersion: 'x.current_version', sentAt: 'x.sent_at',
        decidedAt: 'x.decided_at', converted: '(x.converted_at IS NOT NULL)' } },

    leave: { kind: 'sql', order: 'x.from_date, x.id', from: 'leave_request x JOIN app_user u ON u.id = x.user_id LEFT JOIN leave_type lt ON lt.id = x.leave_type_id',
      where: (c) => ['x.deleted_at IS NULL', personScopeSql(c.a, 'hr', 'view', c.p)],
      cols: { id: 'x.id', userId: 'x.user_id', userName: 'u.name', leaveType: 'lt.name', fromDate: 'x.from_date', toDate: 'x.to_date', days: 'x.days', approvedDays: 'x.approved_days', status: 'x.status' } },

    expenses: { kind: 'sql', order: 'x.created_at, x.id', from: 'expense_claim x JOIN app_user u ON u.id = x.user_id',
      where: (c) => ['x.deleted_at IS NULL', personScopeSql(c.a, 'hr', 'view', c.p)],
      cols: { id: 'x.id', userId: 'x.user_id', userName: 'u.name', title: 'x.title', status: 'x.status', submittedAt: 'x.submitted_at', submittedMonth: ist('x.submitted_at'),
        claimedPaise: 'x.claimed_paise', approvedPaise: 'x.approved_paise', paidPaise: 'x.paid_paise' } },

    dsc: { kind: 'sql', order: 'x.valid_to, x.id', from: 'dsc x LEFT JOIN client c ON c.id = x.client_id',
      where: (c) => ['x.deleted_at IS NULL', dscScopeSql(c.a, c.p)],
      cols: { id: 'x.id', holderName: 'x.holder_name', holderKind: 'x.holder_kind', clientId: 'c.id', clientName: 'c.name', dscClass: 'x.dsc_class', issuer: 'x.issuer', validTo: 'x.valid_to',
        daysToExpiry: (c) => `x.valid_to - ${c.todaySql()}::date`, custody: 'x.custody' } },

    licences: { kind: 'sql', order: 'COALESCE(l.renewal_due, l.valid_to) NULLS LAST, l.id', from: 'licence l JOIN client c ON c.id = l.client_id',
      where: (c) => ['l.deleted_at IS NULL', 'c.deleted_at IS NULL', visibleSql(c.a, 'compliance', c.p)],
      cols: { id: 'l.id', clientId: 'c.id', clientName: 'c.name', licenceType: 'l.licence_type', number: 'l.number', authority: 'l.authority', validTo: 'l.valid_to', renewalDue: 'l.renewal_due',
        daysToRenewal: (c) => `COALESCE(l.renewal_due, l.valid_to) - ${c.todaySql()}::date`, status: 'l.status' } },

    automation_runs: { kind: 'sql', order: 'x.started_at, x.id', from: 'automation_run x JOIN automation_rule r ON r.id = x.rule_id',
      where: (c) => ['x.deleted_at IS NULL', ruleVisibleSql(c.a, c.p, 'r')],
      cols: { id: 'x.id', ruleId: 'r.id', ruleName: 'r.name', status: 'x.status', step: 'x.step', startedAt: 'x.started_at', startedMonth: ist('x.started_at'), actionsTotal: 'x.actions_total',
        actionsDone: 'x.actions_done', costPaise: 'x.cost_paise' } },

    // Firm-wide AI spend for firm-wide settings/AI viewers; everyone else sees their own calls.
    ai_usage: { kind: 'sql', order: 'x.occurred_at, x.id', from: 'ai_usage x LEFT JOIN app_user u ON u.id = x.user_id',
      where: (c) => ['x.deleted_at IS NULL', firmWide(c.a, ['settings', 'view'], ['ai', 'view']) ? 'TRUE' : `x.user_id = ${c.p.add(c.a.userId)}::uuid`],
      cols: { feature: 'x.feature', userId: 'x.user_id', userName: 'u.name', provider: 'x.provider', model: 'x.model', month: 'x.month', inputTokens: 'x.input_tokens', outputTokens: 'x.output_tokens', costPaise: 'x.cost_paise' } },

    // ---------- Service datasets: the operational report IS the data source (reconciles by construction) ----------
    ageing: { kind: 'service', load: async (c) => {
      const r = await d.billingReports.ageing(c.a, String(c.params.asOf));
      return r.clients.flatMap((x) => AGEING_BUCKETS.filter((b) => x.buckets[b] !== 0).map((b) => ({ clientId: x.clientId, clientName: x.clientName, bucket: b, balancePaise: x.buckets[b] })));
    } },
    unbilled: { kind: 'service', load: async (c) => {
      const items = await d.billingAuto.unbilledTx(c.tx, c.a, {});
      const extra = new Map((await c.tx.query(`SELECT t.id, t.assignee_id, u.name AS assignee_name, s.name AS service_name, s.category FROM task t LEFT JOIN app_user u ON u.id = t.assignee_id
        LEFT JOIN service_type s ON s.id = t.service_type_id WHERE t.id = ANY($1::uuid[])`, [items.map((x) => x.taskId)])).rows.map((r) => [r.id as string, r]));
      return items.map((x) => { const e = extra.get(x.taskId); return { id: x.taskId, title: x.title, clientId: x.clientId, clientName: x.clientName, periodKey: x.periodKey, serviceKey: x.serviceKey,
        serviceName: e?.service_name ?? null, serviceCategory: e?.category ?? null, completedOn: x.completedOn, assigneeId: e?.assignee_id ?? null, assigneeName: e?.assignee_name ?? null,
        retainer: x.retainer, suggestedPaise: x.suggestedPaise }; });
    } },
    job_pnl: { kind: 'service', load: async (c) => {
      const r = await d.timeReports.jobPnl(c.a, { from: String(c.params.from), to: String(c.params.to), groupBy: c.params.groupBy as 'task' | 'client' | 'service' });
      return r.items.map((x) => ({ key: x.key, label: x.label, clientId: x.clientId, clientName: x.clientName, taskId: x.taskId, revenuePaise: x.revenuePaise, costPaise: x.costPaise,
        marginPaise: x.marginPaise, marginPct: x.marginPct, wipPaise: x.wipPaise, minutes: x.minutes, billableMinutes: x.billableMinutes, loss: x.loss }));
    } },
    capacity: { kind: 'service', load: async (c) => {
      const r = await d.timeReports.capacity(c.a, { weeks: Number(c.params.weeks), from: String(c.params.from) });
      return r.users.flatMap((u) => u.weeks.map((w) => ({ userId: u.userId, userName: u.name, weekStart: w.weekStart, capacityMinutes: w.capacityMinutes, plannedMinutes: w.plannedMinutes,
        actualMinutes: w.actualMinutes, plannedPct: w.plannedPct, actualPct: w.actualPct })));
    } },
    compliance: { kind: 'service', load: async (c) => {
      const r = await d.compliance.matrix(c.a, { from: String(c.params.from), to: String(c.params.to), asOf: String(c.params.asOf) });
      const names = new Map(r.clients.map((x) => [x.id as string, x.name as string])); const forms = new Map(r.rules.map((x) => [x.id, x.form]));
      return r.cells.map((x) => ({ clientId: x.clientId, clientName: names.get(x.clientId) ?? null, ruleId: x.ruleId, form: forms.get(x.ruleId) ?? x.ruleId, periodKey: x.periodKey,
        periodLabel: x.periodLabel, statutoryDue: x.statutoryDue, actBy: x.actBy, state: x.state, taskId: x.taskId }));
    } },
    attendance: { kind: 'service', load: async (c) => {
      const r = await d.attendance.report(c.a, String(c.params.month));
      return r.users.map((u) => ({ userId: u.userId, userName: u.name, workingDays: u.workingDays, presentDays: u.presentDays, leaveDays: u.leaveDays, absentDays: u.absentDays,
        flaggedDays: u.flaggedDays, minutes: u.minutes }));
    } },
  };
}

/** Output normalisation by column type (node-pg returns int8/numeric as strings, dates as Date). */
export function normalise(v: unknown, t: ColumnType): unknown {
  if (v === null || v === undefined) return null;
  switch (t) {
    case 'int': case 'paise': case 'minutes': case 'number': return Number(v);
    case 'bool': return Boolean(v);
    case 'datetime': return v instanceof Date ? v.toISOString() : String(v);
    case 'date': return v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : String(v).slice(0, 10);
    default: return String(v);
  }
}
